import { describe, expect, it, vi } from "vitest";
import { waitUpTo } from "../src/overseer.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

// A timer that the test fires by hand, and that reports whether it was cancelled.
function manualTimer() {
  let fire!: () => void;
  let cancelled = false;
  let wait = (_ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    fire = resolve;
    signal.addEventListener("abort", () => { cancelled = true; reject(new Error("aborted")); });
  });
  return { wait, fire: () => fire(), cancelled: () => cancelled };
}

describe("waitUpTo", () => {
  it("reports that the work finished, and cancels the timer it no longer needs", async () => {
    let timer = manualTimer();
    let finish!: () => void;
    let done = new Promise<void>(resolve => { finish = resolve; });

    let result = waitUpTo(done, 1000, timer.wait);
    finish();

    await expect(result).resolves.toBe(true);
    expect(timer.cancelled()).toBe(true);
  });

  it("gives up when the time runs out and the work is still going", async () => {
    let timer = manualTimer();
    let never = new Promise<void>(() => {});

    let result = waitUpTo(never, 1000, timer.wait);
    timer.fire();

    await expect(result).resolves.toBe(false);
  });

  it("passes the limit it was given to the timer", async () => {
    let asked: number | undefined;
    let result = waitUpTo(Promise.resolve(), 600_000, (ms) => {
      asked = ms;
      return new Promise<void>(() => {});
    });

    await expect(result).resolves.toBe(true);
    expect(asked).toBe(600_000);
  });

  it("does not leave an unhandled rejection behind when the timer is cancelled", async () => {
    let timer = manualTimer();
    let unhandled = vi.fn<(reason: unknown) => void>();
    process.on("unhandledRejection", unhandled);
    try {
      await waitUpTo(Promise.resolve(), 1000, timer.wait);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
