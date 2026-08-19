import { maskPhone } from "@sema/shared";
import { describe, expect, it } from "vitest";

import { assertNoPhi, createRecordingLogger } from "./logging.js";
import { reminderTemplateParameters } from "./templates.js";

/**
 * Hard rule 4: no PHI in logs.
 *
 * `assertNoPhi` is the assertion the integration suite runs against a real
 * sweep's log output. Tested here that it actually *fails* on unmasked data —
 * an assertion that cannot fail is worse than none, because it reads like
 * coverage.
 */

const PHONE = "+254712345678";
const NAME = "Wanjiru Mwangi";

describe("assertNoPhi", () => {
  it("passes on a masked phone number", () => {
    expect(() =>
      assertNoPhi(JSON.stringify({ phone: maskPhone(PHONE) }), { phone: PHONE }),
    ).not.toThrow();
  });

  it("fails on a raw phone number", () => {
    expect(() => assertNoPhi(JSON.stringify({ phone: PHONE }), { phone: PHONE })).toThrow(/leaked/);
  });

  it("fails on the digits alone, without the plus", () => {
    expect(() => assertNoPhi("wa_id 254712345678", { phone: PHONE })).toThrow(/leaked/);
  });

  it("fails on the subscriber part alone", () => {
    expect(() => assertNoPhi("...712345678...", { phone: PHONE })).toThrow(/leaked/);
  });

  it("fails on a patient name", () => {
    expect(() => assertNoPhi(`{"who":"Wanjiru"}`, { phone: PHONE, name: NAME })).toThrow(/leaked/);
  });
});

describe("recording logger", () => {
  it("keeps what it was given and flattens it the way a sink would", () => {
    const log = createRecordingLogger();
    log.info({ reminderId: "rem_1" }, "reminder queued");
    log.warn({ reminderId: "rem_2" }, "reminder failed");

    expect(log.entries).toHaveLength(2);
    expect(log.entries[0]?.level).toBe("info");
    expect(log.serialised()).toContain("reminder queued");
    expect(log.serialised()).toContain("rem_2");
  });

  it("shows the masking a reminder send does before it logs", () => {
    const log = createRecordingLogger();
    log.info({ reminderId: "rem_1", patientPhone: maskPhone(PHONE) }, "reminder queued");
    expect(() => assertNoPhi(log.serialised(), { phone: PHONE })).not.toThrow();
    expect(log.serialised()).toContain(maskPhone(PHONE));
    expect(maskPhone(PHONE)).toBe("+254••••••678");
  });
});

describe("template parameters are PHI, and never logged", () => {
  it("carries the patient's name — which is exactly why they stay out of logs", () => {
    const params = reminderTemplateParameters("pre_2h", {
      to: PHONE,
      patientName: NAME,
      serviceName: "Consultation",
      providerName: "Dr. Otieno",
      locationName: null,
      start: new Date("2026-08-17T06:00:00Z"),
      timezone: "Africa/Nairobi",
      language: "en",
    });
    // The guard has teeth: the parameters would fail the assertion, so the
    // audit row and the log line must never contain them (see `send.ts`).
    expect(() => assertNoPhi(JSON.stringify(params), { phone: PHONE, name: NAME })).toThrow();
  });
});
