# ADR-001: WhatsApp Cloud API direct, one number per clinic, Sema as Tech Provider
**Status:** Accepted (2026-08-16)
**Context:** Options were (a) BSP such as Twilio/360dialog, (b) Meta Cloud API direct with Sema as Tech Provider via Embedded Signup, (c) one shared Sema number for all clinics.
**Decision:** (b). Each clinic connects its own WhatsApp number; patients see the clinic's brand; Sema pays Meta conversation fees at cost with no BSP markup; Embedded Signup makes onboarding self-serve.
**Consequences:** Sema must pass Meta App Review and maintain Tech Provider compliance; must monitor per-number quality ratings; a shared trial number is kept for pre-signup trials. Channel interface preserved for SMS/voice later.
