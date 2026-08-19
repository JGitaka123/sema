# @sema/engine

The conversation engine. Every model call in Sema happens here — nothing else
in the repo imports the Anthropic SDK (`docs/CONVERSATION_ENGINE.md`).

The whole pipeline lives here.

```
inbound message
  → LEXICON      deterministic EN/SW/Sheng emergency + distress regex   Phase 4
  → CLASSIFIER   Haiku-class, structured output, 1.5s deadline          Phase 4
  → ROUTER       emergency / distress / abusive / spam / out_of_scope   Phase 4
  → AGENT        Sonnet-class tool-use loop, 12 tools, budgets + loop   Phase 5
                   detection
  → POST-CHECK   advice / grounding / PII / language / format, then     Phase 5
                   one rewrite, then escalate
  → outbox + audit
```

The agent's four hard limits are enforced in code, not asked for in the prompt
(`src/agent.ts`): **6 tool calls** per inbound message, **8 agent turns** per
conversation-day, **loop detection** on a repeated tool + args, and **one model
retry** before the reviewed fallback line. `runAgent` never throws for a model
or tool problem — every path ends in something the patient can be sent.

## The one thing to know

`classify()` runs the deterministic lexicon **before** the model and returns
immediately on a hit. A model outage, a slow network, a bad sample or a prompt
injection in the patient's own message cannot turn an emergency into a booking
request, because on that path the model is never called at all
(CLAUDE.md hard rule 1, SAFETY.md §8).

Everything the model _can_ get wrong lands on one fail-safe path that never
produces "normal with high confidence" — see `failSafe` in `classifier.ts`.

## Using it

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
for (const reply of decision.replies) enqueueOutbound(reply);  // never send directly

if (decision.runAgent) {
  const context = await loadAgentContext({ withTenantDb }, ids);
  const run = await runAgent(
    { ...ids, message: body, context, patientLanguage: classification.output.language },
    { client, withTenantDb, scheduler, clock, depositRequester },
  );
  for (const reply of run.replies) enqueueOutbound(reply, { prompt_version: run.promptVersion });
  if (run.escalation) await recordEscalation(...);
}
```

The real wiring is `apps/worker/src/jobs/engine.ts`.

Three invariants the caller cannot opt out of: `classify` runs on **every**
inbound message before any other model call; the agent runs **only** when
`decision.runAgent` is true; and every reply `runAgent` returns has already been
through `checkReply` — it never returns unchecked text.

## Layout

| Path                            | What it is                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `src/models.ts`                 | The only place a model id may appear. A test enforces it.                     |
| `src/client.ts`                 | The only module importing the Anthropic SDK.                                  |
| `src/safety/lexicon.ts`         | Matching machinery: normalisation, typo tolerance.                            |
| `src/safety/lexicon.{en,sw}.ts` | The term catalogues. **Adding a term requires an eval case.**                 |
| `src/classifier.ts`             | Lexicon → cache → model, with the fail-safe path.                             |
| `src/router.ts`                 | Pure decision table. No I/O, fully unit-tested.                               |
| `src/context.ts`                | What the agent gets to know, and the eight-part prompt render.                |
| `src/agent.ts`                  | The tool-use loop: budgets, loop detection, retry, rewrite.                   |
| `src/tools/`                    | The 12 tools. Zod-validated, tenant-scoped, audited, policy in code.          |
| `src/guardrails.ts`             | The post-check. Code, not prompt text (SAFETY.md §8).                        |
| `src/summaries.ts`              | `conversation.agent_summary` on handback and nightly.                         |
| `src/testing.ts`                | Fakes: model, scheduler, tenant db, context. No key needed.                   |
| `src/replies.ts`                | Scripted replies from `@sema/shared` i18n. The model never paraphrases these. |
| `src/escalation.ts`             | `escalation` + `audit_log` writes through `withTenant`.                       |
| `src/notifier.ts`               | Alerting seam. Phase 5/8 implement it; this package ships a no-op.            |
| `src/prompts/`                  | Versioned prompt files. Never edit a version in place.                        |
| `evals/`                        | The safety gate.                                                              |

## Tests

```
pnpm test                                    # unit + the key-free corpora
pnpm test:evals                              # classifier suites (needs a key)
SEMA_EVAL_AGENT=1 pnpm test:evals            # + the agent suites
SEMA_EVAL_AGENT=1 SEMA_EVAL_SAMPLE=20 \      # cap each agent suite
  pnpm test:evals
```

| Suite                  | Cases | Gates a deploy?                |
| ---------------------- | ----- | ------------------------------ |
| `emergency.jsonl`      | 241   | yes — recall must be 100%      |
| `advice_refusal.jsonl` | 176   | yes — 0 may reach the agent    |
| `grounding.jsonl`      | 114   | yes — 0 invented facts         |
| `booking_flows.jsonl`  | 70    | reported                       |
| `language.jsonl`       | 58    | reported                       |

The agent suites drive the **real model** against a **synthetic clinic**
(`evals/harness.ts`): the `testContext()` fixture plus an in-memory scheduler.
No Postgres, no seed — an eval that a migration can move under it is not
reproducible enough to gate a deploy on.

`pnpm test:evals` **skips cleanly with exit 0** when `ANTHROPIC_API_KEY` is
unset, because CI has no key yet and a red build meaning "no credentials"
trains people to ignore a red build meaning "we broke emergency detection".

The deterministic layers are therefore measured on every `pnpm test`, with no
key: the lexicon corpus (`src/safety/lexicon.test.ts`), the guardrails
(`src/guardrails.test.ts`), the tools (`src/tools/tools.test.ts`) and the whole
agent loop against a fake model (`src/agent.test.ts`). That is what gives CI a
real signal today.

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
- **Changing the agent prompt** → new `prompts/agent.vN.md`, bump
  `AGENT_PROMPT_VERSION`, re-run with `SEMA_EVAL_AGENT=1`. Never edit a version
  in place: every `message.meta.prompt_version` already written claims to have
  come from the file as it stands.
- **Adding a tool** → it must appear in CONVERSATION_ENGINE.md §3.2 first —
  `tools.test.ts` asserts the registry matches the doc name for name.
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

2. **`request_deposit` records intent and moves no money.** Phase 6 owns
   Daraja (BUILD_PLAN.md), so the tool is implemented against a
   `DepositRequester` interface whose Phase 5 implementation writes a
   `payment_request` row in state `initiated` and stops. The seam is marked in
   `src/tools/deposit.ts`; the tool, its audit trail and its schema do not
   change when the real adapter lands. ADR-003 holds either way — funds settle
   into the clinic's own Paybill and Sema never custodies them.

3. **A safety route overrides an abuse mute.** SAFETY.md §7 mutes the agent
   for 24h after three abusive messages. That mute silences the agent, not the
   alarm: someone who swore at the desk can still have a heart attack an hour
   later, so `emergency` and `distress` still reply and still escalate while
   muted.
