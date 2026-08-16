# Sema — Product Specification (v1.1)

> **Source of truth for what to build.** Anything not here is out of scope until added. Behaviour-changing PRs update this doc. `SAFETY.md` and `COMPLIANCE.md` are binding at the same level as this file.

---

## 1. Overview

**One-liner:** An AI front-desk for clinics that talks to patients on WhatsApp — answering questions, booking and managing appointments, sending reminders, collecting deposits via M-Pesa — with clinic staff supervising from a shared inbox and taking over whenever they want.

**Launch market:** Kenya, Nairobi first. **Founding clinic:** Afyanex (live design partner and proof site).

**Design for scale:** multi-tenant, multi-region (currency, timezone, language per clinic), channel and payment abstraction from day one. East Africa next (TZ, UG: same WhatsApp habits, mobile money via M-Pesa TZ / MTN MoMo through the `PaymentProvider` interface). Western markets later.

**The wedge and the long game:** The front-desk is the entry — measurable pain (missed calls, after-hours silence, no-shows) for a buyer already paying a receptionist. The expansion is claims / revenue-cycle automation (SHA and private insurers). v1 builds only the front-desk; the data model leaves the door open (`patient`, `encounter`, `payer`, `visit_reason` shapes).

**Why this wins:** ROI is countable within 30 days (no-show rate, missed-message rate, deposits collected). Domain depth (intake questions per specialty, deposits, recurring visits, provider rules, emergency handling) is a moat generic WhatsApp bots and horizontal schedulers do not cross. Founder is a practising clinician with a live clinic and peer credibility with other clinic owners.

---

## 2. Users and buyers

### 2.1 The clinic (tenant, buyer)
- Private single- or few-location clinics: GP, dental, physio, optical, derm/aesthetic, paediatrics, OB/GYN, small specialist practices, diagnostic centres.
- 1–10 providers, 100–2,000 patient interactions per month.
- Decision-maker: owner-clinician or practice manager. No procurement committee.
- Already pays 1–3 front-desk staff (KES 25–45k/month each) and still misses calls and after-hours messages.

### 2.2 Personas
- **Dr. Wanjiru, owner (buyer).** Wants fewer no-shows, deposits collected, staff freed from the phone, and zero risk of the bot embarrassing the clinic. Judges by weekly numbers.
- **Faith, front-desk (primary daily user).** Lives in the inbox. Needs: see who is waiting, take over fast, edit bookings, mark arrivals, send a payment request in two taps. Hates typing on a laptop; the inbox must work on a phone browser.
- **Dr. Otieno, provider.** Reads his day view; wants correct patient names, visit reasons, and no double bookings. May not log in at all; gets a morning WhatsApp digest.
- **Patient (WhatsApp).** Wants to know: are you open, how much, can I come at 4, and to be reminded. Writes in English, Swahili, Sheng, mixed. Sends voice notes. Sometimes writes at 11pm.

---

## 3. Money flows (two, kept separate)

**Flow A — Sema revenue.** Clinic pays Sema a monthly subscription (M-Pesa Paybill to Sema, or card via Paystack/Flutterwave). Tiers in §10.

**Flow B — Patient → clinic deposits.** Sema triggers an STK Push from the clinic's own Paybill/Till (clinic's Daraja credentials, stored encrypted per tenant). Money lands in the clinic's account. Sema records the receipt against the appointment. **Sema never holds, moves, or refunds patient money.** Refunds are performed by the clinic in their M-Pesa portal; staff mark the appointment `deposit_refunded` manually in the inbox.

---

## 4. Core user flows

### 4.1 Patient books an appointment
1. Patient messages the clinic's WhatsApp number.
2. Safety classifier runs (`SAFETY.md`). If not emergency and not out-of-bounds, agent proceeds.
3. Agent greets in the patient's language, identifies the visit reason from the clinic's `service` catalogue, asks the minimum intake questions configured for that service (e.g. dental: "new or returning?", "is it painful right now?"), proposes 2–3 concrete slots based on provider availability and rules.
4. Patient picks a slot. Agent places a 10-minute `hold`, requests the deposit if the service requires one (§4.3), and confirms the appointment on payment (or immediately if no deposit).
5. Confirmation message with date/time, provider, location pin, what to bring, cancellation policy.
6. `audit_log` entry; appointment visible in inbox and calendar; reminders scheduled.

### 4.2 Reschedule / cancel
- Patient asks; agent finds the appointment by phone number, offers alternatives, applies the clinic's policy (e.g. free reschedule > 24h, deposit forfeited < 2h, configurable). Cancellation frees the slot and triggers a waitlist offer if enabled.

