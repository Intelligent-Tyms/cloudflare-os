import type { ChannelRoutableWorkspace } from "@gadgets/workshop-shared/external-message-gateway";

/**
 * Channel commands: the small command language every messaging channel (Telegram, Slack,
 * email) shares for moving a conversation between workspaces. Parsed and answered by the
 * backend gateway so all channels behave identically and the channel workers stay dumb.
 *
 * A command occupies the first line of a message; any following lines are the message to
 * deliver after the command takes effect ("/use crm\nhow many open deals?"). "/" and "!"
 * prefixes are equivalent (Slack swallows unregistered "/" commands, so "!" is the escape
 * hatch there), and a Telegram "@botname" suffix is ignored.
 */

export type ParsedChannelCommand = {
  command: "workspaces" | "use" | "home" | "where" | "help";
  /** Argument text after the command word on the same line, trimmed. */
  argument: string;
  /** Text after the command line, trimmed; the message to deliver once the command applied. */
  remainder: string;
};

const COMMAND_ALIASES: Record<string, ParsedChannelCommand["command"]> = {
  workspaces: "workspaces",
  workspace: "workspaces",
  ws: "workspaces",
  list: "workspaces",
  use: "use",
  switch: "use",
  go: "use",
  open: "use",
  home: "home",
  where: "where",
  current: "where",
  help: "help",
  commands: "help",
};

export function parseChannelCommand(text: string): ParsedChannelCommand | null {
  let trimmed = text.trim();
  let newline = trimmed.indexOf("\n");
  let firstLine = newline === -1 ? trimmed : trimmed.slice(0, newline);
  let match = firstLine.match(/^[/!]([a-z]+)(?:@\w+)?(?:\s+(.*))?$/i);
  if (!match) return null;
  let command = COMMAND_ALIASES[match[1].toLowerCase()];
  if (!command) return null;
  let argument = (match[2] ?? "").trim();
  let remainder = newline === -1 ? "" : trimmed.slice(newline + 1).trim();
  // "/workspace crm" reads as a switch, "/workspace" alone as the listing.
  if (command === "workspaces" && argument && match[1].toLowerCase() === "workspace") {
    command = "use";
  }
  return { command, argument, remainder };
}

export type WorkspaceMatch =
  | { kind: "match"; workspace: ChannelRoutableWorkspace }
  | { kind: "ambiguous"; candidates: ChannelRoutableWorkspace[] }
  | { kind: "none" };

/**
 * Resolve a user-typed workspace reference: a number from the /workspaces listing, a
 * workspace id, an exact title, or a unique title prefix/substring (case-insensitive;
 * plus-tags arrive with hyphens for spaces, so "sales-crm" matches "Sales CRM"). "home"
 * always means the home workspace.
 */
export function matchWorkspace(
  workspaces: ChannelRoutableWorkspace[],
  reference: string,
): WorkspaceMatch {
  let query = reference.trim();
  if (!query) return { kind: "none" };
  if (/^\d+$/.test(query)) {
    let workspace = workspaces[Number(query) - 1];
    return workspace ? { kind: "match", workspace } : { kind: "none" };
  }
  let byId = workspaces.find(w => w.id === query);
  if (byId) return { kind: "match", workspace: byId };

  let normalize = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, " ").trim();
  let needle = normalize(query);
  if (needle === "home") {
    let home = workspaces.find(w => w.isHome);
    return home ? { kind: "match", workspace: home } : { kind: "none" };
  }
  let exact = workspaces.filter(w => normalize(w.title) === needle);
  if (exact.length === 1) return { kind: "match", workspace: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact };
  let prefix = workspaces.filter(w => normalize(w.title).startsWith(needle));
  if (prefix.length === 1) return { kind: "match", workspace: prefix[0] };
  if (prefix.length > 1) return { kind: "ambiguous", candidates: prefix };
  let substring = workspaces.filter(w => normalize(w.title).includes(needle));
  if (substring.length === 1) return { kind: "match", workspace: substring[0] };
  if (substring.length > 1) return { kind: "ambiguous", candidates: substring };
  return { kind: "none" };
}

/** Render the numbered workspace listing, marking the conversation's current workspace. */
export function formatWorkspaceList(
  workspaces: ChannelRoutableWorkspace[],
  currentId: string,
): string {
  if (workspaces.length === 0) return "You have no workspaces yet.";
  let lines = workspaces.map((w, i) => {
    let marker = w.id === currentId ? " ← current" : "";
    let tag = w.isHome ? " (home)" : w.shared ? " (shared)" : "";
    return `${i + 1}. ${w.title}${tag}${marker}`;
  });
  return `Your workspaces:\n${lines.join("\n")}\n\nSend /use <number or name> to switch this conversation, /home to go back.`;
}

export const CHANNEL_COMMANDS_HELP =
  "Commands:\n" +
  "/workspaces – list your workspaces\n" +
  "/use <number or name> – talk to that workspace from here\n" +
  "/home – back to your home assistant\n" +
  "/where – which workspace this conversation is in\n" +
  "\n" +
  "Put a message on the next line to send it right after switching, e.g.\n" +
  "/use CRM\n" +
  "how many open deals do we have?\n" +
  "\n" +
  "On Slack, type ! instead of / (e.g. !use CRM).";

export function formatWorkspaceMatchFailure(
  match: Exclude<WorkspaceMatch, { kind: "match" }>,
  reference: string,
  workspaces: ChannelRoutableWorkspace[],
): string {
  if (match.kind === "ambiguous") {
    let names = match.candidates.map(w => `${workspaces.indexOf(w) + 1}. ${w.title}`);
    return `"${reference}" matches more than one workspace:\n${names.join("\n")}\n\nSend /use with the number.`;
  }
  return `I couldn't find a workspace called "${reference}".\n\n${formatWorkspaceList(workspaces, "")}`;
}
