// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "@gadgets/workshop-shared/api";
import { ServerConfigContext, usePoolMode, usePoolUpgradeUrl } from "./ServerConfigContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE: ServerConfig = {
  authVendors: [],
  passwordAuthEnabled: true,
  cloudflareLimitsEnabled: false,
  poolMode: false,
  signupsEnabled: true,
  siteName: "Tyms",
  siteLogo: null,
  announcement: null,
  banner: null,
  bannerColor: null,
  accentColor: null,
} as unknown as ServerConfig;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(config: ServerConfig | null): { pool: boolean; upgrade: string | null } {
  const seen = { pool: false, upgrade: null as string | null };
  function Probe() {
    seen.pool = usePoolMode();
    seen.upgrade = usePoolUpgradeUrl();
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <ServerConfigContext.Provider value={config}>
        <Probe />
      </ServerConfigContext.Provider>,
    );
  });
  return seen;
}

describe("pool mode on the client", () => {
  it("is off while config loads and on company tenants", () => {
    expect(render(null)).toEqual({ pool: false, upgrade: null });
    expect(render({ ...BASE, centralLoginUrl: "https://start.tyms.ai/?slug=acme" }))
      .toEqual({ pool: false, upgrade: null });
  });

  it("points a pool member's upgrade at the central account, same origin as sign-in", () => {
    expect(render({ ...BASE, poolMode: true, centralLoginUrl: "https://start.tyms.ai/?slug=free-1" }))
      .toEqual({ pool: true, upgrade: "https://start.tyms.ai/upgrade" });
    // A pool without central login (local dev) is still a pool, just with nowhere to send people.
    expect(render({ ...BASE, poolMode: true })).toEqual({ pool: true, upgrade: null });
  });
});
