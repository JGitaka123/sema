-- Sema Phase 1 — the whole of docs/DATA_MODEL.md in one migration.
--
-- Hand-written sections (drizzle-kit cannot express them) are marked below:
--   1. extensions        — must exist before the tables that use citext / gist
--   2. exclusion constraints on slot_hold and appointment
--   3. row level security: enable + force + tenant_isolation policy
--
-- Everything between them is drizzle-kit generate output; regenerate with
-- `pnpm --filter @sema/db generate` and keep the hand-written parts.

-- 1. Extensions ---------------------------------------------------------------
-- btree_gist : lets a gist index mix the scalar provider_id with the tstzrange
--              slot, which is what the exclusion constraints below need.
-- citext     : staff_user.email, so login is not case sensitive.
-- pgcrypto   : gen_random_bytes for per-tenant DEK generation (ARCHITECTURE §9).
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint

CREATE TYPE "public"."appointment_status" AS ENUM('held', 'pending_deposit', 'booked', 'confirmed', 'arrived', 'completed', 'no_show', 'cancelled_by_patient', 'cancelled_by_clinic', 'rescheduled');--> statement-breakpoint
CREATE TYPE "public"."classifier_category" AS ENUM('normal', 'emergency', 'distress', 'out_of_scope', 'abusive', 'spam');--> statement-breakpoint
CREATE TYPE "public"."consent_kind" AS ENUM('service_messages', 'marketing', 'data_processing');--> statement-breakpoint
CREATE TYPE "public"."conversation_mode" AS ENUM('agent', 'human', 'muted');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('open', 'resolved', 'archived');--> statement-breakpoint
CREATE TYPE "public"."escalation_kind" AS ENUM('emergency', 'distress', 'complaint', 'payment_issue', 'low_confidence', 'patient_requested', 'abusive', 'out_of_scope', 'agent_error');--> statement-breakpoint
CREATE TYPE "public"."escalation_status" AS ENUM('open', 'acknowledged', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('text', 'audio', 'image', 'document', 'location', 'interactive', 'template', 'system');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('received', 'queued', 'sent', 'delivered', 'read', 'failed');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'sending', 'sent', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."payment_request_status" AS ENUM('initiated', 'pushed', 'paid', 'failed', 'cancelled', 'timeout', 'waived');--> statement-breakpoint
CREATE TYPE "public"."reminder_kind" AS ENUM('pre_24h', 'pre_2h', 'no_show_rebook', 'post_visit', 'recall', 'custom');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('owner', 'admin', 'staff', 'provider');--> statement-breakpoint
CREATE TABLE "clinic" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"country" char(2) DEFAULT 'KE' NOT NULL,
	"timezone" text DEFAULT 'Africa/Nairobi' NOT NULL,
	"currency" char(3) DEFAULT 'KES' NOT NULL,
	"default_language" text DEFAULT 'en' NOT NULL,
	"emergency_contact_phone" text,
	"emergency_script_override" text,
	"booking_window_days" integer DEFAULT 30 NOT NULL,
	"min_notice_min" integer DEFAULT 60 NOT NULL,
	"slot_granularity_min" integer DEFAULT 15 NOT NULL,
	"cancellation_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"plan" text DEFAULT 'trial' NOT NULL,
	"onboarding_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"kmpdc_licence_no" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "clinic_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "location" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"lat" numeric,
	"lng" numeric,
	"maps_url" text,
	"phone" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"staff_user_id" text,
	"display_name" text NOT NULL,
	"title" text,
	"specialty" text,
	"bio_public" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_user" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"email" "citext" NOT NULL,
	"name" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"phone" text,
	"notify_prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_service" (
	"clinic_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"service_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_service_provider_id_service_id_pk" PRIMARY KEY("provider_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "service" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"duration_min" integer NOT NULL,
	"buffer_min" integer DEFAULT 0 NOT NULL,
	"price_minor" bigint,
	"price_note" text,
	"deposit_minor" bigint DEFAULT 0 NOT NULL,
	"requires_deposit" boolean GENERATED ALWAYS AS (deposit_minor > 0) STORED,
	"patient_bookable" boolean DEFAULT true NOT NULL,
	"description_public" text,
	"prep_instructions" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_intake_question" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"service_id" text NOT NULL,
	"question" text NOT NULL,
	"kind" text DEFAULT 'text' NOT NULL,
	"choices" jsonb,
	"required" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability_rule" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"location_id" text,
	"weekday" integer NOT NULL,
	"start_local" time NOT NULL,
	"end_local" time NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_rule_weekday_check" CHECK ("availability_rule"."weekday" between 0 and 6)
);
--> statement-breakpoint
CREATE TABLE "time_off" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"provider_id" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"phone_e164" text NOT NULL,
	"wa_id" text,
	"full_name" text,
	"preferred_name" text,
	"language" text,
	"dob" date,
	"sex" text,
	"notes_internal" text,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"kind" "consent_kind" NOT NULL,
	"granted" boolean NOT NULL,
	"source" text,
	"evidence_message_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachment" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"message_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text,
	"bytes" integer,
	"sha256" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"mode" "conversation_mode" DEFAULT 'agent' NOT NULL,
	"status" "conversation_status" DEFAULT 'open' NOT NULL,
	"assigned_staff_id" text,
	"last_message_at" timestamp with time zone,
	"last_patient_message_at" timestamp with time zone,
	"session_expires_at" timestamp with time zone,
	"agent_summary" text,
	"unread_for_staff" integer DEFAULT 0 NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalation" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"kind" "escalation_kind" NOT NULL,
	"status" "escalation_status" DEFAULT 'open' NOT NULL,
	"reason" text,
	"classifier_output" jsonb,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"direction" "message_direction" NOT NULL,
	"kind" "message_kind" NOT NULL,
	"body" text,
	"transcript" text,
	"wa_message_id" text,
	"status" "message_status",
	"sent_by" text,
	"template_name" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"patient_id" text,
	"conversation_id" text,
	"appointment_id" text,
	"body" text NOT NULL,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointment" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"service_id" text NOT NULL,
	"location_id" text,
	"slot" "tstzrange" NOT NULL,
	"status" "appointment_status" NOT NULL,
	"source" text DEFAULT 'agent' NOT NULL,
	"intake_answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visit_reason" text,
	"notes" text,
	"deposit_required_minor" bigint DEFAULT 0 NOT NULL,
	"deposit_paid_minor" bigint DEFAULT 0 NOT NULL,
	"deposit_status" text,
	"reschedule_of" text,
	"cancelled_reason" text,
	"arrived_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"encounter_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminder" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"appointment_id" text NOT NULL,
	"kind" "reminder_kind" NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"job_id" text,
	"sent_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slot_hold" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"service_id" text NOT NULL,
	"patient_id" text,
	"conversation_id" text,
	"slot" "tstzrange" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"payment_request_id" text NOT NULL,
	"provider_receipt" text,
	"amount_minor" bigint NOT NULL,
	"currency" char(3),
	"paid_at" timestamp with time zone,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_provider_receipt_unique" UNIQUE("provider_receipt")
);
--> statement-breakpoint
CREATE TABLE "payment_request" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"appointment_id" text,
	"patient_id" text,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"provider" text DEFAULT 'mpesa_daraja' NOT NULL,
	"status" "payment_request_status" NOT NULL,
	"checkout_request_id" text,
	"merchant_request_id" text,
	"phone_e164" text NOT NULL,
	"initiated_by" text,
	"failure_reason" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_request_checkout_request_id_unique" UNIQUE("checkout_request_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_item" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"category" text NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"meta_template_id" text,
	"category" text,
	"status" text,
	"body" text,
	"variables" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"message_id" text,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"plan" text NOT NULL,
	"status" text NOT NULL,
	"seats" integer,
	"conversation_quota" integer,
	"period_start" date,
	"period_end" date,
	"provider" text,
	"provider_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_clinic_id_unique" UNIQUE("clinic_id")
);
--> statement-breakpoint
CREATE TABLE "usage_meter" (
	"clinic_id" text NOT NULL,
	"period" date NOT NULL,
	"conversations" integer DEFAULT 0 NOT NULL,
	"messages_out" integer DEFAULT 0 NOT NULL,
	"templates_sent" integer DEFAULT 0 NOT NULL,
	"model_tokens" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_meter_clinic_id_period_pk" PRIMARY KEY("clinic_id","period")
);
--> statement-breakpoint
CREATE TABLE "webhook_dedup" (
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_dedup_source_external_id_pk" PRIMARY KEY("source","external_id")
);
--> statement-breakpoint
CREATE TABLE "encounter" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"patient_id" text,
	"appointment_id" text,
	"provider_id" text,
	"payer_id" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payer" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text,
	"code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider" ADD CONSTRAINT "provider_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider" ADD CONSTRAINT "provider_staff_user_id_staff_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_user" ADD CONSTRAINT "staff_user_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_service" ADD CONSTRAINT "provider_service_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_service" ADD CONSTRAINT "provider_service_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_service" ADD CONSTRAINT "provider_service_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_intake_question" ADD CONSTRAINT "service_intake_question_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_intake_question" ADD CONSTRAINT "service_intake_question_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_rule" ADD CONSTRAINT "availability_rule_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_rule" ADD CONSTRAINT "availability_rule_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_rule" ADD CONSTRAINT "availability_rule_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_consent" ADD CONSTRAINT "patient_consent_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_consent" ADD CONSTRAINT "patient_consent_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_assigned_staff_id_staff_user_id_fk" FOREIGN KEY ("assigned_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation" ADD CONSTRAINT "escalation_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation" ADD CONSTRAINT "escalation_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_reschedule_of_appointment_id_fk" FOREIGN KEY ("reschedule_of") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder" ADD CONSTRAINT "reminder_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder" ADD CONSTRAINT "reminder_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_hold" ADD CONSTRAINT "slot_hold_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_hold" ADD CONSTRAINT "slot_hold_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_hold" ADD CONSTRAINT "slot_hold_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_hold" ADD CONSTRAINT "slot_hold_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_hold" ADD CONSTRAINT "slot_hold_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_payment_request_id_payment_request_id_fk" FOREIGN KEY ("payment_request_id") REFERENCES "public"."payment_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_request" ADD CONSTRAINT "payment_request_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_request" ADD CONSTRAINT "payment_request_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_request" ADD CONSTRAINT "payment_request_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_item" ADD CONSTRAINT "knowledge_item_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template" ADD CONSTRAINT "template_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_meter" ADD CONSTRAINT "usage_meter_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_payer_id_payer_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer" ADD CONSTRAINT "payer_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinic_deleted_at_idx" ON "clinic" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "location_clinic_idx" ON "location" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "provider_clinic_idx" ON "provider" USING btree ("clinic_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_user_clinic_email_key" ON "staff_user" USING btree ("clinic_id","email");--> statement-breakpoint
CREATE INDEX "provider_service_clinic_idx" ON "provider_service" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "service_clinic_idx" ON "service" USING btree ("clinic_id","is_active");--> statement-breakpoint
CREATE INDEX "service_intake_question_service_idx" ON "service_intake_question" USING btree ("service_id","sort");--> statement-breakpoint
CREATE INDEX "availability_rule_provider_idx" ON "availability_rule" USING btree ("clinic_id","provider_id","weekday");--> statement-breakpoint
CREATE INDEX "time_off_clinic_window_idx" ON "time_off" USING btree ("clinic_id","starts_at","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_clinic_phone_key" ON "patient" USING btree ("clinic_id","phone_e164");--> statement-breakpoint
CREATE INDEX "patient_consent_patient_kind_idx" ON "patient_consent" USING btree ("patient_id","kind","at");--> statement-breakpoint
CREATE INDEX "attachment_message_idx" ON "attachment" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "attachment_expires_at_idx" ON "attachment" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "conversation_clinic_status_idx" ON "conversation" USING btree ("clinic_id","status","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "escalation_clinic_status_idx" ON "escalation" USING btree ("clinic_id","status");--> statement-breakpoint
CREATE INDEX "message_conversation_at_idx" ON "message" USING btree ("conversation_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_wa_id" ON "message" USING btree ("clinic_id","wa_message_id") WHERE wa_message_id is not null;--> statement-breakpoint
CREATE INDEX "note_patient_idx" ON "note" USING btree ("clinic_id","patient_id");--> statement-breakpoint
CREATE INDEX "note_appointment_idx" ON "note" USING btree ("clinic_id","appointment_id");--> statement-breakpoint
CREATE INDEX "appointment_clinic_provider_slot_idx" ON "appointment" USING btree ("clinic_id","provider_id","slot");--> statement-breakpoint
CREATE INDEX "appointment_clinic_status_idx" ON "appointment" USING btree ("clinic_id","status");--> statement-breakpoint
CREATE INDEX "appointment_patient_idx" ON "appointment" USING btree ("clinic_id","patient_id");--> statement-breakpoint
CREATE INDEX "reminder_status_due_at_idx" ON "reminder" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "slot_hold_expires_at_idx" ON "slot_hold" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "payment_request_idx" ON "payment" USING btree ("payment_request_id");--> statement-breakpoint
CREATE INDEX "payment_request_clinic_status_idx" ON "payment_request" USING btree ("clinic_id","status");--> statement-breakpoint
CREATE INDEX "payment_request_appointment_idx" ON "payment_request" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "knowledge_item_clinic_category_idx" ON "knowledge_item" USING btree ("clinic_id","category","sort");--> statement-breakpoint
CREATE UNIQUE INDEX "template_clinic_name_language_key" ON "template" USING btree ("clinic_id","name","language");--> statement-breakpoint
CREATE INDEX "audit_log_clinic_at_idx" ON "audit_log" USING btree ("clinic_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("clinic_id","entity","entity_id");--> statement-breakpoint
CREATE INDEX "outbox_status_next_attempt_idx" ON "outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "outbox_clinic_status_idx" ON "outbox" USING btree ("clinic_id","status");--> statement-breakpoint
CREATE INDEX "webhook_dedup_received_at_idx" ON "webhook_dedup" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "encounter_clinic_patient_idx" ON "encounter" USING btree ("clinic_id","patient_id");--> statement-breakpoint
CREATE INDEX "payer_clinic_idx" ON "payer" USING btree ("clinic_id");

-- 2. Exclusion constraints -----------------------------------------------------
-- Double-booking is prevented by Postgres, not by application logic: two
-- concurrent agent turns must not be able to both win the same slot
-- (ARCHITECTURE.md §4).
--
-- DATA_MODEL.md sketches the slot_hold constraint as
-- `where (expires_at > now())`. Postgres rejects that: an index predicate must
-- be IMMUTABLE and now() is STABLE. The constraint is therefore unconditional
-- and expiry is a delete: the hold-expiry job (Phase 2) removes expired rows,
-- and holdSlot() deletes this provider's expired holds inside the same
-- transaction before inserting. Net effect is the documented behaviour.
ALTER TABLE "slot_hold" ADD CONSTRAINT "slot_hold_no_overlap"
  EXCLUDE USING gist ("provider_id" WITH =, "slot" WITH &&);--> statement-breakpoint

-- Statuses that actually occupy a provider's calendar. Cancelled, completed,
-- no-show and rescheduled rows stay as history and may overlap freely.
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_no_overlap"
  EXCLUDE USING gist ("provider_id" WITH =, "slot" WITH &&)
  WHERE (status IN ('booked', 'confirmed', 'arrived', 'pending_deposit'));--> statement-breakpoint

-- 3. Row level security --------------------------------------------------------
-- CLAUDE.md hard rule 8 + ARCHITECTURE.md §3. Every table with clinic_id gets
-- the same policy; `clinic` itself isolates on its own id.
--
-- FORCE makes the policy apply to the table owner too, so a mistake in a
-- migration or admin session cannot silently read across tenants. Superusers
-- still bypass RLS — that is a Postgres rule, which is why the app connects as
-- the unprivileged `sema_app` role (see packages/db/README.md).
--
-- current_setting('app.current_clinic', true) returns NULL when unset, so a
-- connection that forgot withTenant() sees nothing at all rather than
-- everything.
--
-- webhook_dedup is deliberately absent: it has no clinic_id because the webhook
-- handler must dedup before it knows which clinic a payload belongs to, and it
-- stores only opaque vendor message ids. It is the single exception, asserted
-- as such in packages/db/test/rls.test.ts.

ALTER TABLE "appointment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointment" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "attachment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attachment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "attachment" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_log" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "availability_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "availability_rule" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "availability_rule" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "clinic" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clinic" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "clinic" USING ("id" = current_setting('app.current_clinic', true)) WITH CHECK ("id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "conversation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversation" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "encounter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encounter" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "encounter" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "escalation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "escalation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "escalation" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "knowledge_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_item" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "knowledge_item" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "location" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "location" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "location" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "message" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "note" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "note" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "note" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "outbox" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "patient" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "patient" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "patient_consent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "patient_consent" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "patient_consent" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "payer" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payer" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payer" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "payment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "payment_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_request" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "provider" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "provider" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "provider_service" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_service" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "provider_service" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "reminder" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reminder" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "reminder" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "service" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "service" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "service" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "service_intake_question" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "service_intake_question" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "service_intake_question" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "slot_hold" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "slot_hold" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "slot_hold" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "staff_user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "staff_user" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "staff_user" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "subscription" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subscription" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "template" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "template" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "time_off" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "time_off" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "time_off" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint
ALTER TABLE "usage_meter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_meter" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "usage_meter" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));
