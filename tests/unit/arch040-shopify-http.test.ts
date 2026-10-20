import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
const mocks = vi.hoisted(() => ({
  requireHistory: vi.fn(), control: vi.fn(), send: vi.fn(), status: vi.fn(),
}));
vi.mock("../../app/routes/app/recoveries/access.server", () => ({
  requireRecoveryHistory: mocks.requireHistory,
}));
vi.mock("../../app/services/recoveries/recovery-human-commands.server", () => ({
  RecoveryCommandError: class RecoveryCommandError extends Error {
    constructor(public code: string, public status = 409) { super(code); }
  },
  changeRecoveryControl: mocks.control,
  admitRecoveryHumanSend: mocks.send,
  readRecoveryCommandStatus: mocks.status,
}));
const { recoveryControlAction, recoverySendAction, recoveryCommandStatusLoader } =
  await import("../../app/routes/app/recovery-detail/command-http.server");
const route = (
  method: string, body: unknown,
  origin = "https://merchant.example",
  requestUrl = "https://merchant.example/app/recoveries/rec-a/control",
  fetchSite = "same-origin",
) => ({
  request: new Request(requestUrl, {
    method, headers: { "Content-Type": "application/json", Origin: origin, "Sec-Fetch-Site": fetchSite },
    body: JSON.stringify(body),
  }), params: { recoveryId: "rec-a" },
}) as unknown as ActionFunctionArgs;

beforeEach(() => {
  vi.stubEnv("SHOPIFY_APP_URL", "https://merchant.example");
  vi.resetAllMocks();
  mocks.requireHistory.mockResolvedValue({ shopId: "trusted-shop-a" });
  mocks.control.mockResolvedValue({ controlMode: "HUMAN", controlRevision: 2 });
  mocks.send.mockResolvedValue({ commandId: "durable-command", conversationId: "conv-a", kind: "HUMAN_TEXT",
    state: "ACCEPTED", controlRevision: 2, replay: false });
  mocks.status.mockResolvedValue({ schemaVersion: 1, commandId: "durable-command", state: "ACCEPTED" });
});

afterEach(() => vi.unstubAllEnvs());

describe("ARCH-040 Shopify HTTP authentication and boundaries", () => {
  it("accepts a verified App Bridge request through an internal HTTP proxy URL", async () => {
    const reply = await recoveryControlAction(route("POST", {
      targetMode: "HUMAN", expectedControlRevision: 1,
    }, "https://merchant.example", "http://127.0.0.1:50620/app/recoveries/rec-a/control"));
    expect(reply.init?.status).toBe(200);
    expect(mocks.requireHistory).toHaveBeenCalledTimes(1);
    expect(mocks.control).toHaveBeenCalledWith("trusted-shop-a", "rec-a", {
      targetMode: "HUMAN", expectedControlRevision: 1,
    });
  });
  it("rejects cross-site fetches despite a matching public Origin", async () => {
    const reply = await recoveryControlAction(route("POST", {
      targetMode: "HUMAN", expectedControlRevision: 1,
    }, "https://merchant.example", "http://127.0.0.1:50620/app/recoveries/rec-a/control", "cross-site"));
    expect(reply.init?.status).toBe(403);
    expect(mocks.control).not.toHaveBeenCalled();
  });
  it("rejects a missing Origin without changing control", async () => {
    const args = route("POST", { targetMode: "HUMAN", expectedControlRevision: 1 });
    args.request.headers.delete("origin");
    const reply = await recoveryControlAction(args);
    expect(reply.init?.status).toBe(403);
    expect(mocks.control).not.toHaveBeenCalled();
  });
  it("fails closed if the canonical Shopify app URL is absent or insecure", async () => {
    for (const appUrl of ["", "http://merchant.example"]) {
      vi.stubEnv("SHOPIFY_APP_URL", appUrl);
      const reply = await recoveryControlAction(route("POST", {
        targetMode: "HUMAN", expectedControlRevision: 1,
      }));
      expect(reply.init?.status).toBe(503);
      expect(reply.data).toMatchObject({ error: "origin_configuration_unavailable" });
      expect(mocks.control).not.toHaveBeenCalled();
    }
  });
  it("rejects forged origin after authentication without writing", async () => {
    const reply = await recoverySendAction(route("POST", {
      kind: "HUMAN_TEXT", idempotencyKey: "key-12345678", expectedControlRevision: 2,
      textBody: "Hello",
    }, "https://attacker.example"));
    expect(reply.init?.status).toBe(403);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("passes only the trusted shop and route recovery identity to control", async () => {
    await recoveryControlAction(route("POST", { targetMode: "HUMAN", expectedControlRevision: 1 }));
    expect(mocks.control).toHaveBeenCalledWith("trusted-shop-a", "rec-a", {
      targetMode: "HUMAN", expectedControlRevision: 1,
    });
  });
  it("rejects client shop IDs and command authority fields", async () => {
    const reply = await recoverySendAction(route("POST", { kind: "HUMAN_TEXT", idempotencyKey: "key-12345678",
      expectedControlRevision: 2, textBody: "Hello", shopId: "foreign", moderationApproved: true }));
    expect(reply.init?.status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("acceptance is a 202 queued intent, never provider SENT", async () => {
    const reply = await recoverySendAction(route("POST", { kind: "HUMAN_TEXT", idempotencyKey: "key-12345678",
      expectedControlRevision: 2, textBody: "Hello" }));
    expect(reply.init?.status).toBe(202);
    expect(reply.data).toMatchObject({ state: "ACCEPTED" });
    expect(mocks.send).toHaveBeenCalledWith("trusted-shop-a", "rec-a", expect.objectContaining({ textBody: "Hello" }));
  });
  it("does not execute unauthenticated status lookups", async () => {
    const request = new Request("https://merchant.example/app/recoveries/rec-a/commands/other");
    mocks.requireHistory.mockRejectedValue(new Response(null, { status: 401 }));
    await expect(recoveryCommandStatusLoader({ request, params: { recoveryId: "rec-a", commandId: "other" } } as unknown as LoaderFunctionArgs))
      .rejects.toBeInstanceOf(Response);
    expect(mocks.status).not.toHaveBeenCalled();
  });
});
