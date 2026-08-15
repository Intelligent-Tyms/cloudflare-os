// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import {
  NO_AGENT_OPTION_VALUE,
  getStoredSelectedModel,
  persistSelectedModel,
  validateModelSelection,
} from "./modelSelection";

const MODELS: AiChatAuthorInfo[] = [
  { type: "agent", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { type: "agent", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
];

beforeEach(() => localStorage.clear());

describe("validateModelSelection", () => {
  it("keeps a selection that is still offered", () => {
    expect(validateModelSelection("claude-haiku-4-5", MODELS)).toBe("claude-haiku-4-5");
  });

  it("keeps the explicit no-agent choice", () => {
    expect(validateModelSelection(null, MODELS)).toBeNull();
    expect(validateModelSelection(null, [])).toBeNull();
  });

  // A chat's inferred model (or an active agent's) can name a model an admin has since disabled
  // or deleted; the server refuses those, so the selection must self-heal instead of sending
  // into a guaranteed error.
  it("falls back to the stored selection when the model is no longer offered", () => {
    persistSelectedModel("claude-haiku-4-5");
    expect(validateModelSelection("claude-opus-5", MODELS)).toBe("claude-haiku-4-5");
  });

  it("falls back to the first offered model when the stored selection is stale too", () => {
    persistSelectedModel("claude-opus-5");
    expect(validateModelSelection("claude-opus-5", MODELS)).toBe("claude-sonnet-5");
  });

  it("returns null when nothing is offered", () => {
    expect(validateModelSelection("claude-opus-5", [])).toBeNull();
  });
});

describe("getStoredSelectedModel", () => {
  it("honors a stored no-agent sentinel", () => {
    localStorage.setItem("lastSelectedModel", NO_AGENT_OPTION_VALUE);
    expect(getStoredSelectedModel(MODELS)).toBeNull();
  });

  it("drops a stored id that is no longer offered", () => {
    persistSelectedModel("claude-opus-5");
    expect(getStoredSelectedModel(MODELS)).toBe("claude-sonnet-5");
  });
});
