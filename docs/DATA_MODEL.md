# Sema — Data Model

All IDs `text` ULIDs. All timestamps `timestamptz` UTC. Money `bigint amount_minor` + `char(3) currency`. Every tenant table has `clinic_id`, `created_at`, `updated_at`, RLS policy `tenant_isolation`. Soft-delete via `deleted_at` where noted.

## Enums
```
staff_role: owner | admin | staff | provider
conversation_mode: agent | human | muted
conversation_status: open | resolved | archived
message_direction: in | out
message_kind: text | audio | image | document | location | interactive | template | system
message_status: received | queued | sent | delivered | read | failed
appointment_status: held | pending_deposit | booked | confirmed | arrived | completed | no_show | cancelled_by_patient | cancelled_by_clinic | rescheduled
payment_request_status: initiated | pushed | paid | failed | cancelled | timeout | waived
escalation_kind: emergency | distress | complaint | payment_issue | low_confidence | patient_requested | abusive | out_of_scope | agent_error
escalation_status: open | acknowledged | resolved
classifier_category: normal | emergency | distress | out_of_scope | abusive | spam
reminder_kind: pre_24h | pre_2h | no_show_rebook | post_visit | recall | custom
outbox_status: pending | sending | sent | failed | dead
consent_kind: service_messages | marketing | data_processing
```

## Tables (DDL sketch)

