# Sema — Conversation Engine

Package: `packages/engine`. All model calls live here. Nothing else in the repo imports the Anthropic SDK.

## 1. Pipeline

```
inbound message
  → normalise (trim, strip emoji-only, detect language hint, transcribe audio)
  → context load (clinic profile, policies, knowledge, patient card, last 20 msgs, open appointments, holds, now in clinic tz)
  → CLASSIFIER (fast model, structured output)  → {category, language, intent, urgency, confidence}
  → ROUTER
       emergency      → scripted emergency reply + escalate(emergency) + STOP
       distress       → empathetic scripted reply + escalate(distress) + STOP
       abusive/spam   → scripted or silence + flag; STOP
       out_of_scope   → scripted redirect (no advice) + offer booking/human; STOP unless intent also bookable
       normal         → AGENT
  → AGENT (main model, tool use loop, max 6 tools/turn, max 8 agent turns/conversation-day before forced escalate)
  → POST-CHECK (guardrails)  → pass | rewrite once | escalate with safe fallback
  → outbox + audit + analytics
```

## 2. Classifier

- Model: fast/cheap. Input: last 3 messages + current, clinic specialty. Output JSON via structured output:
  ```json
  {"category":"normal|emergency|distress|out_of_scope|abusive|spam",
   "language":"en|sw|sheng|mixed|other",
   "intent":"book|reschedule|cancel|hours|location|price|insurance|provider_info|prep|payment|complaint|human|greeting|thanks|other",
   "urgency":"none|low|high",
   "confidence":0.0}
  ```
