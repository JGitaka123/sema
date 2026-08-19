import type { Scheduler } from "@sema/scheduling";
import { fixedClock } from "@sema/shared";
import { getTableName } from "drizzle-orm";

import type {
  AgentTurn,
  AssistantBlock,
  ConverseRequest,
  EngineClient,
  StructuredRequest,
} from "./client.js";
import type { AgentContext } from "./context.js";
import type { AgentDeps } from "./agent.js";
import type { AuditRecord, DepositRequester, ToolRuntime } from "./tools/types.js";

/**
 * Fakes for the agent's dependencies.
 *
 * These exist so the whole of Phase 5 — the loop, the budgets, the loop
 * detection, the guardrails, the tool validation and the audit trail — is
 * testable with no API key, no Postgres and no Redis. That matters more here
 * than in most packages: the evals in `evals/` are the *behavioural* net and
 * they need credentials and a nightly run, so the *structural* net has to run
 * on every commit or it does not run at all (docs/TESTING.md §1).
 *
 * Exported from the package so later phases (the inbox in Phase 8, reminders in
 * Phase 7) can drive a conversation without standing anything up.
 */

// ── Model ────────────────────────────────────────────────────────────────────

export interface ScriptedTurn {
  /** Text the model "writes". Omit for a pure tool-call turn. */
  readonly text?: string;
  readonly toolCalls?: readonly { name: string; input: unknown; id?: string }[];
}

export interface FakeModelClient extends EngineClient {
  readonly converseCalls: ConverseRequest[];
  readonly structuredCalls: StructuredRequest[];
}

export interface FakeModelOptions {
  /** One entry per `converse` call, in order. The last repeats if exhausted. */
  readonly turns: readonly ScriptedTurn[];
  /** Thrown instead of answering, by zero-based call index. */
  readonly failAt?: ReadonlyMap<number, unknown>;
  /** What the guardrail's advice check answers. Defaults to "no advice". */
  readonly saysAdvice?: boolean;
  /** Overrides `structured` entirely (summaries, malformed output tests). */
  readonly structuredText?: string;
}