```sql
create table clinic (
  id text primary key, name text not null, slug text unique not null,
  country char(2) not null default 'KE', timezone text not null default 'Africa/Nairobi',
  currency char(3) not null default 'KES', default_language text not null default 'en',
  emergency_contact_phone text, emergency_script_override text,
  booking_window_days int not null default 30, min_notice_min int not null default 60,
  slot_granularity_min int not null default 15,
  cancellation_policy jsonb not null default '{}',   -- {free_reschedule_hours:24, forfeit_hours:2}
  flags jsonb not null default '{}', plan text not null default 'trial',
  onboarding_state jsonb not null default '{}',
  created_at timestamptz default now(), updated_at timestamptz default now(), deleted_at timestamptz
);

create table location (id text primary key, clinic_id text not null references clinic(id),
  name text not null, address text, lat numeric, lng numeric, maps_url text, phone text, is_primary bool default false, ...);

create table staff_user (id text primary key, clinic_id text not null, email citext not null, name text not null,
  role staff_role not null, phone text, notify_prefs jsonb default '{}', last_seen_at timestamptz, ..., unique(clinic_id,email));

create table provider (id text primary key, clinic_id text not null, staff_user_id text references staff_user(id),
  display_name text not null, title text, specialty text, bio_public text, is_active bool default true, sort int default 0, ...);

create table service (id text primary key, clinic_id text not null, name text not null, category text,
  duration_min int not null, buffer_min int default 0, price_minor bigint, price_note text,
  deposit_minor bigint not null default 0, requires_deposit bool generated always as (deposit_minor > 0) stored,
  patient_bookable bool default true, description_public text, prep_instructions text, is_active bool default true, ...);

create table provider_service (clinic_id text not null, provider_id text references provider(id), service_id text references service(id), primary key(provider_id, service_id));

create table service_intake_question (id text primary key, clinic_id text not null, service_id text references service(id),
  question text not null, kind text not null default 'text', -- text|yes_no|choice
  choices jsonb, required bool default true, sort int default 0);

create table availability_rule (id text primary key, clinic_id text not null, provider_id text references provider(id),
  location_id text references location(id), weekday int not null check (weekday between 0 and 6),
  start_local time not null, end_local time not null, valid_from date, valid_to date);

create table time_off (id text primary key, clinic_id text not null, provider_id text, -- null = whole clinic
  starts_at timestamptz not null, ends_at timestamptz not null, reason text);

create table patient (id text primary key, clinic_id text not null, phone_e164 text not null,
  wa_id text, full_name text, preferred_name text, language text, dob date, sex text, notes_internal text,
  flags jsonb default '{}', -- {vip:bool, blocked:bool, no_show_count:int}
  first_seen_at timestamptz, last_message_at timestamptz, ..., unique(clinic_id, phone_e164));

create table patient_consent (id text primary key, clinic_id text not null, patient_id text references patient(id),
  kind consent_kind not null, granted bool not null, source text, evidence_message_id text, at timestamptz default now());

create table conversation (id text primary key, clinic_id text not null, patient_id text references patient(id),
  mode conversation_mode not null default 'agent', status conversation_status default 'open',
  assigned_staff_id text references staff_user(id), last_message_at timestamptz, last_patient_message_at timestamptz,
  session_expires_at timestamptz, -- last_patient_message_at + 24h
  agent_summary text, unread_for_staff int default 0, pinned bool default false, ...);

create table message (id text primary key, clinic_id text not null, conversation_id text references conversation(id),
  direction message_direction not null, kind message_kind not null, body text, transcript text,
  wa_message_id text, status message_status, sent_by text, -- 'agent' | staff_user id | 'system'
  template_name text, meta jsonb default '{}', at timestamptz not null default now());
create unique index message_wa_id on message(clinic_id, wa_message_id) where wa_message_id is not null;

create table attachment (id text primary key, clinic_id text not null, message_id text references message(id),
  storage_key text not null, mime text, bytes int, sha256 text, expires_at timestamptz);

create table slot_hold (id text primary key, clinic_id text not null, provider_id text not null, service_id text not null,
  patient_id text, conversation_id text, slot tstzrange not null, expires_at timestamptz not null,
  exclude using gist (provider_id with =, slot with &&) where (expires_at > now()));

create table appointment (id text primary key, clinic_id text not null, patient_id text references patient(id),
  provider_id text references provider(id), service_id text references service(id), location_id text,
  slot tstzrange not null, status appointment_status not null,
  source text not null default 'agent', -- agent|staff|walk_in
  intake_answers jsonb default '{}', visit_reason text, notes text,
  deposit_required_minor bigint default 0, deposit_paid_minor bigint default 0, deposit_status text,
  reschedule_of text references appointment(id), cancelled_reason text,
  arrived_at timestamptz, completed_at timestamptz, encounter_id text, ...,
  exclude using gist (provider_id with =, slot with &&) where (status in ('booked','confirmed','arrived','pending_deposit')));

create table payment_request (id text primary key, clinic_id text not null, appointment_id text references appointment(id),
  patient_id text, amount_minor bigint not null, currency char(3) not null, provider text not null default 'mpesa_daraja',
  status payment_request_status not null, checkout_request_id text unique, merchant_request_id text,
  phone_e164 text not null, initiated_by text, failure_reason text, expires_at timestamptz, ...);

create table payment (id text primary key, clinic_id text not null, payment_request_id text references payment_request(id),
  provider_receipt text unique, amount_minor bigint not null, currency char(3), paid_at timestamptz, raw jsonb);

create table reminder (id text primary key, clinic_id text not null, appointment_id text references appointment(id),
  kind reminder_kind not null, due_at timestamptz not null, status text default 'scheduled', -- scheduled|sent|skipped|failed
  job_id text, sent_message_id text);

create table knowledge_item (id text primary key, clinic_id text not null, category text not null, -- hours|location|services|pricing|insurance|policies|faq|prep|staff
  title text, body text not null, is_public bool default true, sort int default 0, updated_by text, ...);

create table template (id text primary key, clinic_id text not null, name text not null, language text not null,
  meta_template_id text, category text, status text, body text, variables jsonb, unique(clinic_id,name,language));

create table escalation (id text primary key, clinic_id text not null, conversation_id text references conversation(id),
  kind escalation_kind not null, status escalation_status default 'open', reason text, classifier_output jsonb,
  acknowledged_by text, acknowledged_at timestamptz, resolved_at timestamptz, ...);

create table note (id text primary key, clinic_id text not null, patient_id text, conversation_id text, appointment_id text,
  body text not null, author text not null, ...);

create table audit_log (id text primary key, clinic_id text not null, actor text not null, -- agent|staff:<id>|system|patient
  action text not null, entity text not null, entity_id text, before jsonb, after jsonb, reason text, at timestamptz default now());

create table outbox (id text primary key, clinic_id text not null, message_id text references message(id),
  channel text not null default 'whatsapp', payload jsonb not null, status outbox_status default 'pending',
  attempts int default 0, next_attempt_at timestamptz, last_error text, ...);

create table webhook_dedup (source text not null, external_id text not null, received_at timestamptz default now(), primary key(source, external_id));

create table subscription (id text primary key, clinic_id text not null unique, plan text not null, status text not null,
  seats int, conversation_quota int, period_start date, period_end date, provider text, provider_ref text, ...);

create table usage_meter (clinic_id text not null, period date not null, conversations int default 0, messages_out int default 0,
  templates_sent int default 0, model_tokens bigint default 0, primary key(clinic_id, period));

-- Phase 3 stubs (created now, unused in v1)
create table payer (id text primary key, clinic_id text not null, name text not null, kind text, -- sha|private_insurer|corporate|cash
  code text, ...);
create table encounter (id text primary key, clinic_id text not null, patient_id text, appointment_id text, provider_id text,
  payer_id text references payer(id), started_at timestamptz, ended_at timestamptz, external_ref text, ...);
```

