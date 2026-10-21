import { Pool } from "pg";

// Neon Postgres access — deliberately LAZY: the pool is only created when
// the first query runs, so the server boots and serves /api/health even
// with no DATABASE_URL set (local gateway testing works DB-free). Any
// DB-backed route attempted without DATABASE_URL fails with a clear error
// at query time, which route handlers turn into a 500 JSON response.

let pool: Pool | null = null;

function getPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set — database-backed features are unavailable",
    );
  }
  if (!pool) {
    pool = new Pool({ connectionString: url });
  }
  return pool;
}

export interface QueryOutput<T> {
  rows: T[];
  rowCount: number;
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<QueryOutput<T>> {
  const result = await getPool().query(text, params);
  return {
    rows: result.rows as T[],
    rowCount: result.rowCount ?? 0,
  };
}
