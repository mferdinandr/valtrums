/**
 * One hosted service signs for the agents of a database at a time. Two services on the same database would both see an
 * agent as running and both play it: the second deposit, vote or claim is sent from a process the owner never sees in
 * its activity log. The service that holds this Postgres advisory lock runs the rounds; every other one keeps serving
 * requests and waits. The lock belongs to a dedicated connection, so it is released when the holder stops or loses
 * that connection. It needs a session-mode connection (Supabase pooler port 5432, not the transaction pooler 6543).
 */
export interface LeaseConnection {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  on(event: "error" | "end", listener: () => void): void;
  end(): Promise<void>;
}

export interface Lease {
  /** True when this service may sign now. Takes the lock when it is free, and checks the connection while held. */
  ensure(): Promise<boolean>;
  close(): Promise<void>;
}

const LOCK_NAME = "valtrum.hosted-agents";

export function createLease(connect: () => Promise<LeaseConnection>): Lease {
  let conn: LeaseConnection | null = null;
  const drop = async () => {
    const c = conn;
    conn = null;
    await c?.end().catch(() => undefined);
  };
  return {
    async ensure() {
      if (conn) {
        try {
          await conn.query("select 1");
          return true;
        } catch {
          await drop(); // the lock went with the connection: take it again from scratch
        }
      }
      let fresh: LeaseConnection | null = null;
      try {
        fresh = await connect();
        const c = fresh;
        c.on("error", () => {
          if (conn === c) conn = null;
        });
        c.on("end", () => {
          if (conn === c) conn = null;
        });
        const { rows } = await c.query("select pg_try_advisory_lock(hashtextextended($1, 0)) as ok", [LOCK_NAME]);
        if (rows[0]?.ok === true) {
          conn = c;
          return true;
        }
        await c.end().catch(() => undefined);
        return false;
      } catch {
        await fresh?.end().catch(() => undefined);
        return false;
      }
    },
    close: drop,
  };
}
