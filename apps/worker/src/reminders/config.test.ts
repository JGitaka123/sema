import { describe, expect, it } from "vitest";

import {
  DEFAULT_DIGEST_CONFIG,
  DEFAULT_REMINDER_CONFIG,
  parseDigestConfig,
  parseReminderConfig,
} from "./config.js";

/**
 * `clinic.flags` is operator-editable jsonb. Everything here is really one
 * assertion in different clothes: a clinic cannot switch its patients'
 * reminders off by accident, whatever it puts in that column.
 */

describe("parseReminderConfig", () => {
  it("defaults to 24h and 2h (SPEC §4.4)", () => {
    expect(parseReminderConfig(null)).toEqual(DEFAULT_REMINDER_CONFIG);
    expect(parseReminderConfig({})).toEqual(DEFAULT_REMINDER_CONFIG);
    expect(parseReminderConfig({ reminders: {} })).toEqual(DEFAULT_REMINDER_CONFIG);
  });

  it("survives anything a bad migration or a fat finger could leave behind", () => {
    for (const flags of ["", 7, [], { reminders: "yes" }, { reminders: [] }, undefined]) {
      expect(parseReminderConfig(flags)).toEqual(DEFAULT_REMINDER_CONFIG);
    }
  });

  it("takes clinic-level overrides", () => {
    const config = parseReminderConfig({
      reminders: { pre24hMin: 2880, pre2hMin: 90, noShowAfterMin: 45 },
    });
    expect(config.offsetsMin).toEqual({ pre_24h: 2880, pre_2h: 90 });
    expect(config.noShowAfterMin).toBe(45);
  });

  it("lets `null` switch one reminder off without touching the other", () => {
    const config = parseReminderConfig({ reminders: { pre2hMin: null } });
    expect(config.offsetsMin).toEqual({ pre_24h: 24 * 60, pre_2h: null });
  });

  it("layers a per-service override on top of the clinic's", () => {
    const flags = {
      reminders: {
        pre2hMin: 90,
        services: { svc_scan: { pre24hMin: 48 * 60, pre2hMin: null } },
      },
    };
    expect(parseReminderConfig(flags, "svc_scan").offsetsMin).toEqual({
      pre_24h: 48 * 60,
      pre_2h: null,
    });
    // A service with no entry inherits the clinic's.
    expect(parseReminderConfig(flags, "svc_consult").offsetsMin).toEqual({
      pre_24h: 24 * 60,
      pre_2h: 90,
    });
  });

  it("lets a service opt out of reminders entirely", () => {
    const config = parseReminderConfig(
      { reminders: { services: { svc_walkin: { enabled: false } } } },
      "svc_walkin",
    );
    expect(config.enabled).toBe(false);
  });

  it("ignores out-of-range and non-numeric offsets rather than adopting them", () => {
    for (const bad of [0, -60, 60 * 24 * 365, "1440", Number.NaN, Infinity]) {
      expect(parseReminderConfig({ reminders: { pre24hMin: bad } }).offsetsMin.pre_24h).toBe(
        24 * 60,
      );
    }
  });

  it("caps the no-show grace period at a day", () => {
    expect(parseReminderConfig({ reminders: { noShowAfterMin: 60 * 25 } }).noShowAfterMin).toBe(30);
    expect(parseReminderConfig({ reminders: { noShowAfterMin: 60 * 24 } }).noShowAfterMin).toBe(
      60 * 24,
    );
  });

  it("can turn no-show detection and its nudge off independently", () => {
    expect(parseReminderConfig({ reminders: { noShowEnabled: false } })).toMatchObject({
      noShowEnabled: false,
      noShowRebook: true,
    });
    expect(parseReminderConfig({ reminders: { noShowRebook: false } })).toMatchObject({
      noShowEnabled: true,
      noShowRebook: false,
    });
  });
});

describe("parseDigestConfig", () => {
  it("defaults to a 07:00 morning digest and an 08:00 Monday owner digest", () => {
    expect(parseDigestConfig(null)).toEqual(DEFAULT_DIGEST_CONFIG);
    expect(DEFAULT_DIGEST_CONFIG.ownerWeekday).toBe(1);
  });

  it("takes valid hours and weekdays", () => {
    expect(
      parseDigestConfig({ digests: { morningHour: 6, ownerWeekday: 5, ownerHour: 17 } }),
    ).toEqual({ enabled: true, morningHour: 6, ownerWeekday: 5, ownerHour: 17 });
  });

  it("rejects impossible clock readings", () => {
    const config = parseDigestConfig({
      digests: { morningHour: 24, ownerWeekday: 9, ownerHour: -1 },
    });
    expect(config).toEqual(DEFAULT_DIGEST_CONFIG);
  });
});