## Indexes (minimum)
- `conversation(clinic_id, status, last_message_at desc)`, `message(conversation_id, at)`, `appointment(clinic_id, provider_id, slot)`, `patient(clinic_id, phone_e164)`, `reminder(status, due_at)`, `outbox(status, next_attempt_at)`, `escalation(clinic_id, status)`, `audit_log(clinic_id, at)`.

## Retention (see COMPLIANCE.md)
- Messages 24 months, attachments 90 days, audio transcripts 12 months, audit_log 7 years, patient record until clinic deletes or patient requests erasure (pseudonymise: keep appointment counts, drop name/phone/message bodies).

## RLS test
`packages/db/test/rls.test.ts` iterates `information_schema.tables`, asserts RLS enabled + policy present for every table with `clinic_id`, and runs a cross-tenant read that must return 0 rows.

## Implementation notes (Phase 1)
Implemented in `packages/db/src/schema`, created by `drizzle/0000_data_model.sql`. Deliberate deviations from the DDL sketch above:
- **`slot_hold` exclusion predicate.** `where (expires_at > now())` cannot be created: Postgres requires an index predicate to be `IMMUTABLE` and `now()` is `STABLE`. The constraint is unconditional and expiry is a delete — the hold-expiry job removes expired rows, and `holdSlot()` clears that provider's expired holds inside the same transaction. The `appointment` predicate on `status` is created exactly as sketched.
- **RLS on `clinic`.** The sketch mandates policies for tables with `clinic_id`; `clinic` gets one too, on its own `id`. Every policy carries `with check` as well as `using`, so a write cannot cross tenants either, and every such table is also `force row level security`.
- **Every tenant table has `created_at`/`updated_at`** (per the preamble), including join and counter tables. `deleted_at` stays on `clinic` only.
- **`clinic.kmpdc_licence_no`** added: COMPLIANCE.md §5 requires the licence number to be stored on the clinic.
- Foreign keys were added where the sketch used a bare `text` id and the target is unambiguous (`time_off.provider_id`, `slot_hold.*`, `note.patient_id`/`conversation_id`). `note.appointment_id`, `encounter.*` and `appointment.encounter_id` stay unconstrained, to avoid an import cycle and Phase 3 coupling.
- Roles (`sema_app`, `sema_system`) are environment setup, documented in `packages/db/README.md`, not created by migrations — managed Postgres providers differ on what a migration may do to roles.
