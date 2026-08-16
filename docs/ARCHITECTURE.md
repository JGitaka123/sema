# Sema — Architecture

## 1. System diagram

```
Patient WhatsApp ──► Meta Cloud API ──webhook──► apps/api (Fastify)
                                                   │  verify sig, dedup, ack <3s
                                                   ▼
                                              Redis/BullMQ  ◄──── apps/worker
                                                   │              ├─ inbound processor (engine)
                                                   │              ├─ outbox sender (channels)
                                                   │              ├─ reminders / no-show / digests
                                                   │              └─ payment poller / reconciler
                                                   ▼
                                             Postgres (RLS)  ◄──── apps/inbox (Next.js) via api
Safaricom Daraja ──callback──► apps/api ──► queue ──► payments package
Anthropic API ◄────────────── packages/engine (classifier + agent, tool use)
```

## 2. Request lifecycle: inbound WhatsApp message

1. `POST /webhooks/whatsapp` verifies `X-Hub-Signature-256`, parses payload, for each message: insert into `webhook_dedup(wa_message_id)` (ON CONFLICT DO NOTHING). Enqueue `inbound.process` with `{clinic_id, wa_message_id, raw}`. Return 200 immediately.
2. Worker `inbound.process`: resolve clinic by `phone_number_id`; upsert `patient` by E.164; upsert `conversation` (open one per patient per clinic); insert `message(direction=in)`; if voice note → download media, transcribe, store text; if image → download, store in object storage, mark `attachment`.
3. If `conversation.mode = human` → notify inbox via SSE, stop.
4. `engine.classify(message, context)` → `{category, language, intent, confidence}`.
5. Route:
   - `emergency` → `engine.emergencyReply()` (scripted, localized) → outbox; create `escalation(kind=emergency)`; notify.
   - `abusive` → scripted cool-down reply, flag; after 3, mute agent, escalate.
   - `out_of_scope` (clinical advice request) → scripted redirect + offer booking/human.
   - `normal` → `engine.agentTurn(conversation, tools)`.
6. Agent loop (max 6 tool calls per turn): builds context (clinic knowledge, policies, patient card, last 20 messages, current date/time in clinic tz), calls model, executes validated tools, produces reply.
7. `engine.postCheck(reply)`: regex + small-model check for clinical advice, invented prices, PII leaks, wrong language. Fail → rewrite once, else escalate with generic reply.
8. Insert `message(direction=out, status=queued)` and `outbox` row. Insert `audit_log` for each tool effect. Emit analytics events.
9. Outbox worker sends via Channel adapter, updates status from Meta status webhooks (`sent/delivered/read/failed`).

## 3. Multi-tenancy

- Every tenant table: `clinic_id ulid not null references clinic(id)`.
- RLS policy pattern:
  ```sql
  alter table appointment enable row level security;
  create policy tenant_isolation on appointment
    using (clinic_id = current_setting('app.current_clinic', true)::text);
  ```
- App connects with role `sema_app` (no BYPASSRLS). `withTenant(clinicId, fn)` runs `set_config('app.current_clinic', $1, true)` inside a transaction.
- System jobs that span tenants (e.g. reminder scheduler) iterate clinics and call `withTenant` per clinic. Role `sema_system` exists for migrations only.
- A CI test asserts every table with `clinic_id` has RLS enabled and a policy.

## 4. Scheduling engine (`packages/scheduling`)

- Inputs: `availability_rule` (weekly recurring per provider/location), `time_off`, existing `appointment` (status in booked/confirmed/arrived), `slot_hold` (unexpired), `service.duration_min`, `service.buffer_min`, `provider_service` (which providers offer which service), clinic `booking_window_days`, `min_notice_min`, `slot_granularity_min`.
- `searchSlots({clinicId, serviceId, providerId?, from, to, limit})` → returns ranked slots (soonest, then provider preference, then load balance).
- `holdSlot()` inserts `slot_hold` with 10 min TTL using an exclusion constraint on `(provider_id, tstzrange)` to prevent overlaps; `book()` converts hold → appointment atomically. Postgres `btree_gist` extension.
- All computations in clinic timezone, stored UTC.

## 5. Payments (`packages/payments`)

- Interface `PaymentProvider { requestPayment(req) → {providerRef}; parseCallback(raw) → PaymentEvent; queryStatus(ref) }`.
- Daraja adapter: per-clinic `consumer_key/secret`, `shortcode`, `passkey`, `type: paybill|till`, encrypted with envelope encryption (KMS key + per-tenant DEK). Token cache per clinic in Redis.
- STK Push: `payment_request` row created first (`status=initiated`), then API call, store `checkout_request_id`. Callback → `payment` row, request `status=paid|failed|cancelled|timeout`. Reconciler polls `queryStatus` for requests > 3 min without callback.
- **No ledger of balances. No refunds via API.** Refund is a manual clinic action; inbox lets staff record it.

## 6. Channels (`packages/channels`)

- Interface `Channel { sendText, sendTemplate, sendInteractive(buttons/list), sendLocation, downloadMedia, markRead }`.
- WhatsApp adapter: Graph API `/{phone_number_id}/messages`. Templates managed per WABA; Sema pre-registers utility templates (reminder, confirmation, payment_prompt) during onboarding via Business Management API.
- 24-hour rule: free-form only within 24h of last patient message; outside → must use approved template. Outbox enforces this: chooses template if window closed.
- Embedded Signup: inbox has "Connect WhatsApp" → Meta JS SDK → returns `waba_id`, `phone_number_id`, exchange code for system-user token → subscribe app to WABA webhooks.

## 7. Engine (`packages/engine`) — see CONVERSATION_ENGINE.md

## 8. Realtime inbox

- API exposes `GET /events?clinicId=` SSE stream; worker publishes to Redis pub/sub `clinic:{id}:events`; API fans out. Events: `message.new`, `conversation.updated`, `escalation.new`, `payment.updated`, `appointment.updated`.
- Inbox is a Next.js app calling the API with the staff session cookie; no direct DB access from Next.

## 9. Security

- Secrets via env / Fly secrets; per-tenant secrets encrypted at rest (AES-256-GCM, DEK wrapped by master key).
- Webhook signature verification mandatory; reject if missing.
- Rate limits per phone number on inbound processing (anti-spam) and per staff on API.
- Object storage (Cloudflare R2 / S3) private, signed URLs 10 min, region EU/af-south.
- Backups: daily PITR on Postgres; restore drill quarterly.
- Media retention: 90 days default, configurable, then delete.

## 10. Environments

- `local` (docker compose pg+redis, mocked Meta/Daraja via simulate scripts), `staging` (real Meta test number, Daraja sandbox), `prod`.
- Feature flags via `clinic.flags jsonb` and env-level flags.

## 11. Performance targets

- Webhook ack p99 < 1s. Inbound → outbound reply p95 < 8s (voice notes p95 < 15s). Inbox first paint < 2s on 3G phone. Outbox delivery retry: 5 attempts, exponential backoff, dead-letter to inbox alert.

## 12. Cost model per conversation (target)

Classifier ~1k tokens, agent 3–5 turns × ~4k tokens ⇒ < KES 3. Meta utility conversation ~KES 2–4, service conversation free within window. Target model+channel COGS < 15% of Starter price at quota.
