import { createObservabilityContext } from "@gadgets/backend-utils/observability-context";
import { createTracer } from "@gadgets/backend-utils/tracing";

/** Observability fields emitted by the Workshop backend. */
export type WorkshopObservabilityFields = {
  accountId: number;
  actionId: number | string;
  /** The workpiece id of an app within its workspace (`gadgetId` names the workspace itself). */
  appId: number;
  autoProvisioned: boolean;
  blueprintId: string;
  callbackInitiated: boolean;
  chatId: number;
  connectionType: string;
  durableObjectId: string;
  durationMs: number;
  eventName: string;
  executionId: string;
  failureCount: number;
  gadgetId: string;
  gatekeeperId: number | string;
  /** How long something had gone unused when the logged event happened. */
  idleMs: number;
  logBytes: number;
  modelId: string;
  observerId: string;
  operation: string;
  outcome: "ok" | "error" | "usage_limit" | "callbacks_stalled" | "no_email" | "signups_disabled";
  path: string;
  /** What led to the logged event: a short slug, or an error message. */
  reason: string;
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

/** Runs `callback` in a trace span carrying the ambient observability fields as attributes. */
export const traced = createTracer(obsContext.get);
