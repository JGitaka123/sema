import { isE164, isId, tryNormalisePhone } from "@sema/shared";
import { describe, expect, it } from "vitest";

import {
  AFYANEX_CLINIC_ID,
  availabilityRows,
  clinicRow,
  consentRows,
  intakeQuestionRows,
  knowledgeRows,
  locationRows,
  patientRows,
  providerRows,
  providerServiceRows,
  serviceRows,
  staffRows,
} from "./fixtures.js";
import { isSeedId, seedId } from "./ids.js";

describe("seedId", () => {
  it("produces a valid prefixed ULID", () => {
    expect(isId("patient", seedId("patient", "p001"))).toBe(true);
    expect(isId("clinic", AFYANEX_CLINIC_ID)).toBe(true);
  });

  it("is stable across calls — this is what makes the seed re-runnable", () => {
    expect(seedId("provider", "gp")).toBe(seedId("provider", "gp"));
  });

  it("substitutes the characters Crockford base32 excludes", () => {
    // "lou" would be invalid; I/L/O/U map to 1/1/0/V.
    expect(isId("patient", seedId("patient", "lou-illinois"))).toBe(true);
  });

  it("pads and truncates to exactly 26 characters", () => {
    expect(seedId("patient", "").length).toBe("pat_".length + 26);
    expect(seedId("patient", "x".repeat(80)).length).toBe("pat_".length + 26);
  });

  it("marks seeded ids as recognisably fake", () => {
    expect(isSeedId(seedId("patient", "p001"))).toBe(true);
    expect(isSeedId("pat_01J8XYZ00000000000000000AB")).toBe(false);
  });
});

describe("Afyanex fixture", () => {
  it("is a Nairobi clinic billing in KES", () => {
    expect(clinicRow.timezone).toBe("Africa/Nairobi");
    expect(clinicRow.currency).toBe("KES");
    expect(clinicRow.country).toBe("KE");
  });

  it("has one primary location", () => {
    expect(locationRows.filter((l) => l.isPrimary)).toHaveLength(1);
  });

  it("has an owner, an admin and a front-desk staff user", () => {
    expect(staffRows.map((s) => s.role).sort()).toEqual(["admin", "owner", "staff"]);
    expect(new Set(staffRows.map((s) => s.email)).size).toBe(staffRows.length);
  });

  it("uses reserved .example email domains so seeding cannot mail a real person", () => {
    for (const staff of staffRows) expect(staff.email).toMatch(/@[\w.-]+\.example$/);
  });

  it("has at least three providers, each linked to at least one service", () => {
    expect(providerRows.length).toBeGreaterThanOrEqual(3);
    for (const p of providerRows) {
      expect(providerServiceRows.some((ps) => ps.providerId === p.id)).toBe(true);
    }
  });

  it("prices everything in whole minor units, no floats", () => {
    for (const s of serviceRows) {
      expect(Number.isInteger(s.priceMinor ?? 0)).toBe(true);
      expect(Number.isInteger(s.depositMinor ?? 0)).toBe(true);
    }
  });

  it("has at least one service with a deposit, and it has intake questions", () => {
    const withDeposit = serviceRows.filter((s) => (s.depositMinor ?? 0) > 0);
    expect(withDeposit.length).toBeGreaterThan(0);
    for (const s of withDeposit) {
      expect(intakeQuestionRows.some((q) => q.serviceId === s.id)).toBe(true);
    }
  });

  it("only references services that exist", () => {
    const serviceIds = new Set(serviceRows.map((s) => s.id));
    for (const link of providerServiceRows) expect(serviceIds.has(link.serviceId)).toBe(true);
    for (const q of intakeQuestionRows) expect(serviceIds.has(q.serviceId)).toBe(true);
  });

  it("opens Monday to Saturday and never on Sunday", () => {
    const weekdays = new Set(availabilityRows.map((r) => r.weekday));
    expect([...weekdays].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(weekdays.has(0)).toBe(false);
  });

  it("has availability rules that start before they end", () => {
    for (const rule of availabilityRows) {
      expect(String(rule.startLocal) < String(rule.endLocal)).toBe(true);
    }
  });

  it("covers the knowledge categories the agent answers from", () => {
    const categories = new Set(knowledgeRows.map((k) => k.category));
    for (const required of ["hours", "location", "pricing", "insurance", "policies", "faq"]) {
      expect(categories.has(required)).toBe(true);
    }
    expect(knowledgeRows.length).toBeGreaterThanOrEqual(10);
  });

  it("has 20 demo patients with valid, fake +2547 numbers", () => {
    expect(patientRows).toHaveLength(20);
    for (const p of patientRows) {
      expect(isE164(p.phoneE164)).toBe(true);
      expect(p.phoneE164).toMatch(/^\+2547\d{8}$/);
      // Survives the ingest normaliser unchanged.
      expect(tryNormalisePhone(p.phoneE164)).toBe(p.phoneE164);
      expect(p.waId).toBe(String(p.phoneE164).slice(1));
    }
    expect(new Set(patientRows.map((p) => p.phoneE164)).size).toBe(20);
  });

  it("records consent for every patient, with marketing off by default", () => {
    for (const p of patientRows) {
      const consents = consentRows.filter((c) => c.patientId === p.id);
      expect(consents.map((c) => c.kind).sort()).toEqual([
        "data_processing",
        "marketing",
        "service_messages",
      ]);
      expect(consents.find((c) => c.kind === "marketing")?.granted).toBe(false);
      expect(consents.find((c) => c.kind === "data_processing")?.granted).toBe(true);
    }
  });

  it("gives every row a unique, seed-marked id under the one clinic", () => {
    const rows = [
      clinicRow,
      ...locationRows,
      ...staffRows,
      ...providerRows,
      ...serviceRows,
      ...intakeQuestionRows,
      ...availabilityRows,
      ...knowledgeRows,
      ...patientRows,
      ...consentRows,
    ];
    const ids = rows.map((r) => r.id as string);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isSeedId(id)).toBe(true);

    for (const row of rows) {
      if ("clinicId" in row) expect(row.clinicId).toBe(AFYANEX_CLINIC_ID);
    }
  });
});
