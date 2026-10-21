// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BillingGateInfo } from "@gadgets/workshop-shared/api";
import TopBarNotice from "./TopBarNotice";

const state: {
  config: { announcement: string; billingPortalUrl?: string };
  isAdmin: boolean;
  gate: BillingGateInfo | null;
} = { config: { announcement: "" }, isAdmin: true, gate: null };

vi.mock("./ServerConfigContext", () => ({
  useServerConfig: () => state.config,
}));

// One stable session object, as the real context provides.
const auth = {
  get isAdmin() { return state.isAdmin; },
  authenticatedApi: { getBillingGate: async () => state.gate },
};

vi.mock("./AuthContext", () => ({
  useOptionalAuthenticatedApi: () => auth,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("TopBarNotice", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    state.config = { announcement: "" };
    state.isAdmin = true;
    state.gate = null;
  });

  async function render() {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<TopBarNotice />));
    return container;
  }

  it("tells admins the workspace is out of funds and links to its billing page", async () => {
    state.config.billingPortalUrl = "https://billing.tyms.ai/acme";
    state.gate = { stop: "out_of_funds", lowBalance: false };
    const el = await render();
    expect(el.textContent).toContain("Out of funds.");
    expect(el.querySelector("a")?.getAttribute("href")).toBe("https://billing.tyms.ai/acme");
  });

  it("falls back to the billing home without a workspace billing page", async () => {
    state.gate = { stop: "suspended", lowBalance: false };
    const el = await render();
    expect(el.textContent).toContain("Workspace suspended.");
    expect(el.querySelector("a")?.getAttribute("href")).toBe("https://billing.tyms.ai");
  });

  it("nudges on a low balance", async () => {
    state.gate = { stop: null, lowBalance: true };
    expect((await render()).textContent).toContain("Balance low.");
  });

  it("shows nothing to members or when billing is fine", async () => {
    state.gate = { stop: null, lowBalance: false };
    expect((await render()).textContent).toBe("");
    await act(async () => root?.unmount());
    state.isAdmin = false;
    state.gate = { stop: "out_of_funds", lowBalance: false };
    expect((await render()).textContent).toBe("");
  });

  it("lets an admin-set announcement win", async () => {
    state.config.announcement = "Maintenance tonight";
    state.gate = { stop: "out_of_funds", lowBalance: false };
    const el = await render();
    expect(el.textContent).toContain("Maintenance tonight");
    expect(el.textContent).not.toContain("Out of funds");
  });
});
