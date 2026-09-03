// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "@gadgets/workshop-shared/api";
import { MarkdownMessage, isWikiCitationHref } from "./ChatInterface";
import { ServerConfigContext } from "./ServerConfigContext";
import { splitCitationText } from "./components/chat/CitationChip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const config = { intelligenceBaseDomain: "organization.tyms.ai" } as ServerConfig;

describe("wiki citations in chat", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
  });

  async function render(message: string, serverConfig: ServerConfig | null = config) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(
      createElement(ServerConfigContext.Provider, { value: serverConfig },
        createElement(MarkdownMessage, { message }))));
  }

  it("renders a link onto the wiki host as a citation chip with its tier", async () => {
    await render("See [Expense policy · human-reviewed](https://acme.organization.tyms.ai/company/policies/expenses).");
    const chip = container.querySelector("a[data-citation='wiki']") as HTMLAnchorElement;
    expect(chip).not.toBeNull();
    expect(chip.getAttribute("href")).toBe("https://acme.organization.tyms.ai/company/policies/expenses");
    expect(chip.getAttribute("target")).toBe("_blank");
    expect(chip.getAttribute("rel")).toBe("noopener noreferrer");
    expect(chip.querySelector("span")?.textContent).toBe("Expense policy");
    expect(chip.textContent).toContain("human-reviewed");
  });

  it("renders a chip without a tier badge when the link text has none", async () => {
    await render("[Expense policy](https://acme.organization.tyms.ai/company/policies/expenses)");
    const chip = container.querySelector("a[data-citation='wiki']") as HTMLAnchorElement;
    expect(chip.textContent).toBe("Expense policy");
    expect(chip.querySelectorAll("span").length).toBe(1);
  });

  it("leaves links to other hosts as plain external links", async () => {
    await render("[Docs · human-reviewed](https://example.com/docs) and [evil](https://organization.tyms.ai.evil.com/x)");
    expect(container.querySelector("a[data-citation='wiki']")).toBeNull();
    const links = container.querySelectorAll("a");
    expect(links.length).toBe(2);
    expect(links[0].getAttribute("target")).toBe("_blank");
  });

  it("renders no chip when the deployment has no intelligence cell", async () => {
    await render("[Expense policy · human-reviewed](https://acme.organization.tyms.ai/x)", null);
    expect(container.querySelector("a[data-citation='wiki']")).toBeNull();
    expect(container.querySelector("a")?.getAttribute("target")).toBe("_blank");
  });

  it("renders an unsafe href as plain text, wiki-shaped or not", async () => {
    await render("[Expense policy · human-reviewed](javascript:alert(1))");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("Expense policy · human-reviewed");
  });

  it("recognizes wiki hrefs only under the configured domain over https", () => {
    expect(isWikiCitationHref("https://acme.organization.tyms.ai/company", "organization.tyms.ai")).toBe(true);
    expect(isWikiCitationHref("https://acme.ORGANIZATION.tyms.ai/company", "organization.tyms.ai")).toBe(true);
    expect(isWikiCitationHref("http://acme.organization.tyms.ai/company", "organization.tyms.ai")).toBe(false);
    expect(isWikiCitationHref("https://organization.tyms.ai/company", "organization.tyms.ai")).toBe(false);
    expect(isWikiCitationHref("https://acme.organization.tyms.ai.evil.com/", "organization.tyms.ai")).toBe(false);
    expect(isWikiCitationHref("https://acme.organization.tyms.ai/", undefined)).toBe(false);
    expect(isWikiCitationHref(undefined, "organization.tyms.ai")).toBe(false);
  });

  it("splits the citation text into title and tier on the last separator", () => {
    expect(splitCitationText("Expense policy · human-reviewed")).toEqual({ title: "Expense policy", tier: "human-reviewed" });
    expect(splitCitationText("Q3 · Plan · stable")).toEqual({ title: "Q3 · Plan", tier: "stable" });
    expect(splitCitationText("Expense policy")).toEqual({ title: "Expense policy", tier: null });
    expect(splitCitationText(" · draft")).toEqual({ title: " · draft", tier: null });
  });
});