export function fakeModelClient(options: FakeModelOptions): FakeModelClient {
  const converseCalls: ConverseRequest[] = [];
  const structuredCalls: StructuredRequest[] = [];
  let index = 0;

  return {
    converseCalls,
    structuredCalls,

    async structured(request) {
      structuredCalls.push(request);
      const text =
        options.structuredText ??
        JSON.stringify({ gives_medical_advice: options.saysAdvice ?? false });
      return { text, stopReason: "end_turn", inputTokens: 1, outputTokens: 1 };
    },

    async converse(request) {
      converseCalls.push(request);
      const call = index;
      index += 1;

      const failure = options.failAt?.get(call);
      if (failure !== undefined) throw failure;

      const turn = options.turns[Math.min(call, options.turns.length - 1)] ?? {};
      const blocks: AssistantBlock[] = [];
      for (const [n, tool] of (turn.toolCalls ?? []).entries()) {
        blocks.push({
          type: "tool_use",
          id: tool.id ?? `toolu_${call}_${n}`,
          name: tool.name,
          input: tool.input,
        });
      }
      if (turn.text !== undefined) blocks.push({ type: "text", text: turn.text });
      if (blocks.length === 0) blocks.push({ type: "text", text: "" });

      return { blocks, stopReason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", inputTokens: 1, outputTokens: 1 };
    },
  };
}

/** The turns a `converse` call was given — for asserting what the model saw. */
export function lastMessages(client: FakeModelClient): readonly AgentTurn[] {
  return client.converseCalls[client.converseCalls.length - 1]?.messages ?? [];
}

// ── Audit ────────────────────────────────────────────────────────────────────

export interface AuditSpy {
  readonly records: AuditRecord[];
  readonly write: (record: AuditRecord) => Promise<void>;
}

export function auditSpy(): AuditSpy {
  const records: AuditRecord[] = [];
  return {
    records,
    write: async (record) => {
      records.push(record);
    },
  };
}

// ── Tenant database ──────────────────────────────────────────────────────────

/**
 * A `withTenantDb` that runs the callback against a stub and records the
 * clinic id it was called with.
 *
 * It is not a database. Its job is to prove that every tool goes *through*
 * `withTenantDb` — i.e. that RLS would be in force — and to let tools that only
 * read from the already-loaded context run without one. A tool that actually
 * issues SQL is covered by the integration tests instead.
 */
export interface FakeTenantDb {
  readonly clinicIds: string[];
  readonly withTenantDb: <T>(clinicId: string, work: (db: never) => Promise<T>) => Promise<T>;
  /** Rows each `insert(...).values(...)` was given, keyed by table name. */
  readonly inserts: { table: string; values: unknown }[];
}

/** Drizzle keeps the table name behind a symbol; `getTableName` is the reader. */
function tableNameOf(table: unknown): string {
  try {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  } catch {
    return "unknown";
  }
}

export function fakeTenantDb(): FakeTenantDb {
  const clinicIds: string[] = [];
  const inserts: { table: string; values: unknown }[] = [];

  const db = {
    insert(table: unknown) {
      const name = tableNameOf(table);
      return {
        async values(values: unknown) {
          inserts.push({ table: name, values });
        },
      };
    },
    select() {
      return {
        from() {
          return {
            where() {
              return { limit: async (): Promise<unknown[]> => [] };
            },
          };
        },
      };
    },
    update() {
      return { set: () => ({ where: async (): Promise<void> => undefined }) };
    },
    async execute() {
      return { rows: [] };
    },
  };

  return {
    clinicIds,
    inserts,
    async withTenantDb<T>(clinicId: string, work: (database: never) => Promise<T>): Promise<T> {
      clinicIds.push(clinicId);
      return work(db as never);
    },
  };
}

// ── Scheduler ────────────────────────────────────────────────────────────────

export type SchedulerStub = Scheduler & { readonly calls: { name: string; input: unknown }[] };

/**
 * A scheduler whose methods return canned results (or throw canned errors).
 *
 * Slot maths, hold races and policy evaluation are `@sema/scheduling`'s
 * problem and are tested there against a real Postgres. What the engine tests
 * need to know is what the tools do with the answers.
 */
export function stubScheduler(
  overrides: Partial<Record<keyof Scheduler, (input: unknown) => unknown>> = {},
): SchedulerStub {
  const calls: { name: string; input: unknown }[] = [];
  const method =
    (name: keyof Scheduler) =>
    async (input: unknown): Promise<unknown> => {
      calls.push({ name, input });
      const override = overrides[name];
      if (!override) throw new Error(`stubScheduler: ${name} was not stubbed`);
      const result = override(input);
      return result instanceof Promise ? result : result;
    };

  return {
    calls,
    searchSlots: method("searchSlots") as Scheduler["searchSlots"],
    holdSlot: method("holdSlot") as Scheduler["holdSlot"],
    book: method("book") as Scheduler["book"],
    reschedule: method("reschedule") as Scheduler["reschedule"],
    cancel: method("cancel") as Scheduler["cancel"],
    expireHolds: method("expireHolds") as Scheduler["expireHolds"],
  } as SchedulerStub;
}

// ── Context ──────────────────────────────────────────────────────────────────

/** A frozen Afyanex-shaped context. Overridable field by field. */
export function testContext(overrides: Partial<AgentContext> = {}): AgentContext {
  const now = overrides.now ?? new Date("2026-08-20T07:00:00Z"); // 10:00 Nairobi, a Thursday
  return {
    clinic: {
      id: "cli_00000000000000000000000001",
      name: "Afyanex Clinic",
      timezone: "Africa/Nairobi",
      currency: "KES",
      defaultLanguage: "en",
      specialty: "General practice",
    },
    policies: {
      freeRescheduleHours: 24,
      forfeitHours: 2,
      bookingWindowDays: 30,
      minNoticeMin: 60,
    },
    knowledge: [
      {
        category: "hours",
        title: "Opening hours",
        body: "Monday to Friday 8:00am–5:00pm. Saturday 9:00am–1:00pm. Closed on Sundays.",
      },
      {
        category: "location",
        title: "Where we are",
        body: "2nd Floor, Wood Avenue Plaza, Kilimani, Nairobi.",
      },
      {
        category: "pricing",
        title: "Consultation fees",
        body: "GP consultation KES 2,000. Dental scaling and polishing KES 4,500.",
      },
      {
        category: "policies",
        title: "Cancellations",
        body: "Reschedule or cancel free of charge up to 24 hours before your appointment.",
      },
    ],
    services: [
      {
        id: "svc_00000000000000000000000001",
        name: "GP consultation",
        category: "consultation",
        durationMin: 20,
        priceMinor: 200_000,
        priceNote: null,
        depositMinor: 0,
        description: "See a general practitioner.",
        prepInstructions: null,
        intakeQuestions: [],
      },
      {
        id: "svc_00000000000000000000000002",
        name: "Dental scaling and polishing",
        category: "dental",
        durationMin: 45,
        priceMinor: 450_000,
        priceNote: null,
        depositMinor: 150_000,
        description: "Professional cleaning, scaling and polishing.",
        prepInstructions: "Brush before you come.",
        intakeQuestions: ["Have you had a dental cleaning with us before?"],
      },
    ],
    providers: [
      {
        id: "prv_00000000000000000000000001",
        displayName: "Dr. Wanjiru Kamau",
        title: "MBChB",
        specialty: "General practice",
        bio: "General practitioner, 12 years in family medicine.",
        serviceIds: ["svc_00000000000000000000000001"],
      },
      {
        id: "prv_00000000000000000000000002",
        displayName: "Dr. Samuel Otieno",
        title: "BDS",
        specialty: "Dentistry",
        bio: "Dental surgeon.",
        serviceIds: ["svc_00000000000000000000000002"],
      },
    ],
    locations: [
      {
        id: "loc_00000000000000000000000001",
        name: "Afyanex Clinic — Kilimani",
        address: "2nd Floor, Wood Avenue Plaza, Kilimani, Nairobi",
        mapsUrl: "https://maps.example/afyanex-kilimani",
        phone: "+254709000100",
        lat: -1.2921,
        lng: 36.7833,
        isPrimary: true,
      },
    ],
    hours: [
      {
        providerId: "prv_00000000000000000000000001",
        providerName: "Dr. Wanjiru Kamau",
        summary: "Mon–Fri 8:00am–5:00pm; Sat 9:00am–1:00pm",
      },
    ],
    patient: {
      id: "pat_00000000000000000000000001",
      firstName: "Achieng",
      language: "en",
      noShowCount: 0,
      isVip: false,
      isBlocked: false,
      upcoming: [],
    },
    conversationId: "conv_00000000000000000000000001",
    history: [],
    summary: null,
    historyTruncated: false,
    openHolds: [],
    agentTurnsToday: 0,
    now,
    ...overrides,
  };
}

// ── Deps ─────────────────────────────────────────────────────────────────────

export interface TestAgentDeps extends AgentDeps {
  readonly db: FakeTenantDb;
  readonly deposits: { readonly requests: unknown[] };
}

export function testAgentDeps(
  client: EngineClient,
  options: { scheduler?: Scheduler; now?: Date } = {},
): TestAgentDeps {
  const db = fakeTenantDb();
  const requests: unknown[] = [];
  const depositRequester: DepositRequester = {
    async request(input) {
      requests.push(input);
      return { status: "requested", paymentRequestId: "pyr_test", simulated: true };
    },
  };

  return {
    client,
    withTenantDb: db.withTenantDb as never,
    scheduler: options.scheduler ?? stubScheduler(),
    clock: fixedClock(options.now ?? new Date("2026-08-20T07:00:00Z")),
    depositRequester,
    db,
    deposits: { requests },
  };
}

/** A `ToolRuntime` for testing one tool in isolation. */
export function testToolRuntime(
  deps: TestAgentDeps,
  context: AgentContext,
  audit: AuditSpy,
): ToolRuntime {
  return {
    clinicId: context.clinic.id,
    conversationId: context.conversationId,
    patientId: context.patient.id,
    context,
    deps: {
      withTenantDb: deps.withTenantDb,
      scheduler: deps.scheduler,
      clock: deps.clock,
      depositRequester: deps.depositRequester,
    },
    audit: audit.write,
  };
}
