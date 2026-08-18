import { AppError, newId } from "@sema/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertSameTenant,
  createWithTenant,
  type ClinicId,
  type PooledTenantClient,
  type TenantPool,
} from "./with-tenant.js";

interface FakeClient extends PooledTenantClient {
  calls: Array<{ sql: string; params: unknown[] | undefined }>;
  released: number;
  releasedWithError: boolean;
}

function fakeClient(behaviour: (sql: string) => unknown = () => ({ rows: [] })): FakeClient {
  const client: FakeClient = {
    calls: [],
    released: 0,
    releasedWithError: false,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      client.calls.push({ sql, params });
      return behaviour(sql);
    }),
    release: vi.fn((err?: boolean) => {
      client.released += 1;
      if (err) client.releasedWithError = true;
    }),
  };
  return client;
}

function fakePool(client: FakeClient): TenantPool {
  return { connect: async () => client };
}

let clinicId: ClinicId;

beforeEach(() => {
  clinicId = newId("clinic");
});

describe("createWithTenant", () => {
  it("wraps the work in a transaction and sets the tenant GUC first", async () => {
    const client = fakeClient();
    const withTenant = createWithTenant(fakePool(client));

    await withTenant(clinicId, async (tx) => {
      await tx.query("select 1");
      return "done";
    });

    expect(client.calls.map((c) => c.sql)).toEqual([
      "begin",
      "select set_config('app.current_clinic', $1, true)",
      "select 1",
      "commit",
    ]);
  });

  it("passes the clinic id as a bound parameter, never interpolated", async () => {
    const client = fakeClient();
    const withTenant = createWithTenant(fakePool(client));

    await withTenant(clinicId, async () => undefined);

    const setConfig = client.calls[1];
    expect(setConfig?.params).toEqual([clinicId]);
    expect(setConfig?.sql).not.toContain(clinicId);
  });

  it("scopes the setting to the transaction so pooled connections cannot leak it", async () => {
    const client = fakeClient();
    const withTenant = createWithTenant(fakePool(client));

    await withTenant(clinicId, async () => undefined);

    // The third argument of set_config being `true` is what makes it local.
    expect(client.calls[1]?.sql).toContain(", true)");
  });

  it("returns the value the work produced", async () => {
    const withTenant = createWithTenant(fakePool(fakeClient()));
    await expect(withTenant(clinicId, async () => 42)).resolves.toBe(42);
  });

  it("releases the connection on success", async () => {
    const client = fakeClient();
    const withTenant = createWithTenant(fakePool(client));

    await withTenant(clinicId, async () => undefined);

    expect(client.released).toBe(1);
    expect(client.releasedWithError).toBe(false);
  });

  it("rolls back and releases when the work throws", async () => {
    const client = fakeClient();
    const withTenant = createWithTenant(fakePool(client));

    await expect(
      withTenant(clinicId, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrowError(AppError);

    expect(client.calls.map((c) => c.sql)).toContain("rollback");
    expect(client.calls.map((c) => c.sql)).not.toContain("commit");
    expect(client.released).toBe(1);
  });

  it("wraps unknown throwables as AppError without losing the cause", async () => {
    const original = new Error("underlying failure");
    const withTenant = createWithTenant(fakePool(fakeClient()));

    const error = await withTenant(clinicId, async () => {
      throw original;
    }).catch((e: unknown) => e as AppError);

    expect(AppError.is(error)).toBe(true);
    expect(error.code).toBe("INTERNAL");
    expect(error.cause).toBe(original);
  });

  it("preserves an AppError thrown by the work", async () => {
    const withTenant = createWithTenant(fakePool(fakeClient()));

    const error = await withTenant(clinicId, async () => {
      throw new AppError("NOT_FOUND", "no such patient");
    }).catch((e: unknown) => e as AppError);

    expect(error.code).toBe("NOT_FOUND");
  });

  it("discards a connection whose rollback also failed", async () => {
    const client = fakeClient((sql) => {
      if (sql === "rollback") throw new Error("connection lost");
      return { rows: [] };
    });
    const withTenant = createWithTenant(fakePool(client));

    await expect(
      withTenant(clinicId, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrowError(AppError);

    expect(client.releasedWithError).toBe(true);
    expect(client.released).toBe(1);
  });

  it("rolls back when commit itself fails", async () => {
    const client = fakeClient((sql) => {
      if (sql === "commit") throw new Error("serialisation failure");
      return { rows: [] };
    });
    const withTenant = createWithTenant(fakePool(client));

    await expect(withTenant(clinicId, async () => undefined)).rejects.toThrowError(AppError);
    expect(client.calls.map((c) => c.sql)).toContain("rollback");
  });
});

describe("createWithTenant tenant guard", () => {
  it.each([
    ["empty string", ""],
    ["undefined coerced by a caller bug", undefined as unknown as string],
    ["an id of another entity", newId("patient")],
    ["a bare ulid", "01J8XYZ00000000000000000AB"],
    ["sql-ish junk", "'; drop table patient; --"],
  ])("refuses to open a transaction for %s", async (_label, badId) => {
    const client = fakeClient();
    const withTenant = createWithTenant(fakePool(client));
    const work = vi.fn();

    const error = await withTenant(badId, work).catch((e: unknown) => e as AppError);

    expect(AppError.is(error)).toBe(true);
    expect(error.code).toBe("TENANT_MISSING");
    // Critically: no connection was taken and no statement ran.
    expect(work).not.toHaveBeenCalled();
    expect(client.calls).toHaveLength(0);
  });
});

describe("assertSameTenant", () => {
  it("passes for a matching clinic", () => {
    expect(() => assertSameTenant(clinicId, clinicId)).not.toThrow();
  });

  it("throws TENANT_MISMATCH for another clinic, null or undefined", () => {
    const other = newId("clinic");
    for (const value of [other, null, undefined]) {
      const error = (() => {
        try {
          assertSameTenant(clinicId, value);
          return undefined;
        } catch (e) {
          return e as AppError;
        }
      })();
      expect(error?.code).toBe("TENANT_MISMATCH");
    }
  });
});
