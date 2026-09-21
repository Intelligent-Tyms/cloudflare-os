// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import AssistantSettingsPage from "./AssistantSettingsPage";

const saved = { assistantName: "Ada", persona: "", role: "", targets: "", goals: "", timeZone: "UTC" };
const apiServing = () => ({ getAssistantProfile: vi.fn(async () => ({ ...saved })) });
const session: { authenticatedApi: ReturnType<typeof apiServing> } = { authenticatedApi: apiServing() };

vi.mock("./AuthContext", () => ({ useAuthenticatedApi: () => session }));
vi.mock("./AssistantProfileContext", () => ({ useAssistantProfile: () => ({ refresh: () => {} }) }));
vi.mock("./useDocumentTitle", () => ({ useDocumentTitle: () => {} }));
vi.mock("@cloudflare/kumo", () => ({ useKumoToastManager: () => ({ add: () => {} }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// React tracks input values through the native setter; assigning `.value` directly is ignored.
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AssistantSettingsPage", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
  });

  const nameInput = () => {
    const input = [...container!.querySelectorAll("input")].find((i) => i.value === "Ada" || i.value === "Grace");
    if (!input) throw new Error("Missing assistant name input");
    return input;
  };

  it("keeps an edited draft when a reconnected API session reloads the profile", async () => {
    session.authenticatedApi = apiServing();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<AssistantSettingsPage />));
    expect(nameInput().value).toBe("Ada");

    await act(async () => type(nameInput(), "Grace"));

    // The websocket reconnected: a new API object, so the profile is fetched again.
    session.authenticatedApi = apiServing();
    await act(async () => root!.render(<AssistantSettingsPage />));
    expect(session.authenticatedApi.getAssistantProfile).toHaveBeenCalled();
    expect(nameInput().value).toBe("Grace");
  });

  it("lets an untouched draft follow the server on reload", async () => {
    session.authenticatedApi = apiServing();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<AssistantSettingsPage />));

    const next = apiServing();
    next.getAssistantProfile.mockResolvedValue({ ...saved, assistantName: "Grace" });
    session.authenticatedApi = next;
    await act(async () => root!.render(<AssistantSettingsPage />));
    expect(nameInput().value).toBe("Grace");
  });
});
