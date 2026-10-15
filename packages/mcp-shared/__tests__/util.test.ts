import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/util.js";

describe("canonicalJson", () => {
  it("renders the same value the same way regardless of key order, at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } }))
      .toBe(canonicalJson({ a: { c: null, d: [{ y: 2, z: 1 }] }, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("drops undefined members like JSON.stringify and keeps array order", () => {
    expect(canonicalJson({ a: undefined, b: [3, 1, 2] })).toBe('{"b":[3,1,2]}');
  });

  it("honours toJSON", () => {
    expect(canonicalJson({ when: new Date(0) })).toBe('{"when":"1970-01-01T00:00:00.000Z"}');
  });

  it("refuses what JSON cannot carry", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/circular/i);
    expect(() => canonicalJson({ n: 1n })).toThrow();
  });
});