### 4.3 Deposit collection
- Service has `deposit_minor` (0 = none). Agent sends "To confirm, we'll send an M-Pesa prompt for KES 500 to this number", asks yes/no, triggers STK Push. On callback success: appointment `confirmed`, receipt number stored, thank-you sent. On failure/timeout: one retry offer, then hold expires and slot released. Staff can trigger or waive a deposit from the inbox.

### 4.4 Reminders and follow-ups
- Default: 24h and 2h before (WhatsApp templates, patient can reply to confirm/reschedule). Configurable per clinic and per service.
- No-show detection: 30 min after slot start with no `arrived`, mark `no_show`, send a gentle rebook message.
- Post-visit: optional "thank you / how was it" message and review link; optional recall (e.g. dental 6-monthly) in Phase 2.

### 4.5 FAQ and information
- Agent answers from the clinic's `knowledge` (hours, location, services, prices, insurance accepted, parking, doctors, prep instructions) only. Anything not in the knowledge base → "I'll check with the team" + escalation. Never invents prices or availability.

### 4.6 Human takeover
- Any staff member can click **Take over** in the inbox. Agent stops replying instantly (`conversation.mode = human`). Staff replies go out under the same number. **Hand back** returns control; agent gets a summary of what happened. Auto-handback after 12h of staff silence with a nudge, configurable.
- Agent self-escalates: emergency, distress, complaint, payment dispute, low confidence, patient asks for a human, three failed intent turns.

### 4.7 Emergency protocol
- Classifier flags `emergency` → immediate scripted reply (`SAFETY.md` §3), conversation pinned to top of inbox with alarm, push notification to on-call staff, WhatsApp alert to the clinic's emergency contact number. Agent takes no further conversational action.

### 4.8 Staff inbox (daily driver)
- Views: **Needs attention** (escalated, waiting for human, payment failures), **Active**, **All**. Per conversation: transcript, patient card (name, phone, appointments, deposits, notes, flags), agent reasoning summary, quick actions (book, reschedule, request deposit, waive, mark arrived, add note, block).
- Calendar: day/week per provider, drag to reschedule, create walk-in booking, block time.
- Settings: hours, holidays, providers, services (duration, deposit, intake questions, buffer), policies, knowledge base, templates, staff, WhatsApp connection, M-Pesa connection, notifications.
- Reports: bookings, no-show rate, deposits collected, agent vs human handled, response time, after-hours volume, top intents. Weekly WhatsApp/email digest to owner.

### 4.9 Onboarding (target: live in < 60 minutes)
1. Sign up, create clinic, set timezone/currency.
2. Connect WhatsApp via Meta Embedded Signup (or use a Sema-provisioned number for trial).
3. Add providers, hours, services (importable from templates per specialty).
4. Paste/upload knowledge (or answer a guided 15-question form).
5. Connect M-Pesa (Paybill/Till + Daraja app credentials) or skip deposits.
6. Sandbox: staff chats with the agent on a test number, edits knowledge, goes live.

---

## 5. Feature scope

### 5.1 MVP (Phase 1, must ship for Afyanex)
- WhatsApp inbound/outbound, text + voice notes (transcribed) + images (acknowledged, stored, shown to staff; not interpreted clinically).
- Safety classifier, emergency protocol, escalation.
- Conversation agent: FAQ from knowledge, booking, reschedule, cancel, deposit request, language matching (EN/SW/Sheng).
- Internal scheduler: providers, hours, services, holds, buffers, rules.
- M-Pesa STK Push deposits, non-custodial.
- Reminders 24h/2h, no-show marking, rebook nudge.
- Staff inbox with takeover/handback, patient card, calendar, settings, knowledge editor, onboarding.
- Audit log, basic reports, weekly digest.
- Kenya DPA compliance baseline (`COMPLIANCE.md`).

### 5.2 Phase 2 (after 5 paying clinics)
- Waitlist and auto-fill of cancellations.
- Recalls / recurring visits, care-plan follow-ups (non-clinical text only).
- Google Calendar sync; iCal feed per provider.
- Multi-location clinics; per-branch numbers.
- Review collection (Google Business link), NPS.
- Broadcast campaigns with WhatsApp Marketing templates and opt-in management.
- Card payments via Paystack for diaspora patients.
- Swahili-first agent variant for coastal/rural clinics.

