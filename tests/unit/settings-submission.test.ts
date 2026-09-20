import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSettingsSubmission,
  type SaveReply,
} from "../../app/components/settings/submission";
const payload = () => {
  const body = new FormData();
  body.set("operationId", "original");
  body.set("enabled", "true");
  return body;
};
function deferred() {
  let resolve!: (v: SaveReply) => void;
  let reject!: () => void;
  const promise = new Promise<SaveReply>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => vi.useRealTimers());
describe("settings intent protection", () => {
  it("blocks same-tick submits, retains input on known failure, permits intentional retry", async () => {
    const first = deferred();
    const send = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ ok: true, operationId: "original" });
    const notify = vi.fn();
    const c = createSettingsSubmission(send, notify);
    expect(c.submit(payload())).toBe(true);
    expect(c.submit(payload())).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    first.resolve({
      ok: false,
      operationId: "original",
      error: "INVALID_INPUT",
    });
    await first.promise;
    await Promise.resolve();
    expect(notify).toHaveBeenLastCalledWith(
      { phase: "error", error: "INVALID_INPUT" },
      expect.anything(),
    );
    expect(c.submit(payload())).toBe(true);
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith(
      { phase: "saved", error: undefined },
      expect.anything(),
    );
    c.dispose();
  });
  it("timeout reconciles the frozen intent, ignores stale success, and never unlocks unknown errors", async () => {
    vi.useFakeTimers();
    const first = deferred(),
      second = deferred();
    const send = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const notify = vi.fn();
    const c = createSettingsSubmission(send, notify, 10);
    const body = payload();
    c.submit(body);
    body.set("enabled", "false");
    vi.advanceTimersByTime(11);
    expect(notify).toHaveBeenLastCalledWith({ phase: "unknown" });
    expect(c.submit(payload())).toBe(false);
    c.reconcile();
    c.reconcile();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].get("enabled")).toBe("true");
    expect(send.mock.calls[1][0].get("operationId")).toBe("original");
    first.resolve({ ok: true, operationId: "original" });
    await first.promise;
    await Promise.resolve();
    expect(c.submit(payload())).toBe(false);
    second.reject();
    await second.promise.catch(() => {});
    await Promise.resolve();
    expect(notify).toHaveBeenLastCalledWith({ phase: "unknown" });
    expect(c.submit(payload())).toBe(false);
    c.dispose();
  });
  it("a reconciled success releases the guard for a new explicit intent", async () => {
    vi.useFakeTimers();
    const first = deferred();
    const notify = vi.fn();
    const send = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({
        ok: true,
        operationId: "original",
        revision: "saved",
      });
    const c = createSettingsSubmission(send, notify, 10);
    c.submit(payload());
    vi.advanceTimersByTime(11);
    c.reconcile();
    c.reconcile();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith(
      { phase: "saved", error: undefined },
      expect.objectContaining({ revision: "saved" }),
    );
    expect(c.submit(payload())).toBe(true);
    c.dispose();
  });
  it("disposed/cancelled view ignores late completion", async () => {
    const d = deferred(),
      notify = vi.fn();
    const c = createSettingsSubmission(() => d.promise, notify);
    c.submit(payload());
    c.dispose();
    d.resolve({ ok: true, operationId: "original" });
    await d.promise;
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
