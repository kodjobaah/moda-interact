import { Session } from "@shopify/shopify-api";
import { describe, expect, it, vi } from "vitest";
import { CoordinatedShopifySessionStorage, ShopifySessionCoordinationRequiredError } from "./shopify-session-storage.server";

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

    await expect(storage.storeSession(session)).rejects.toBeInstanceOf(ShopifySessionCoordinationRequiredError);
    expect(sessionDelegate.findUnique).not.toHaveBeenCalled();
  });
});
