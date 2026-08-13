import { describe, expect, it } from "vitest";
import { metadataToSummary } from "../src/collection-kv";
import type { ContextCollectionMetadata } from "../src/context-types";

function metadata(overrides: Partial<ContextCollectionMetadata> = {}): ContextCollectionMetadata {
  return {
    id: "abc123",
    title: "Finance",
    description: "Finance department truth.",
    visibility: "public",
    created: new Date("2026-08-13T00:00:00Z"),
    lastUpdated: new Date("2026-08-13T00:00:00Z"),
    documentCount: 3,
    content: { source: "web" },
    ...overrides,
  };
}

describe("metadataToSummary", () => {
  it("carries the canonical mark through to the summary", () => {
    expect(metadataToSummary(metadata({ canonical: true })).canonical).toBe(true);
  });

  it("omits canonical entirely when unset, keeping KV snapshots unchanged", () => {
    let summary = metadataToSummary(metadata());
    expect("canonical" in summary).toBe(false);
    // The mark survives the JSON round trip the registry writes to KV.
    let roundTripped = JSON.parse(JSON.stringify(metadataToSummary(metadata({ canonical: true }))));
    expect(roundTripped.canonical).toBe(true);
  });
});
