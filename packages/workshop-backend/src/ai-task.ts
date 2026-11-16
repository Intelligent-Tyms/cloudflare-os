// Billing tasks: every AI usage event names the task it belongs to, so the control plane can rate
// Jamaa per task instead of per token (it accumulates cost per task id).
//
// A task is one agent turn -- a user or channel message through the assistant's finished reply,
// every model and tool step in between included -- or one model call an app makes through its
// LLM binding. Housekeeping calls (thread/app titles, binding names) belong to no task.
//
// Within a turn the task rides an AsyncLocalStorage context, set where the turn starts
// (#runAgentTurn in overseer.ts), rather than per-chat instance state: one overseer runs many
// chats' turns at once, and a superseded turn can still be unwinding when its chat's next turn
// starts, so only the turn's own async context says which task an event belongs to.

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What kind of work an AI usage event was for:
 * - chat: a turn answering a user's (or a channel's) message, and explicit retries of it;
 * - automation: a turn started by a gadget -- callbacks (including scheduled ones) and spawned
 *   agents;
 * - reviewer: a turn reviewing a blueprint-update proposal;
 * - app: one model call made by an app through its LLM binding;
 * - housekeeping: a one-shot call the platform makes for itself (titles, binding names), which
 *   carries no task id.
 */
export type AiTaskKind = "chat" | "automation" | "reviewer" | "app" | "housekeeping";

/** A billing task: the id every usage event of the task shares, and its kind. */
export type AiTask = {
  taskId: string;
  taskKind: Exclude<AiTaskKind, "housekeeping">;
};

/** The task of an agent turn, and the chat whose turn it is. */
export type AgentTurnTask = AiTask & { chatId: number };

const turnTask = new AsyncLocalStorage<AgentTurnTask>();

/** Runs `fn` (an agent turn) with `task` as the task of every usage event it records. */
export function runInAgentTurnTask<Result>(task: AgentTurnTask, fn: () => Result): Result {
  return turnTask.run(task, fn);
}

/** The task of the agent turn the caller is running in, if any. */
export function currentAgentTurnTask(): AgentTurnTask | undefined {
  return turnTask.getStore();
}

/**
 * The task id of an agent turn: stable for the chat message (or callback, or proposal) the turn
 * answers, so a resumed or retried turn keeps billing the same task. `anchorSequence` is the
 * sequence of that triggering chat row; the workspace id makes the id unique across workspaces.
 */
export function agentTurnTaskId(gadgetId: string, chatId: number, anchorSequence: number): string {
  return `turn:${gadgetId}:${chatId}:${anchorSequence}`;
}

/** A fresh task for one app model call: each such call is a task of its own. */
export function newAppTask(): AiTask {
  return { taskId: `app:${crypto.randomUUID()}`, taskKind: "app" };
}

/** The usage-event meta fields naming `task` (none for an event outside any task). */
export function aiTaskMeta(task: AiTask | undefined): { taskId?: string, taskKind?: AiTaskKind } {
  return task ? { taskId: task.taskId, taskKind: task.taskKind } : {};
}

/** The usage-event meta fields of a housekeeping call: a kind, and deliberately no task id. */
export const HOUSEKEEPING_TASK_META = { taskKind: "housekeeping" } as const satisfies
    { taskKind: AiTaskKind };
