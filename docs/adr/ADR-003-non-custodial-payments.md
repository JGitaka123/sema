# ADR-003: Non-custodial payments via clinic's own M-Pesa
**Status:** Accepted (2026-08-16)
**Context:** Custodial flows (Sema paybill, settle to clinics) simplify onboarding but create float, reconciliation liability, refund obligations, and CBK PSP licensing questions.
**Decision:** STK Push from each clinic's own Paybill/Till using clinic-supplied Daraja credentials stored encrypted. Sema records receipts; never holds funds; refunds are manual clinic actions recorded in the inbox.
**Consequences:** Onboarding includes Daraja Go-Live assistance; clinics without a Paybill/Till can skip deposits until they have one. No wallet or ledger logic in the codebase.
