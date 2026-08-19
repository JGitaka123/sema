import { describe, expect, it } from "vitest";

import {
  renderOwnerWeeklyDigest,
  renderOwnerWeeklyHeadline,
  renderStaffMorningDigest,
  renderStaffMorningHeadline,
  type MorningAppointment,
  type OwnerWeeklyMetrics,
  type StaffMorningDigest,
} from "./digest.js";
import { morningDigestWindow, weeklyDigestWindow } from "./digest-period.js";

/**
 * Rendering only — the metrics queries are proven against a real Postgres in
 * `test/reminders.test.ts`. What matters here is that the text reads correctly
 * on a phone and that the one-line variants stay one line, because Meta rejects
 * a template parameter containing a newline.
 */

const NAIROBI = "Africa/Nairobi";
const MONDAY_0700 = new Date("2026-08-17T04:00:00Z");

const metrics: OwnerWeeklyMetrics = {
  window: weeklyDigestWindow(MONDAY_0700, NAIROBI, 1),
  currency: "KES",
  bookings: 42,
  outcomes: 32,
  noShows: 4,
  noShowRatePct: 12.5,
  depositsCollectedMinor: 450_000,
  agentMessages: 210,
  staffMessages: 90,
  afterHoursInbound: 37,
};

describe("renderOwnerWeeklyDigest", () => {
  it("reports the SPEC §4.8 metrics over the completed week", () => {
    const text = renderOwnerWeeklyDigest("Afyanex", metrics);
    expect(text).toContain("Afyanex — weekly summary (10 Aug – 16 Aug 2026)");
    expect(text).toContain("Appointments booked: 42");
    expect(text).toContain("No-shows: 4 of 32 (12.5%)");
    expect(text).toContain("Deposits collected: KES 4,500");
    expect(text).toContain("210 by the assistant, 90 by the team (70% automated)");
    expect(text).toContain("Messages received outside opening hours: 37");
  });

  it("does not invent a rate or a share out of an empty week", () => {
    const quiet = renderOwnerWeeklyDigest("Afyanex", {
      ...metrics,
      bookings: 0,
      outcomes: 0,
      noShows: 0,
      noShowRatePct: null,
      agentMessages: 0,
      staffMessages: 0,
      depositsCollectedMinor: 0,
    });
    expect(quiet).toContain("No-shows: 0 of 0");
    expect(quiet).not.toMatch(/%\)/);
    expect(quiet).toContain("Deposits collected: KES 0");
  });

  it("renders an unknown currency rather than throwing", () => {
    const text = renderOwnerWeeklyDigest("Afyanex", { ...metrics, currency: "XOF" });
    expect(text).toContain("Deposits collected: XOF 450000");
  });
});

describe("renderOwnerWeeklyHeadline", () => {
  it("fits the week into one template parameter", () => {
    const headline = renderOwnerWeeklyHeadline(metrics);
    expect(headline).toBe(
      "42 booked · 12.5% no-show · KES 4,500 deposits · 37 after-hours messages",
    );
    expect(headline).not.toMatch(/[\r\n\t]/);
  });
});

// ── Morning digest ───────────────────────────────────────────────────────────

const window = morningDigestWindow(MONDAY_0700, NAIROBI);

function appointment(overrides: Partial<MorningAppointment> = {}): MorningAppointment {
  return {
    appointmentId: "apt_01J000000000000000000001",
    start: new Date("2026-08-17T06:00:00Z"), // 09:00 Nairobi
    providerId: "prv_1",
    providerName: "Dr. Otieno",
    serviceName: "Consultation",
    patientName: "Wanjiru",
    status: "confirmed",
    ...overrides,
  };
}

function digest(appointments: MorningAppointment[]): StaffMorningDigest {
  return { window, appointments };
}

describe("renderStaffMorningDigest", () => {
  it("groups the day by provider, times first", () => {
    const text = renderStaffMorningDigest(
      "Afyanex",
      digest([
        appointment(),
        appointment({
          appointmentId: "apt_2",
          start: new Date("2026-08-17T06:30:00Z"),
          patientName: "Faith",
          status: "pending_deposit",
        }),
        appointment({
          appointmentId: "apt_3",
          start: new Date("2026-08-17T07:00:00Z"),
          providerId: "prv_2",
          providerName: "Dr. Kamau",
          patientName: null,
        }),
      ]),
    );

    expect(text).toContain("Afyanex — Monday 17 August");
    expect(text).toContain("3 appointment(s) today");
    expect(text).toContain("Dr. Otieno (2)");
    expect(text).toContain("  09:00  Wanjiru — Consultation");
    expect(text).toContain("  09:30  Faith — Consultation (deposit pending)");
    expect(text).toContain("Dr. Kamau (1)");
    expect(text).toContain("  10:00  Patient — Consultation");
  });

  it("says so plainly when the day is empty", () => {
    expect(renderStaffMorningDigest("Afyanex", digest([]))).toContain(
      "No appointments booked today.",
    );
  });
});

describe("renderStaffMorningHeadline", () => {
  it("fits the day into one template parameter", () => {
    const headline = renderStaffMorningHeadline(digest([appointment()]));
    expect(headline).toBe("1 appointment(s) today, first at 09:00.");
    expect(headline).not.toMatch(/[\r\n\t]/);
  });

  it("handles an empty day", () => {
    expect(renderStaffMorningHeadline(digest([]))).toBe("No appointments booked today.");
  });
});
