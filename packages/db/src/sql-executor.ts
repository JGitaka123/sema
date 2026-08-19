/**
 * The narrowest thing that can run a statement.
 *
 * `with-tenant.ts` deliberately types its client as `query(): Promise<unknown>`
 * so the transaction semantics can be unit tested against a fake. The helpers
 * in this package that actually need to *read* a result need a little more
 * than that, without pulling in the whole of `pg.ClientBase` — which would tie
 * their tests to a live driver.
 *
 * A real `pg.Pool` and a real `pg.PoolClient` both satisfy this.
 */
export interface QueryResultLike<R> {
  rows: R[];
  rowCount: number | null;
}

export interface SqlExecutor {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResultLike<R>>;
}
