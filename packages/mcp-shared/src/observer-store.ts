// What a facet remembers in order to admit observers under the `same-account` sharing policy: every
// distinct read-only call it has made (the thing an observer's own account must be able to repeat),
// and each admitted observer with how far through that log their account has been verified.
//
// The log is append-only and bounded. Past the bound it stops recording and latches an overflow
// flag, after which no new observer can be verified against it: a log with gaps could only ever
// prove part of what was read. Reads are recorded under every policy, so a deployment that later
// moves an endpoint to `same-account` is checking the whole history and not just what came after.
//
// Observers are stored by account object id, never as a stub: a Durable Object stub does not
// survive persistence in production, and the facet lives in the same Worker as the account it names,
// so an id is all it needs to reach that account again.

import { canonicalJson } from "./util.js";

/** Distinct (tool, arguments) pairs retained. Each one is a call an observer must be able to make. */
export const MAX_LOGGED_READS = 200;

/** Longest argument rendering retained. Beyond this the log overflows rather than truncating. */
export const MAX_READ_ARGUMENT_BYTES = 64 * 1024;

const encoder = new TextEncoder();

export type LoggedRead = {
  id: number;
  toolName: string;
  args: Record<string, unknown>;
};

export type ObserverRecord = {
  observerId: string;
  /** Empty for an observer admitted without an account check (the `public` policy). */
  accountObjectId: string;
  /** Highest `LoggedRead.id` this observer's account has been verified against. */
  verifiedThrough: number;
  /** When the whole log was last replayed on this observer's account. */
  verifiedAt: number;
};

/** Outcome of recording one read. `overflow` means it was not recorded and never will be. */
export type RecordedRead =
  | { overflow: false; id: number; isNew: boolean }
  | { overflow: true };

type ReadRow = { id: number; tool_name: string; args_json: string };
type ObserverRow = {
  observer_id: string;
  account_object_id: string;
  verified_through: number;
  verified_at: number;
};

const OVERFLOW_KEY = "overflowed";

/** Stores the read log and the observer roster in one facet-local SQLite database. */
export class ObserverStore {
  #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS mcp_reads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL CHECK (json_valid(args_json) AND json_type(args_json) = 'object'),
      first_seen INTEGER NOT NULL,
      UNIQUE (tool_name, args_json)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS mcp_read_log_state (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS mcp_observers (
      observer_id TEXT PRIMARY KEY,
      account_object_id TEXT NOT NULL,
      verified_through INTEGER NOT NULL,
      verified_at INTEGER NOT NULL
    )`);
  }

  // ── read log ───────────────────────────────────────────────────────────────

  /** Whether the log has stopped recording. Latched: once true, always true. */
  overflowed(): boolean {
    const rows = this.#sql
      .exec<{ value: number }>(`SELECT value FROM mcp_read_log_state WHERE key = ?`, OVERFLOW_KEY)
      .toArray();
    return rows.length > 0 && rows[0].value === 1;
  }

  #latchOverflow(): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO mcp_read_log_state (key, value) VALUES (?, 1)`, OVERFLOW_KEY);
  }

  /**
   * Records one read-only call. Arguments are canonicalised so key order does not make two copies
   * of the same call. An unrepresentable or oversized argument set, or a full log, latches overflow.
   */
  recordRead(toolName: string, args: Record<string, unknown>): RecordedRead {
    if (this.overflowed()) return { overflow: true };

    let argsJson: string;
    try {
      argsJson = canonicalJson(args);
    } catch {
      this.#latchOverflow();
      return { overflow: true };
    }
    if (encoder.encode(argsJson).byteLength > MAX_READ_ARGUMENT_BYTES) {
      this.#latchOverflow();
      return { overflow: true };
    }

    const existing = this.#sql
      .exec<{ id: number }>(
        `SELECT id FROM mcp_reads WHERE tool_name = ? AND args_json = ?`, toolName, argsJson)
      .toArray();
    if (existing.length > 0) return { overflow: false, id: existing[0].id, isNew: false };

    const count = this.#sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM mcp_reads`).one().n;
    if (count >= MAX_LOGGED_READS) {
      this.#latchOverflow();
      return { overflow: true };
    }

    const inserted = this.#sql
      .exec<{ id: number }>(
        `INSERT INTO mcp_reads (tool_name, args_json, first_seen) VALUES (?, ?, ?) RETURNING id`,
        toolName, argsJson, Date.now())
      .one();
    return { overflow: false, id: inserted.id, isNew: true };
  }

  /** Every recorded read with an id above `afterId`, oldest first. */
  readsAfter(afterId: number): LoggedRead[] {
    return this.#sql
      .exec<ReadRow>(
        `SELECT id, tool_name, args_json FROM mcp_reads WHERE id > ? ORDER BY id ASC`, afterId)
      .toArray()
      .map(row => ({
        id: row.id,
        toolName: row.tool_name,
        args: JSON.parse(row.args_json) as Record<string, unknown>,
      }));
  }

  // ── observers ──────────────────────────────────────────────────────────────

  getObserver(observerId: string): ObserverRecord | undefined {
    const rows = this.#sql
      .exec<ObserverRow>(`SELECT * FROM mcp_observers WHERE observer_id = ?`, observerId)
      .toArray();
    return rows.length > 0 ? fromObserverRow(rows[0]) : undefined;
  }

  listObservers(): ObserverRecord[] {
    return this.#sql
      .exec<ObserverRow>(`SELECT * FROM mcp_observers ORDER BY observer_id ASC`)
      .toArray()
      .map(fromObserverRow);
  }

  putObserver(record: ObserverRecord): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO mcp_observers
         (observer_id, account_object_id, verified_through, verified_at)
       VALUES (?, ?, ?, ?)`,
      record.observerId, record.accountObjectId, record.verifiedThrough, record.verifiedAt);
  }

  deleteObserver(observerId: string): void {
    this.#sql.exec(`DELETE FROM mcp_observers WHERE observer_id = ?`, observerId);
  }
}

function fromObserverRow(row: ObserverRow): ObserverRecord {
  return {
    observerId: row.observer_id,
    accountObjectId: row.account_object_id,
    verifiedThrough: row.verified_through,
    verifiedAt: row.verified_at,
  };
}
