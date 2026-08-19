-- Sema Phase 3 — the WhatsApp sender a clinic is connected to, and the one
-- narrow lookup that has to run before a tenant context exists.
--
-- Hand-written sections (drizzle-kit cannot express them) are marked below:
--   2. row level security: enable + force + tenant_isolation policy
--   3. sema_resolve_clinic_by_phone_number_id(), SECURITY DEFINER
--
-- Section 1 is drizzle-kit generate output; regenerate with
-- `pnpm --filter @sema/db generate` and keep the hand-written parts.

-- 1. Table --------------------------------------------------------------------
CREATE TABLE "clinic_whatsapp" (
	"id" text PRIMARY KEY NOT NULL,
	"clinic_id" text NOT NULL,
	"waba_id" text NOT NULL,
	"phone_number_id" text NOT NULL,
	"display_phone_number" text,
	"display_name" text,
	"quality_rating" text,
	"access_token_encrypted" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinic_whatsapp" ADD CONSTRAINT "clinic_whatsapp_clinic_id_clinic_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinic"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Global uniqueness, not per-clinic: one sender belongs to exactly one clinic,
-- and inbound routing is only safe because of it.
CREATE UNIQUE INDEX "clinic_whatsapp_phone_number_id_key" ON "clinic_whatsapp" USING btree ("phone_number_id");--> statement-breakpoint
CREATE INDEX "clinic_whatsapp_clinic_idx" ON "clinic_whatsapp" USING btree ("clinic_id");--> statement-breakpoint

-- 2. Row level security (CLAUDE.md hard rule 8) --------------------------------
ALTER TABLE "clinic_whatsapp" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clinic_whatsapp" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "clinic_whatsapp" USING ("clinic_id" = current_setting('app.current_clinic', true)) WITH CHECK ("clinic_id" = current_setting('app.current_clinic', true));--> statement-breakpoint

-- 3. Inbound routing ----------------------------------------------------------
-- The chicken-and-egg of ARCHITECTURE.md §2 step 2: "resolve clinic by
-- phone_number_id". The webhook has no tenant context yet, so the policy above
-- would (correctly) hide every row. Rather than hand the app role BYPASSRLS —
-- which would expose every patient row in the database — we expose exactly one
-- SECURITY DEFINER function with exactly one answer.
--
-- Why this is safe:
--   * it returns a clinic id and nothing else: no token, no waba id, no
--     patient data. A clinic id is not personal data.
--   * the argument is the sender id Meta itself put in the payload, and the
--     caller has already proved the payload is Meta's by verifying
--     X-Hub-Signature-256 (ARCHITECTURE.md §9).
--   * `search_path` is pinned, so a caller cannot shadow `clinic_whatsapp`
--     with a table of their own and have the definer read that instead.
--   * inactive senders resolve to NULL, so disconnecting a number in the inbox
--     stops inbound processing immediately.
CREATE OR REPLACE FUNCTION sema_resolve_clinic_by_phone_number_id(p_phone_number_id text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT clinic_id
  FROM clinic_whatsapp
  WHERE phone_number_id = p_phone_number_id
    AND is_active
  LIMIT 1;
$$;--> statement-breakpoint
COMMENT ON FUNCTION sema_resolve_clinic_by_phone_number_id(text) IS
  'Inbound WhatsApp routing only. Returns the clinic id owning a Meta phone_number_id, or NULL. SECURITY DEFINER because the webhook must route before it has a tenant context; it deliberately exposes nothing else.';--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sema_resolve_clinic_by_phone_number_id(text) TO PUBLIC;
