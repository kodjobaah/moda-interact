import { Session } from "@shopify/shopify-api";
import { describe, expect, it, vi } from "vitest";
import {
  CoordinatedShopifySessionStorage,
  ShopifySessionCoordinationRequiredError,
  runWithShopifySessionBinding,
} from "./shopify-session-storage.server";

describe("CoordinatedShopifySessionStorage", () => {
  it("refuses offline writes without an authentication transaction binding", async () => {
    const sessionDelegate = { findUnique: vi.fn() };
    const database = { session: sessionDelegate };
    const storage = new CoordinatedShopifySessionStorage(database as never);
    const session = new Session({
      id: "sdk-session-id",
      shop: "merchant.myshopify.com",
      state: "state",
      isOnline: false,
      accessToken: "offline-token",
    });

    await expect(storage.storeSession(session)).rejects.toBeInstanceOf(
      ShopifySessionCoordinationRequiredError,
    );
    expect(sessionDelegate.findUnique).not.toHaveBeenCalled();
  });

  it("does not leave a rejected abort promise unobserved during the initial session lookup", async () => {
    const caller = new AbortController();
    const contextAbort = new AbortController();
    let resolveLookup!: (row: {
      id: string;
      shop: string;
      isOnline: boolean;
    }) => void;
    const lookup = new Promise<{ id: string; shop: string; isOnline: boolean }>(
      (resolve) => {
        resolveLookup = resolve;
      },
    );
    const work = vi.fn(async () => "authenticated");
    const context = {
      shop: "merchant.myshopify.com",
      shopId: "shop-id",
      sessionId: "offline_merchant.myshopify.com",
      signal: contextAbort.signal,
      transaction: { session: { findUnique: vi.fn(() => lookup) } },
    };
    const task = runWithShopifySessionBinding(
      context as never,
      work,
      caller.signal,
    );
    // The lookup is still pending when the caller abandons the request.
    caller.abort();
    // Let Node process microtasks before the lookup completes; no detached
    // abort rejection must exist at this point.
    await Promise.resolve();
    resolveLookup({
      id: context.sessionId,
      shop: context.shop,
      isOnline: false,
    });
    await expect(task).rejects.toMatchObject({ code: "CANCELLED" });
    expect(work).not.toHaveBeenCalled();
  });
});
