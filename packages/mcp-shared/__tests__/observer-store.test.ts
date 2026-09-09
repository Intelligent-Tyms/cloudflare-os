import { describe, expect, it } from "vitest";

import { MAX_LOGGED_READS, ObserverStore } from "../src/observer-store.js";
import { fakeSql } from "./stubs/sql.js";

describe("ObserverStore read log", () => {
  it("records each distinct read once, whatever the argument key order", () => {
    const store = new ObserverStore(fakeSql());
    const first = store.recordRead("get_account", { id: "a1", fields: ["balance"] });
    const again = store.recordRead("get_account", { fields: ["balance"], id: "a1" });
    const other = store.recordRead("get_account", { id: "a2" });

    expect(first).toMatchObject({ overflow: false, isNew: true });
    expect(again).toEqual({ overflow: false, id: (first as { id: number }).id, isNew: false });
    expect(other).toMatchObject({ overflow: false, isNew: true });
    expect(store.readsAfter(0).map(read => read.args)).toEqual([
      { fields: ["balance"], id: "a1" }, { id: "a2" },
    ]);
  });

  it("returns only the reads made after a watermark, oldest first", () => {
    const store = new ObserverStore(fakeSql());
    const a = store.recordRead("a", {}) as { id: number };
    store.recordRead("b", {});
    store.recordRead("c", {});
    expect(store.readsAfter(a.id).map(read => read.toolName)).toEqual(["b", "c"]);
  });

  it("latches overflow past the bound and stops recording for good", () => {
    const store = new ObserverStore(fakeSql());
    for (let i = 0; i < MAX_LOGGED_READS; i++) {
      expect(store.recordRead("list", { page: i })).toMatchObject({ overflow: false });
    }
    expect(store.overflowed()).toBe(false);
    expect(store.recordRead("list", { page: "one too many" })).toEqual({ overflow: true });
    expect(store.overflowed()).toBe(true);
    // A read seen before still reports overflow: the log can no longer vouch for the whole history.
    expect(store.recordRead("list", { page: 0 })).toEqual({ overflow: true });
    expect(store.readsAfter(0)).toHaveLength(MAX_LOGGED_READS);
  });

  it("latches overflow on arguments it cannot represent", () => {
    const store = new ObserverStore(fakeSql());
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(store.recordRead("x", cyclic)).toEqual({ overflow: true });
    expect(store.overflowed()).toBe(true);
  });

  it("latches overflow on oversized arguments", () => {
    const store = new ObserverStore(fakeSql());
    expect(store.recordRead("x", { blob: "y".repeat(70 * 1024) })).toEqual({ overflow: true });
    expect(store.overflowed()).toBe(true);
  });
});

describe("ObserverStore roster", () => {
  it("upserts, lists, and deletes observers", () => {
    const store = new ObserverStore(fakeSql());
    store.putObserver({ observerId: "o1", accountObjectId: "acc1", verifiedThrough: 3, verifiedAt: 10 });
    store.putObserver({ observerId: "o2", accountObjectId: "", verifiedThrough: 0, verifiedAt: 11 });
    store.putObserver({ observerId: "o1", accountObjectId: "acc1", verifiedThrough: 5, verifiedAt: 12 });

    expect(store.getObserver("o1")).toEqual({
      observerId: "o1", accountObjectId: "acc1", verifiedThrough: 5, verifiedAt: 12,
    });
    expect(store.listObservers().map(observer => observer.observerId)).toEqual(["o1", "o2"]);

    store.deleteObserver("o1");
    expect(store.getObserver("o1")).toBeUndefined();
    expect(store.listObservers()).toHaveLength(1);
  });
});