- Emergency lexicon (EN/SW/Sheng) is also matched by regex **before** the model as a belt-and-braces (chest pain, can't breathe, bleeding heavily, unconscious, seizure, overdose, suicidal, "sina pumzi", "anavuja damu", "amezimia", labour/"uchungu" with bleeding, child fever with fits, etc.). Regex hit → emergency regardless of model.
- Tuning: recall on emergency eval set must be 100%; precision ≥ 60% is acceptable (over-escalation is fine).
- Timeout 1.5s → treat as `normal` with `low confidence` → agent runs with a conservative system prompt addendum; if the message contains any symptom words, route `out_of_scope` instead.

## 3. Agent

### 3.1 System prompt structure (`prompts/agent.v1.md`)
1. Identity: "You are the front-desk assistant of {clinic.name}. You are not a clinician."
2. Hard limits (mirrors SAFETY.md, phrased as rules).
3. Clinic facts block (rendered from `knowledge_item`, hours, locations, providers, services with prices, policies). Explicit: "If a fact is not in this block, you do not know it. Say you'll check with the team and use `escalate` with kind `low_confidence`."
4. Patient card (name if known, language, upcoming appointments, no-show count, flags).
5. Behaviour: match patient language and register; short messages; one question at a time; offer 2–3 slots max; always confirm details before booking; use interactive buttons where the channel supports them.
6. Tools and when to use them.
7. Current datetime in clinic tz, and "today is {weekday}".
8. Output rules: plain text, no markdown, ≤ 600 chars unless listing slots.

### 3.2 Tools (Zod-validated, audited, tenant-scoped)
| Tool | Purpose | Notes |
|---|---|---|
| `get_clinic_info(topic)` | fetch knowledge by category | read-only |
| `list_services(query?)` | services + prices + deposit | read-only |
| `search_slots(service_id, provider_id?, from, to, limit=3)` | availability | read-only |
| `hold_slot(provider_id, service_id, start)` | 10-min hold | writes hold |
| `book_appointment(hold_id, intake_answers, visit_reason)` | creates appointment | if deposit required → status `pending_deposit` and auto-calls `request_deposit` |
| `lookup_appointments()` | patient's upcoming | read-only |
| `reschedule_appointment(appointment_id, new_hold_id)` | policy enforced in code | |
| `cancel_appointment(appointment_id, reason)` | policy enforced in code | |
| `request_deposit(appointment_id)` | triggers STK Push | idempotent per appointment |
| `escalate(kind, reason)` | hands to human | agent must send a holding message |
| `add_note(body)` | internal note | |
| `send_location()` | clinic pin | |

Tools return structured results; the agent never fabricates a tool result. Policy (cancellation windows, deposits) is enforced inside tools, not trusted to the model.

### 3.3 Turn budget and loops
- Max 6 tool calls per inbound message. Loop detection: same tool + same args twice → break, escalate `agent_error`.
- Model errors → retry once, then safe fallback: "Sorry, I'm having trouble right now — a team member will reply shortly." + escalate.

## 4. Post-check guardrails (`guardrails.ts`)
Run on every agent reply:
1. **Clinical advice detector**: regex list + fast-model yes/no "does this text give medical advice, diagnosis, dosage, or interpret symptoms?" → fail.
2. **Fact grounding**: any KES amount, time range, doctor name, or address in the reply must appear in the knowledge/tool results for the turn (string/number match) → else fail.
3. **PII leak**: reply must not contain another patient's name/phone (check against tool result scope) → fail.
4. **Language**: detected reply language must match patient's unless patient wrote in mixed → soft warn.
5. **Length/format**: strip markdown, cap length.
Fail → one rewrite attempt with the violation named; second fail → generic safe reply + `escalate(agent_error)`.

## 5. Language
- Reply in the patient's language; Sheng handled by allowing casual Swahili-English mix. Scripted messages (emergency, out-of-scope, payment prompts, reminders) exist in `shared/i18n/en.json` and `sw.json`; Sheng uses the `sw` casual variant.

## 6. Voice notes
- Download, transcribe (vendor via `Transcriber` interface; test Whisper vs Deepgram on Swahili). Store transcript in `message.transcript`. Classifier and agent operate on transcript. If transcription confidence low → "Sorry, I couldn't hear that clearly — could you type it?".

## 7. Images / documents
- Never interpreted clinically. Agent acknowledges receipt, stores, and if the message context suggests it's a wound/rash/report → out_of_scope route + offer booking + escalate so staff can look. Insurance card photos → stored, staff can view, agent says "thanks, our team will confirm your cover".

## 8. Memory and summaries
- Conversation summary regenerated after human handback and nightly for open conversations; stored in `conversation.agent_summary`; included in context instead of full history beyond 20 messages.

## 9. Evals (`engine/evals/`)
- `emergency.jsonl` (≥ 200 cases EN/SW/Sheng incl. paraphrases, typos, voice-transcript style) → recall must be 1.0.
- `advice_refusal.jsonl` (≥ 150 attempts to extract advice, incl. roleplay/jailbreak) → 0 advice.
- `grounding.jsonl` (≥ 100 questions where the fact is absent) → 0 invented prices/hours.
- `booking_flows.jsonl` (≥ 60 multi-turn scenarios) → correct tool sequence, correct slot, deposit path.
- `language.jsonl` → reply language matches.
- Run in CI nightly and on any prompt change; blocking on emergency + advice suites.

## 10. Prompt versioning
- `prompts/agent.v1.md`, `classifier.v1.md`. Changing behaviour = new version file + eval run + `PROMPT_VERSION` bump recorded on `message.meta.prompt_version`.

## 11. Replies to reminders (Phase 7 seam)

A reminder asks the patient to reply to confirm or reschedule (SPEC §4.4), and that reply arrives on the ordinary inbound path — a `message` on the patient's existing conversation, classified and routed like any other. **Phase 7 adds no branch to this pipeline and no reminder-specific state to the conversation.** `reminder.status` is a record of what was *sent*; nothing reads it during a turn.

Two things the agent will want to do when it handles one, neither of which Phase 7 implements:

- **Confirming.** Moving the appointment from `booked` to `confirmed` is an ordinary appointment write. The reminder rows need no update: the reconciler treats both statuses as remindable.
- **Rescheduling.** The existing `reschedule_appointment` tool is enough. The old appointment's pending reminders are retired and the new appointment's created by the reconciler (ARCHITECTURE.md §4). The agent never writes to `reminder`, and there is no reminder tool.

The one call the agent may want is `syncAppointmentReminders(client, {clinicId, appointmentId, now})` from `apps/worker/src/reminders/`, inside the same transaction as a booking, so a patient who books and immediately asks "will you remind me?" is not told about a row that does not exist yet. Skipping it is safe — `reminder.sync` reconciles within five minutes.
