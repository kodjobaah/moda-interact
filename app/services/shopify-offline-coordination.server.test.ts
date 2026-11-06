import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ShopifyOfflineTokenError } from "@modainteract/moda-interact-shared/shopify/node";
import {
  createCoordinatedShopifyAuthentication,
} from "./shopify-offline-coordination.server";
import { ShopifySessionCoordinationRequiredError } from "./shopify-session-storage.server";

function fixture(nativeFetch: typeof fetch) {
  const domain = "merchant.myshopify.com";
  const shop = { id: "shop-id", domain, platform: "SHOPIFY", status: "ACTIVE" };
  const session = {
    id: "stored-session-id", shop: domain, state: "state", isOnline: false,
    scope: "read_products", expires: new Date(Date.now() - 60_000),
    accessToken: "old-access-token", refreshToken: "old-refresh-token",
    refreshTokenExpires: new Date(Date.now() + 86_400_000), userId: null,
    firstName: null, lastName: null, email: null, accountOwner: false,
    locale: null, collaborator: false, emailVerified: false,
  };
  const transaction = {
    $executeRawUnsafe: vi.fn(async () => 1),
    $queryRawUnsafe: vi.fn(async () => []),
    shop: { findUnique: vi.fn(async () => shop) },
    session: {
      findMany: vi.fn(async () => [session]),
      findUnique: vi.fn(async () => session),
    },
  };
  const database = {
    shop: { findUnique: vi.fn(async () => shop) },
    session: { findMany: vi.fn(async () => [session]) },
    $transaction: vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)),
  } as unknown as PrismaClient;
  const token = Buffer.from(JSON.stringify({ dest: `https://${domain}` })).toString("base64url");
  const request = new Request(`https://app.example.test/app?shop=${domain}`, {
    headers: { authorization: `Bearer header.${token}.signature` },
  });
  return { coordination: createCoordinatedShopifyAuthentication({ database, nativeFetch }), request, domain };
}

describe("createCoordinatedShopifyAuthentication", () => {
  it("blocks OAuth transport when there is no offline binding", async () => {
    const nativeFetch = vi.fn(async () => Response.json({ access_token: "unexpected" }));
    const app = fixture(nativeFetch);

    await expect(app.coordination.fetch(`https://${app.domain}/admin/oauth/access_token`, { method: "POST" }))
      .rejects.toBeInstanceOf(ShopifySessionCoordinationRequiredError);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("bounds the OAuth response and maps an accepted but unusable response to an unknown outcome", async () => {
    const nativeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return new Response(new Uint8Array(16_385), { status: 200 });
    });
    const app = fixture(nativeFetch);

    await expect(app.coordination.withAdminAuthentication(app.request, () =>
      app.coordination.fetch(`https://${app.domain}/admin/oauth/access_token`, { method: "POST" }),
    )).rejects.toMatchObject({ code: "REFRESH_OUTCOME_UNKNOWN" });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });
});
