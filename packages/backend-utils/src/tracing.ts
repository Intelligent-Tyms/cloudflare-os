import { tracing } from "cloudflare:workers";

type Attribute = boolean | number | string;

// The span surface exposed to callbacks. Lifetime is managed by `traced`, so no `end()`.
export interface TraceSpan {
  readonly isTraced: boolean;
  setAttribute(key: string, value?: Attribute): void;
}

/**
 * Creates a span helper that stamps the ambient observability context onto each span as
 * attributes. Tracing only: never logs, never modifies context. Exceptions propagate
 * unchanged, marked on the span via an `error` attribute (the beta API has no outcome).
 */
export function createTracer(getContext: () => Readonly<Record<string, unknown>>) {
  return function traced<Result>(name: string, callback: (span: TraceSpan) => Result): Result {
    return tracing.enterSpan(name, (span) => {
      if (span.isTraced) {
        for (const [key, value] of Object.entries(getContext())) {
          if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
            span.setAttribute(key, value);
          }
        }
      }
      const fail = (err: unknown) => span.setAttribute("error", String(err));
      try {
        const result = callback(span);
        return result instanceof Promise
            ? result.catch((err) => { fail(err); throw err; }) as Result
            : result;
      } catch (err) {
        fail(err);
        throw err;
      }
    });
  };
}
