import { describe, expect, it } from "vitest";
import {
  formatWorkspaceList,
  matchWorkspace,
  parseChannelCommand,
} from "../src/external-message-commands";

const WORKSPACES = [
  { id: "h", title: "Assistant", isHome: true, shared: false },
  { id: "c", title: "Sales CRM", isHome: false, shared: false },
  { id: "s", title: "Support Desk", isHome: false, shared: true },
  { id: "t", title: "Support Tasks", isHome: false, shared: false },
];

describe("parseChannelCommand", () => {
  it("ignores ordinary messages", () => {
    expect(parseChannelCommand("how are things")).toBeNull();
    expect(parseChannelCommand("/unknown thing")).toBeNull();
    expect(parseChannelCommand("please /use crm")).toBeNull();
  });

  it("parses commands, aliases, bot suffixes and both prefixes", () => {
    expect(parseChannelCommand("/workspaces")).toEqual({ command: "workspaces", argument: "", remainder: "" });
    expect(parseChannelCommand("/ws@tyms_bot")).toMatchObject({ command: "workspaces" });
    expect(parseChannelCommand("!use crm")).toEqual({ command: "use", argument: "crm", remainder: "" });
    expect(parseChannelCommand("/Switch Sales CRM ")).toEqual({ command: "use", argument: "Sales CRM", remainder: "" });
    expect(parseChannelCommand("/workspace crm")).toMatchObject({ command: "use", argument: "crm" });
    expect(parseChannelCommand("/home")).toMatchObject({ command: "home" });
    expect(parseChannelCommand("/where")).toMatchObject({ command: "where" });
  });

  it("keeps the lines after the command as the message to deliver", () => {
    expect(parseChannelCommand("/use crm\nhow many open deals?\n\nthanks")).toEqual({
      command: "use", argument: "crm", remainder: "how many open deals?\n\nthanks",
    });
  });
});

describe("matchWorkspace", () => {
  it("resolves listing numbers, ids, titles and unique fragments", () => {
    expect(matchWorkspace(WORKSPACES, "2")).toMatchObject({ kind: "match", workspace: { id: "c" } });
    expect(matchWorkspace(WORKSPACES, "9")).toEqual({ kind: "none" });
    expect(matchWorkspace(WORKSPACES, "t")).toMatchObject({ kind: "match", workspace: { id: "t" } });
    expect(matchWorkspace(WORKSPACES, "sales crm")).toMatchObject({ kind: "match", workspace: { id: "c" } });
    expect(matchWorkspace(WORKSPACES, "sales-crm")).toMatchObject({ kind: "match", workspace: { id: "c" } });
    expect(matchWorkspace(WORKSPACES, "crm")).toMatchObject({ kind: "match", workspace: { id: "c" } });
    expect(matchWorkspace(WORKSPACES, "home")).toMatchObject({ kind: "match", workspace: { id: "h" } });
  });

  it("reports ambiguity instead of guessing", () => {
    let match = matchWorkspace(WORKSPACES, "support");
    expect(match.kind).toBe("ambiguous");
    expect(match.kind === "ambiguous" && match.candidates.map(w => w.id)).toEqual(["s", "t"]);
    expect(matchWorkspace(WORKSPACES, "nothing")).toEqual({ kind: "none" });
  });
});

describe("formatWorkspaceList", () => {
  it("numbers workspaces and marks home, shared and current", () => {
    let text = formatWorkspaceList(WORKSPACES, "c");
    expect(text).toContain("1. Assistant (home)");
    expect(text).toContain("2. Sales CRM ← current");
    expect(text).toContain("3. Support Desk (shared)");
  });
});
