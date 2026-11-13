import { describe, expect, it } from "vitest";
import { createLease, type LeaseConnection } from "../../src/hosted/lease.js";

/** A fake database where one connection at a time can hold the lock; it is released when that connection ends. */
function fakeDb() {
  let holder: object | null = null;
  const conns: Array<LeaseConnection & { kill(): void; ended: boolean }> = [];
  const connect = async () => {
    const id = {};
    const listeners: Record<string, () => void> = {};
    const conn = {
      ended: false,
      async query(sql: string) {
        if (conn.ended) throw new Error("connection closed");
        if (sql.startsWith("select pg_try_advisory_lock")) {
          if (holder === null || holder === id) {
            holder = id;
            return { rows: [{ ok: true }] };
          }
          return { rows: [{ ok: false }] };
        }
        return { rows: [] };
      },
      on(event: "error" | "end", fn: () => void) {
        listeners[event] = fn;
      },
      async end() {
        conn.ended = true;
        if (holder === id) holder = null;
      },
      kill() {
        conn.ended = true;
        if (holder === id) holder = null;
        listeners.end?.();
      },
    };
    conns.push(conn);
    return conn;
  };
  return { connect, conns };
}

describe("service lease", () => {
  it("lets one service sign and keeps the other waiting", async () => {
    const db = fakeDb();
    const a = createLease(db.connect);
    const b = createLease(db.connect);
    expect(await a.ensure()).toBe(true);
    expect(await b.ensure()).toBe(false);
    expect(await a.ensure()).toBe(true); // still the holder on the next round
    expect(await b.ensure()).toBe(false);
  });

  it("hands over when the holder stops", async () => {
    const db = fakeDb();
    const a = createLease(db.connect);
    const b = createLease(db.connect);
    await a.ensure();
    expect(await b.ensure()).toBe(false);
    await a.close();
    expect(await b.ensure()).toBe(true);
  });

  it("stops signing when its own connection dies, and takes the lock again only when free", async () => {
    const db = fakeDb();
    const a = createLease(db.connect);
    expect(await a.ensure()).toBe(true);
    db.conns[0]!.kill();
    const other = createLease(db.connect);
    expect(await other.ensure()).toBe(true); // the lock was freed with the dead connection
    expect(await a.ensure()).toBe(false); // a reconnects, but the lock is taken
  });

  it("does not sign when the database cannot be reached", async () => {
    const lease = createLease(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await lease.ensure()).toBe(false);
  });
});
