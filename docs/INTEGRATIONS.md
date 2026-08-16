# Sema — Integrations

## 1. WhatsApp Cloud API (Meta)

### Setup (Sema side, once)
- Meta Business, Meta App (type Business), WhatsApp product added, App Review for `whatsapp_business_messaging`, `whatsapp_business_management`, `business_management`. Apply as **Tech Provider** so clinics onboard via Embedded Signup.
- Webhook URL `POST /webhooks/whatsapp`, verify token, subscribe to `messages`, `message_template_status_update`, `account_update`, `phone_number_quality_update`.

### Per clinic (Embedded Signup)
- Inbox "Connect WhatsApp" → Meta JS SDK → returns `code`, `waba_id`, `phone_number_id` → API exchanges code for token → store `clinic_whatsapp{waba_id, phone_number_id, token_encrypted, display_name, quality_rating}` → `POST /{waba_id}/subscribed_apps` → register number (`/register` with PIN) → create/submit templates:
  - `appt_confirmation` (utility), `appt_reminder_24h`, `appt_reminder_2h`, `deposit_prompt`, `rebook_after_no_show`, `staff_followup` (utility, for reopening a window when staff needs to reach patient), `emergency_alert_staff` (utility, to staff numbers).
- Trial clinics: use Sema's shared trial number until signup complete (patients see "Sema for {clinic}").

### Sending
- Text: `{"messaging_product":"whatsapp","to":"2547...","type":"text","text":{"body":"..."}}`
- Interactive buttons (≤3) for slot picks / yes-no; list messages for > 3 options.
- Template outside 24h window with components/parameters.
- Location message for clinic pin.
- Mark as read on ingest.
- Rate limits: respect 80 msg/s per number tier; outbox throttles per clinic.

### Receiving
- Verify `X-Hub-Signature-256` with app secret. Payload `entry[].changes[].value.messages[]` and `.statuses[]`. Media: `GET /{media_id}` → URL → download with bearer token.
- Errors: 131047 (re-engagement outside window) → outbox falls back to template; 131026 (undeliverable) → mark failed; 130429 (rate) → backoff.

## 2. Safaricom Daraja (M-Pesa)

### Per clinic
- Clinic supplies: Paybill or Till number, Daraja app `consumer_key`, `consumer_secret`, Lipa Na M-Pesa `passkey` (from Safaricom Go-Live), or Sema assists with the Go-Live process (documented `docs/runbooks/daraja-golive.md`). Stored encrypted.
- Sandbox creds for staging.

### STK Push
- OAuth token (cache 50 min). `POST /mpesa/stkpush/v1/processrequest` with `BusinessShortCode`, `Password=base64(shortcode+passkey+timestamp)`, `Timestamp`, `TransactionType=CustomerPayBillOnline|CustomerBuyGoodsOnline`, `Amount`, `PartyA=patient phone`, `PartyB=shortcode`, `PhoneNumber`, `CallBackURL=https://api.sema.../webhooks/mpesa/stk?clinic=...&req=...`, `AccountReference=APT-{short id}`, `TransactionDesc`.
- Store `MerchantRequestID`, `CheckoutRequestID`.
- Callback `Body.stkCallback.ResultCode` 0 = success with `CallbackMetadata` (Amount, MpesaReceiptNumber, PhoneNumber). Non-zero: 1032 cancelled by user, 1037 timeout, 1 insufficient funds, etc. Map to `payment_request.status`.
- Reconciler: `POST /mpesa/stkpushquery/v1/query` for requests > 3 min without callback (max 3 polls).
- Idempotency: `webhook_dedup('mpesa', CheckoutRequestID)`.
- Callback URL must be HTTPS public; local dev via `mpesa:simulate`.

### C2B (Phase 2)
- Register validation/confirmation URLs so manual patient payments referencing `APT-xxxx` auto-reconcile.

## 3. Transcription
- Interface `Transcriber.transcribe(buffer, mime, langHint) → {text, confidence, language}`. Adapters: OpenAI Whisper API, Deepgram. Choose by eval on 50 Swahili/Sheng voice notes.

## 4. Object storage
- Cloudflare R2 (S3 API). Bucket per env; keys `clinic/{id}/media/{ulid}`; lifecycle rule 90 days.

## 5. Notifications to staff
- In-app (SSE), browser push (Web Push), WhatsApp template to staff number for emergencies and unassigned escalations > 10 min out of hours, email daily digest.

## 6. Analytics
- PostHog (EU cloud). Events in `shared/analytics/events.ts`. No PHI.

## 7. Billing (Sema revenue)
- M-Pesa Paybill (Sema's own) via Daraja C2B for KES; Paystack for cards. `subscription` table; usage from `usage_meter`. Invoices via eTIMS-compliant generator (Phase 2; manual for design partners).

## 8. Future connectors (`packages/connectors`, Phase 2+)
- Google Calendar, iCal, Aifya HMIS, ClaimFlow, SHA eligibility.