### 5.3 Phase 3 (claims/RCM, joins ClaimFlow)
- Insurance / SHA eligibility check at booking, pre-authorisation reminders, encounter capture, claim status messages to patients. Built as a separate package/product sharing `patient`, `encounter`, `payer`.

### 5.4 Non-goals (v1)
See `CLAUDE.md` "Out of scope".

---

## 6. Conversation engine (summary; full detail in `CONVERSATION_ENGINE.md`)

Pipeline per inbound message: normalise → dedup → load conversation state → **classifier** (emergency / distress / out_of_scope / abusive / normal + language + intent) → route (scripted, escalate, or agent) → agent with tools (`get_clinic_info`, `search_slots`, `hold_slot`, `book`, `reschedule`, `cancel`, `request_deposit`, `lookup_appointments`, `escalate`, `add_note`) → guardrail post-check → outbox → audit.

Model choices: small fast model for classifier (< 400ms p95), main model with tool use for agent (target < 6s end-to-end p95). Prompts versioned. Zero data retention.

---

## 7. Safety (binding, see `SAFETY.md`)
The agent is a receptionist, not a clinician. It never diagnoses, advises treatment, interprets symptoms or images, or gives dosages. Emergency detection is tuned to over-escalate. A human is always reachable. Guardrails are code and evals, not just prompt text.

## 8. Compliance (binding, see `COMPLIANCE.md`)
Kenya Data Protection Act 2019: data controller = clinic, processor = Sema; DPA registration; DPIA on file; consent notice at first contact; retention and deletion; ODPC breach notification 72h. WhatsApp Business Platform policies: opt-in for templates, 24h session rule, healthcare category rules, no prohibited content. Meta Tech Provider terms.

---

## 9. Data model (summary; full DDL in `DATA_MODEL.md`)
`clinic`, `location`, `staff_user`, `provider`, `service`, `service_intake_question`, `availability_rule`, `time_off`, `patient`, `patient_consent`, `conversation`, `message`, `attachment`, `appointment`, `slot_hold`, `payment_request`, `payment`, `reminder`, `knowledge_item`, `template`, `escalation`, `note`, `audit_log`, `webhook_dedup`, `outbox`, `subscription`, `usage_meter`, `encounter` (stub), `payer` (stub). All tenant tables carry `clinic_id` + RLS.

---

## 10. Pricing (KES, per clinic per month; anchored to receptionist cost KES 25–45k)

| Tier | Price | Includes |
|---|---|---|
| Starter | 6,500 | 1 number, 2 providers, 500 conversations, deposits, reminders, inbox |
| Clinic | 14,500 | 5 providers, 2,000 conversations, waitlist, reports, 3 staff seats |
| Group | 35,000+ | Multi-location, unlimited providers, API, priority support |

Overage: KES 8 per conversation beyond quota. WhatsApp/Meta conversation fees passed through at cost (shown transparently). 14-day free trial on a Sema-provisioned number. Annual: 2 months free.

Unit economics target: gross margin > 75% after model + Meta costs; model cost per conversation < KES 3 (classifier + 3–5 agent turns).

---

## 11. Success metrics
- **North star:** appointments confirmed via Sema per clinic per week.
- Clinic-facing (dashboard): no-show rate, deposit collection rate, after-hours conversations handled, median first-response time, % handled without human.
- Product: agent containment rate > 70% (non-escalated conversations resolved), escalation precision (staff agrees escalation was warranted) > 80%, false-negative emergency rate = 0 on eval set, hallucinated price/availability = 0 on eval set.
- Business: trial→paid > 40%, logo churn < 3%/month, payback < 3 months.

## 12. Analytics instrumentation
Event names in `shared/analytics/events.ts`. Events carry `clinic_id`, `conversation_id`, timestamps, enums. **Never** patient name, phone, message text, or free text. PostHog self-hosted or EU cloud.

## 13. Roadmap
- Weeks 1–6: MVP on Afyanex (`BUILD_PLAN.md`).
- Weeks 7–10: 5 design-partner clinics from the founder's network, pricing test.
- Weeks 11–16: Phase 2 features, self-serve onboarding, first ads.
- Q2: 30 clinics; start Phase 3 claims discovery with ClaimFlow.

## 14. Open questions (tracked, not blocking)
- Sema-provisioned trial numbers: buy Kenyan virtual numbers via provider or use one shared trial number with clinic-prefix? (Default: shared trial number, patient-side, until Embedded Signup completes.)
- Voice-note transcription vendor: Whisper via API vs Deepgram (Swahili quality). Test in Week 2.
- Neon vs Supabase for managed Postgres (latency from Nairobi). Benchmark in Week 1.
