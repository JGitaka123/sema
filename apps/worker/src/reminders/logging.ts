/**
 * The logging surface the reminder jobs use.
 *
 * Narrow on purpose. `pino` is what the worker actually passes in, but a job
 * that took a `pino.Logger` could not be handed a recording fake in a test, and
 * "does this job ever log a raw phone number?" (hard rule 4) is a question the
 * test suite has to be able to ask.
 *
 * The contract for callers: **fields must already be safe**. Phone numbers go
 * through `maskPhone` at the call site rather than relying on the redaction
 * paths configured in `apps/worker/src/index.ts`, because redaction matches on
 * key names and a field named `patientPhone` would sail straight through.
 */

export type LogFields = Record<string, unknown>;

export interface JobLogger {
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
}

export const silentLogger: JobLogger = {
  info: () => undefined,
  warn: () => undefined,
};

export interface RecordedLog {
  readonly level: "info" | "warn";
  readonly fields: LogFields;
  readonly message: string;
}

export interface RecordingLogger extends JobLogger {
  readonly entries: readonly RecordedLog[];
  /** Everything logged, flattened to one string — what a log sink would see. */
  serialised(): string;
}

/** A `JobLogger` that keeps what it was given, for PHI assertions. */
export function createRecordingLogger(): RecordingLogger {
  const entries: RecordedLog[] = [];
  return {
    entries,
    info: (fields, message) => entries.push({ level: "info", fields, message }),
    warn: (fields, message) => entries.push({ level: "warn", fields, message }),
    serialised: () => entries.map((e) => JSON.stringify(e)).join("\n"),
  };
}

/**
 * Identifying data a log line must not contain.
 *
 * Lives beside the logger rather than in a test file so both the unit suite and
 * the Postgres suite can use the one definition of "leaked", the way
 * `packages/engine/src/notifier.ts` ships its recording implementation next to
 * the interface. docs/TESTING.md, "Definition of done per feature": *no PHI in
 * logs (grep test on log output in integration tests)*.
 */
export interface PhiSample {
  readonly phone: string;
  readonly name?: string | null;
}

/** Throws when `serialised` contains anything identifying from `sample`. */
export function assertNoPhi(serialised: string, sample: PhiSample): void {
  const digits = sample.phone.replace(/\D/g, "");
  const forbidden = [sample.phone, digits, digits.slice(-9)];
  if (sample.name) forbidden.push(sample.name, ...sample.name.split(/\s+/));

  for (const needle of forbidden) {
    // Fragments shorter than this match ids and words by coincidence, which
    // would make the assertion fail for the wrong reason.
    if (needle.length < 4) continue;
    if (serialised.includes(needle)) {
      throw new Error(`log output leaked PHI: ${JSON.stringify(needle)}`);
    }
  }
}
