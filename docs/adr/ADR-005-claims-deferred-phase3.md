# ADR-005: Claims / RCM deferred to Phase 3, schema kept compatible
**Status:** Accepted (2026-08-16)
**Context:** Claims automation is the larger long-term opportunity (ClaimFlow) but requires payer integrations, clinical coding, and different buyers' trust; building it into v1 would delay the front-desk wedge.
**Decision:** v1 ships no claims features. Data model includes `payer` and `encounter` stubs and `appointment.encounter_id`; `patient` shape is shared. ClaimFlow / Aifya integration point is `packages/connectors` later.
**Consequences:** No insurer/SHA logic in v1 beyond "insurance accepted" as knowledge text. Any claims work needs a superseding ADR and its own spec.
