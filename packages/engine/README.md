# @sema/engine

The conversation engine. Every model call in Sema happens here — nothing else
in the repo imports the Anthropic SDK (`docs/CONVERSATION_ENGINE.md`).

**Phase 4 ships the first half of the pipeline.** The agent, its tools and the
guardrail post-check are Phase 5 and are deliberately absent.

```
inbound message
  → LEXICON      deterministic EN/SW/Sheng emergency + distress regex   ✅ Phase 4
  → CLASSIFIER   Haiku-class, structured output, 1.5s deadline          ✅ Phase 4
  → ROUTER       emergency / distress / abusive / spam / out_of_scope   ✅ Phase 4
  → AGENT        tool-use loop                                          ⏳ Phase 5
  → POST-CHECK   guardrails                                             ⏳ Phase 5
  → outbox + audit
```

## The one thing to know

`classify()` runs the deterministic lexicon **before** the model and returns
immediately on a hit. A model outage, a slow network, a bad sample or a prompt
injection in the patient's own message cannot turn an emergency into a booking
request, because on that path the model is never called at all
(CLAUDE.md hard rule 1, SAFETY.md §8).

Everything the model _can_ get wrong lands on one fail-safe path that never
produces "normal with high confidence" — see `failSafe` in `classifier.ts`.

## Using it (Phase 5's wiring, not this package's)

```ts
import {
  classify, route, recordEscalation, recordRouteAudit,
  createAnthropicClient, createClassifierCache,
} from "@sema/engine";

const client = createAnthropicClient();
const cache = createClassifierCache();

const classification = await classify(
  { message: body, recent, clinicSpecialty, clinicId },   // no patient names
  { client, cache },
);

const decision = route({ classification, clinic, conversation, now: new Date() });

await recordRouteAudit({ clinicId, conversationId, entry: decision.audit }, deps);
if (decision.escalation) {
  await recordEscalation(
    { clinicId, conversationId, request: decision.escalation, classification },
    { ...deps, notifier },
  );
}
for (const reply of decision.replies) enqueueOutbox(reply);  // never send directly
if (decision.runAgent) await runAgent(...);                  // Phase 5
```

Two invariants the caller cannot opt out of: `classify` runs on **every**
inbound message before any other model call, and the agent runs **only** when
`decision.runAgent` is true.

## Layout

| Path                            | What it is                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `src/models.ts`                 | The only place a model id may appear. A test enforces it.                     |
| `src/client.ts`                 | The only module importing the Anthropic SDK.                                  |
| `src/safety/lexicon.ts`         | Matching machinery: normalisation, typo tolerance.                            |
| `src/safety/lexicon.{en,sw}.ts` | The term catalogues. **Adding a term requires an eval case.**                 |
| `src/classifier.ts`             | Lexicon → cache → model, with the fail-safe path.                             |
| `src/router.ts`                 | Pure decision table. No I/O, fully unit-tested.                               |
| `src/replies.ts`                | Scripted replies from `@sema/shared` i18n. The model never paraphrases these. |
| `src/escalation.ts`             | `escalation` + `audit_log` writes through `withTenant`.                       |
| `src/notifier.ts`               | Alerting seam. Phase 5/8 implement it; this package ships a no-op.            |
| `src/prompts/`                  | Versioned prompt files. Never edit a version in place.                        |
| `evals/`                        | The safety gate.                                                              |

## Tests

```
pnpm test                 # unit + the key-free lexicon corpus test
pnpm test:evals           # model-backed safety suites (needs ANTHROPIC_API_KEY)
```

`pnpm test:evals` **skips cleanly with exit 0** when `ANTHROPIC_API_KEY` is
unset, because CI has no key yet and a red build meaning "no credentials"
trains people to ignore a red build meaning "we broke emergency detection".

The deterministic half is therefore measured on every `pnpm test`:
`src/safety/lexicon.test.ts` runs all 241 corpus cases through the regex
lexicon alone. Current measurements, printed by the test:

| Metric (lexicon only, no model) | Value           | Floor |
| ------------------------------- | --------------- | ----- |
| Emergency recall                | 90.6% (126/139) | 88%   |
| Distress recall                 | 87.5% (28/32)   | 85%   |
| Precision on near-miss traffic  | 96.9%           | 60%   |

The lexicon floors are below 100% on purpose. Every case it misses is tagged
`paraphrase` — "he has not opened his eyes since the fall this morning" — and
the only regex broad enough to catch those also fires on half the booking
requests. That trade is what the model layer exists for, and
`pnpm test:evals` gates _combined_ emergency recall at 1.0.

## Changing safety behaviour

- **Adding a lexicon term** → add the phrase, add an eval case, re-run `pnpm test`.
- **Changing the classifier prompt** → new `prompts/classifier.vN.md`, bump
  `PROMPT_VERSION`, re-run `pnpm test:evals` (CONVERSATION_ENGINE.md §10).
- **Changing a model id** → `src/models.ts` only, then re-run the evals: the
  suites are measured against a specific model (SAFETY.md §9).
- **Any confirmed unsafe output** → incident file, eval case, fix, re-run
  (SAFETY.md §10).

## Deliberate readings of the docs

Two places where the docs are in tension and this package picks a side:

1. **Suicidal ideation is `distress`, not `emergency`.**
   CONVERSATION_ENGINE.md §2 lists "suicidal" in the emergency lexicon;
   SAFETY.md §4 requires ideation to get the warm Red Cross / Befrienders
   script. Sending "go to the nearest emergency department" to someone
   expressing hopelessness is the wrong clinical response, so lexicon terms
   carry a severity: ideation → `distress`, self-harm _already acted on_
   (overdose taken, cutting done) → `emergency`. Both stop the agent and
   escalate, so no at-risk message reaches the booking agent either way.

2. **A safety route overrides an abuse mute.** SAFETY.md §7 mutes the agent
   for 24h after three abusive messages. That mute silences the agent, not the
   alarm: someone who swore at the desk can still have a heart attack an hour
   later, so `emergency` and `distress` still reply and still escalate while
   muted.
