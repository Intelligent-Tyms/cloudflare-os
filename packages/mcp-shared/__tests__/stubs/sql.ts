// An in-memory stand-in for a Durable Object's `SqlStorage`, enough for the stores under test:
// `exec()` with positional bindings, `toArray()`, and `one()`.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export function fakeSql(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  return {
    exec<T>(query: string, ...bindings: SQLInputValue[]) {
      const rows = bindings.length > 0
        ? db.prepare(query).all(...bindings)
        : /^\s*(?:SELECT|INSERT.*RETURNING)/is.test(query)
          ? db.prepare(query).all()
          : (db.exec(query), []);
      return {
        toArray: () => rows as T[],
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}`);
          return rows[0] as T;
        },
      };
    },
  } as unknown as SqlStorage;
}
