# Sema — Compliance (binding)

## 1. Kenya Data Protection Act 2019 (and 2021 Regulations)
- **Roles:** Clinic = data controller. Sema = data processor. Written Data Processing Agreement (DPA) signed at onboarding (template `legal/dpa-template.md`). Sema registers with the ODPC as a data processor (and controller for its own customer data).
- **Health data is sensitive personal data**: process only under explicit consent or the healthcare exemption; consent notice at first patient contact: "Messages here are handled by {clinic}'s assistant, which uses AI. Reply STOP to opt out. Privacy: {short link}." Recorded in `patient_consent`.
- **DPIA** on file (`legal/dpia.md`) covering AI processing, cross-border transfer, retention.
- **Cross-border transfer:** model API and cloud may be outside Kenya. Requires adequacy or appropriate safeguards + consent notice; prefer providers with EU/af-south regions and zero data retention. Document in DPIA. Postgres in EU (Frankfurt) or af-south when GA; note in privacy notice.
- **Data subject rights:** access, rectification, erasure, objection. Inbox provides: export patient data (JSON/PDF), pseudonymise/erase, mark opt-out. SLA 7 days.
- **Retention:** per DATA_MODEL.md; configurable per clinic within limits.
- **Breach:** notify ODPC within 72h, affected clinics immediately, patients where high risk. Runbook `docs/runbooks/breach.md`.
- **Security measures:** encryption in transit/at rest, RLS, per-tenant secret encryption, least privilege, audit logs, MFA for Sema staff, access reviews quarterly.

## 2. Model provider
- Zero data retention / no-training configuration on the API. Do not send more context than needed. Never send patient full name when a first name or "the patient" suffices in classifier calls.

## 3. WhatsApp Business Platform
- **Opt-in** required before templates/proactive messages; store evidence.
- **24-hour customer service window:** free-form only inside; outside use approved templates (utility for reminders/confirmations, marketing only with marketing opt-in).
- **Healthcare category:** no prohibited content; comply with Meta commerce and business policies. Sema (Tech Provider) responsible for its clients' compliance; monitor quality rating per number, throttle if `red`.
- **Display name / business verification** handled during Embedded Signup.
- **STOP handling:** patient replies STOP/ACHA → mark marketing opt-out (service messages about their own appointments still allowed unless they also request that; then mute all proactive).

## 4. Payments (M-Pesa)
- Non-custodial: no CBK PSP licence needed since funds settle to the clinic's own account. Store Daraja credentials encrypted; never log. Show M-Pesa receipt numbers to staff only.
- Sema's own subscription billing complies with KRA eTIMS invoicing.

## 5. Medical regulatory
- Sema is administrative software; no clinical decision support. Marketing must not claim clinical functions. KMPDC-registered clinics only as customers (verify licence number at onboarding, stored on `clinic`).

## 6. Consumer protection / disclosure
- Patients are told they're talking to an AI assistant at first contact and can ask for a human at any time.

## 7. Terms
- `legal/terms.md`, `legal/privacy.md`, `legal/dpa-template.md`, `legal/aup.md`. Reviewed by counsel before first paying customer.
