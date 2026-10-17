import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Workshop backend. */
export type WorkshopObservabilityFields = {
  accountId: number;
  actionId: number | string;
  agentName: string;
  /** The workpiece id of an app within its workspace (`gadgetId` names the workspace itself). */
  appId: number;
  autoProvisioned: boolean;
  blueprintId: string;
  callbackInitiated: boolean;
  chatId: number;
  claimedType: string;
  commitCount: number;
  connectionType: string;
  durableObjectId: string;
  durationMs: number;
  eventName: string;
  executionId: string;
  failureCount: number;
  gadgetId: string;
  gatekeeperId: number | string;
  handoffKind: "connect" | "restore";
  hookId: number;
  /** How long something had gone unused when the logged event happened. */
  idleMs: number;
  logBytes: number;
  modelId: string;
  observerId: string;
  oidCount: number;
  oidPrefix: string;
  operation: string;
  outcome: "ok" | "error" | "usage_limit" | "no_email" | "signups_disabled";
  path: string;
  /** What led to the logged event: a short slug, or an error message. */
  reason: string;
  recordedType: string;
  resourceTitle: string;
  runningAgents: number;
  sequence: number;
  size: number;
  status: number;
  statusCode: number;
  statusText: string;
  toolCallId: string;
  toolName: string;
  vendorId: string;
};

/** Ambient observability fields for one Workshop operation. */
export const obsContext = createObservabilityContext<WorkshopObservabilityFields>();

/** Creates a logger restricted to the Workshop backend's field vocabulary. */
export function createWorkshopLogger(component: string) {
  return obsContext.createLogger({ component });
}
