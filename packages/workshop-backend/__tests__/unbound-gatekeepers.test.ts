import { describe, expect, it, vi } from "vitest";
import {
  findUnboundGatekeepers,
  isBoundByAnyGadget,
  unboundGatekeeperInfo,
  type UnboundGatekeeperCandidate,
} from "../src/overseer.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

function gatekeeper(id: number, creationSpec?: UnboundGatekeeperCandidate["creationSpec"],
                    extra: Partial<UnboundGatekeeperCandidate> = {}): UnboundGatekeeperCandidate {
  return { id, creationSpec, ...extra };
}

const MCP = { type: "gatekeeper", vendorId: "mcp", resourceUrl: "https://mcp.example.com/mcp",
              typeUrlPattern: "https://*" } as const;
const AMBIENT = { type: "ambient", vendorId: "scheduler", accountId: 7 } as const;

function gadget(bindings: Record<string, { target: number; pending?: { chatId: number } }>) {
  return { bindings };
}

describe("isBoundByAnyGadget", () => {
  it("counts permanent and pending edges alike", () => {
    let gadgets = [gadget({ A: { target: 1 } }), gadget({ B: { target: 2, pending: { chatId: 9 } } })];
    expect(isBoundByAnyGadget(1, gadgets)).toBe(true);
    expect(isBoundByAnyGadget(2, gadgets)).toBe(true);
    expect(isBoundByAnyGadget(3, gadgets)).toBe(false);
  });
});

describe("findUnboundGatekeepers", () => {
  it("returns gatekeepers no gadget binds, skipping ambient ones", () => {
    let gatekeepers = [
      gatekeeper(1, MCP, { resourceTitle: "Bound" }),
      gatekeeper(2, MCP, { resourceTitle: "Capsule only" }),
      gatekeeper(3, AMBIENT as any),
      gatekeeper(4, undefined, { resourceTitle: "Legacy" }),
    ];
    let gadgets = [gadget({ MCP: { target: 1 } })];

    expect(findUnboundGatekeepers(gatekeepers, gadgets).map(gk => gk.id)).toEqual([2, 4]);
  });

  it("returns nothing when every gatekeeper is bound", () => {
    let gatekeepers = [gatekeeper(1, MCP)];
    expect(findUnboundGatekeepers(gatekeepers, [gadget({ X: { target: 1 } })])).toEqual([]);
  });
});

describe("unboundGatekeeperInfo", () => {
  it("carries vendor and url for a vendor gatekeeper", () => {
    let info = unboundGatekeeperInfo(gatekeeper(2, MCP, {
      resourceTitle: "mcp.example.com", resourceUrl: "https://mcp.example.com/mcp",
    }));
    expect(info).toEqual({
      id: 2,
      resourceTitle: "mcp.example.com",
      resourceUrl: "https://mcp.example.com/mcp",
      vendorId: "mcp",
      connectionType: "gatekeeper",
    });
  });

  it("labels records without a creation spec as legacy and never fabricates a title", () => {
    expect(unboundGatekeeperInfo(gatekeeper(4))).toEqual({
      id: 4, resourceTitle: "(title unavailable)", connectionType: "legacy",
    });
  });

  it.each([
    ["aiModel", { type: "aiModel", modelId: "m" }],
    ["agentSpawner", { type: "agentSpawner", config: {} }],
  ])("passes through the %s connection type", (expected, spec) => {
    expect(unboundGatekeeperInfo(gatekeeper(5, spec as any)).connectionType).toBe(expected);
  });
});
