// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import GatekeeperAppPage from "./GatekeeperAppPage";

const session = { authenticatedApi: { getGatekeeperApp: vi.fn() } };

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => session,
}));

vi.mock("./errorReporting", () => ({
  reportIssue: () => {},
}));

vi.mock("./SandboxedGatekeeperApp", () => ({
  default: () => <iframe title="app" />,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiServing = (ui: object) => ({
  getGatekeeperApp: vi.fn(async () => ({ iframeHtml: "<!doctype html>", ui })),
});

describe("GatekeeperAppPage", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
  });

  it("remounts the app iframe when a reconnected API session serves a fresh frame", async () => {
    session.authenticatedApi = apiServing({});
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<GatekeeperAppPage appId="context" />));
    const first = container.querySelector("iframe");
    expect(first).not.toBeNull();

    // The websocket reconnected: a new API object, and with it a new frame (same HTML, new stub).
    session.authenticatedApi = apiServing({});
    await act(async () => root!.render(<GatekeeperAppPage appId="context" />));
    const second = container.querySelector("iframe");
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });
});
