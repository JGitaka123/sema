/**
 * Reminders, no-show detection and digests (BUILD_PLAN.md Phase 7).
 *
 * The shape of the module:
 *
 *   config.ts        what a clinic may configure, and the defaults
 *   plan.ts          when a reminder is due, when a slot has become a no-show
 *   decide.ts        whether a due reminder may actually be sent
 *   templates.ts     which approved template, with which parameters
 *   repository.ts    every statement
 *   sync.ts          the appointment → reminders reconciler (the Phase 5 seam)
 *   send.ts          claim due reminders and queue them through the outbox
 *   no-show.ts       mark, count, audit, nudge
 *   digest*.ts       period maths, metrics, rendering, delivery seam
 *
 * `plan`, `decide`, `config`, `templates` and `digest-period` are pure and take
 * their "now" as an argument, which is what makes the acceptance criterion —
 * "time-travel tests using a fake clock" — possible without a database.
 */

export * from "./audit.js";
export * from "./config.js";
export * from "./decide.js";
export * from "./digest.js";
export * from "./digest-delivery.js";
export * from "./digest-period.js";
export * from "./digest-run.js";
export * from "./logging.js";
export * from "./no-show.js";
export * from "./plan.js";
export * from "./send.js";
export * from "./sync.js";
export type {
  AppointmentForReminders,
  ClinicReminderSettings,
  DueReminderRow,
  ExistingReminder,
  NoShowCandidate,
} from "./repository.js";
export { REMINDER_TEMPLATES, reminderTemplate, reminderTemplateParameters } from "./templates.js";
