import { beforeEach, describe, expect, it, vi } from "vitest";
import { GraphqlQueryError, HttpResponseError, HttpRequestError } from "@shopify/shopify-api";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const shop = {
  id: "shop_1",
  domain: "shop.myshopify.com",
  shopifyShopId: "gid://shopify/Shop/1",
  status: "ACTIVE",
  platform: "SHOPIFY",
};

const dbMock = {
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  shop: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  session: {
    deleteMany: vi.fn(),
    findFirst: vi.fn(),
  },
  subscription: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
  shopSettings: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
  shopifyDiscountCatalogue: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
  shopifyDiscount: {
    updateMany: vi.fn(),
  },
};

vi.mock("../../../app/db.server", () => ({
  default: dbMock,
}));

const { ShopService } = await import(
  "../../../app/services/shop/shop.service"
);

function adminFor(shopData: Record<string, unknown>) {
  return {
    graphql: vi.fn(async () => ({
      json: async () => ({
        data: {
          shop: shopData,
          shopLocales: (shopData as { shopLocales?: unknown }).shopLocales,
        },
      }),
    })),
  } as unknown as AdminApiContext;
}

beforeEach(() => {
  dbMock.$transaction.mockReset();
  dbMock.$queryRaw.mockReset();
  dbMock.shop.findUnique.mockReset().mockResolvedValue(null);
  dbMock.shop.upsert.mockReset();
  dbMock.shop.update.mockReset();
  dbMock.shop.updateMany.mockReset();
  dbMock.session.deleteMany.mockReset().mockResolvedValue({ count: 2 });
  dbMock.session.findFirst.mockReset().mockResolvedValue({
    accessToken: "fixture-access-token",
    expires: null,
    refreshToken: null,
  });
  dbMock.subscription.updateMany.mockReset();
  dbMock.subscription.findUnique.mockReset().mockResolvedValue(null);
  dbMock.subscription.upsert.mockReset();
  dbMock.shopSettings.findUnique.mockReset().mockResolvedValue(null);
  dbMock.shopSettings.upsert.mockReset();
  dbMock.shopSettings.update.mockReset();
  dbMock.shopifyDiscountCatalogue.updateMany.mockReset();
  dbMock.shopifyDiscountCatalogue.upsert.mockReset();
  dbMock.shopifyDiscount.updateMany.mockReset();
  dbMock.$transaction.mockImplementation(async (callback) => callback(dbMock));
  dbMock.$queryRaw.mockResolvedValue([]);
  dbMock.shop.upsert.mockResolvedValue(shop);
  dbMock.shop.update.mockResolvedValue(shop);
  dbMock.shopSettings.upsert.mockResolvedValue({
    shopId: shop.id,
  });
  dbMock.shopSettings.update.mockResolvedValue({ shopId: shop.id });
  dbMock.subscription.upsert.mockResolvedValue({
    shopId: shop.id,
    status: "NO_CONTRACT",
  });
  dbMock.shop.updateMany.mockResolvedValue({ count: 1 });
});

describe("ShopService.markUninstalled", () => {
  it("marks the shop while preserving the subscription projection", async () => {
    dbMock.shop.findUnique
      .mockResolvedValueOnce({ id: shop.id })
      .mockResolvedValueOnce({ id: shop.id, uninstalledAt: null });
    const uninstalledAt = new Date("2026-09-08T10:00:00.000Z");

    await expect(new ShopService().markUninstalled(shop.domain, uninstalledAt)).resolves.toEqual({
      kind: "UNINSTALLED",
      shopId: shop.id,
      deletedSessionCount: 2,
    });

    expect(dbMock.shop.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: shop.id, uninstalledAt: null },
      data: { status: "UNINSTALLED", uninstalledAt, reinstallPendingAt: null },
    });
    expect(dbMock.subscription.updateMany).not.toHaveBeenCalled();
    expect(dbMock.session.deleteMany).toHaveBeenCalledWith({ where: { shop: shop.domain } });
    expect(dbMock.shopifyDiscountCatalogue.upsert).toHaveBeenCalledWith({
      where: { shopId: shop.id },
      create: {
        shopId: shop.id,
        status: "UNAVAILABLE",
        activeSyncToken: null,
        syncStartedAt: null,
        unavailableAt: uninstalledAt,
      },
      update: {
        status: "UNAVAILABLE",
        activeSyncToken: null,
        syncStartedAt: null,
        unavailableAt: uninstalledAt,
      },
    });
    expect(dbMock.shopifyDiscount.updateMany).toHaveBeenNthCalledWith(1, {
      where: { shopId: shop.id, isAvailable: true },
      data: { isAvailable: false },
    });
    expect(dbMock.shopifyDiscount.updateMany).toHaveBeenNthCalledWith(2, {
      where: { shopId: shop.id, unavailableAt: null },
      data: { unavailableAt: uninstalledAt },
    });
  });

  it("preserves replacement sessions and the first timestamp for duplicate delivery", async () => {
    const persistedAt = new Date("2026-09-08T10:00:00.000Z");
    dbMock.shop.findUnique
      .mockResolvedValueOnce({ id: shop.id })
      .mockResolvedValueOnce({ id: shop.id, uninstalledAt: persistedAt });
    const uninstalledAt = new Date("2026-09-08T11:00:00.000Z");

    await expect(new ShopService().markUninstalled(shop.domain, uninstalledAt)).resolves.toEqual({
      kind: "ALREADY_UNINSTALLED",
      shopId: shop.id,
    });

    expect(dbMock.shop.updateMany).not.toHaveBeenCalled();
    expect(dbMock.session.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.shopifyDiscountCatalogue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ unavailableAt: persistedAt }),
        update: expect.objectContaining({ unavailableAt: persistedAt }),
      }),
    );
  });

  it("reuses the persisted uninstall timestamp for duplicate invalidation", async () => {
    const persistedAt = new Date("2026-09-08T10:00:00.000Z");
    const retryAt = new Date("2026-09-08T11:00:00.000Z");
    dbMock.shop.findUnique
      .mockResolvedValueOnce({ id: shop.id })
      .mockResolvedValueOnce({ id: shop.id, uninstalledAt: persistedAt });
    dbMock.shop.updateMany.mockResolvedValue({ count: 0 });

    await new ShopService().markUninstalled(shop.domain, retryAt);

    expect(dbMock.shopifyDiscountCatalogue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ unavailableAt: persistedAt }),
        update: expect.objectContaining({ unavailableAt: persistedAt }),
      }),
    );
  });
});

describe("ShopService.beginReinstallReconciliation", () => {
  it("creates the pending marker and immediate schedule without changing subscription state", async () => {
    const now = new Date("2026-09-08T12:00:00.000Z");
    dbMock.shop.findUnique.mockResolvedValue({ status: "UNINSTALLED", reinstallPendingAt: null });
    dbMock.subscription.findUnique.mockResolvedValue({ id: "subscription-1", nextReconcileAt: null });
    dbMock.subscription.upsert.mockResolvedValue({ id: "subscription-1", nextReconcileAt: now });

    const result = await new ShopService().beginReinstallReconciliation(shop.id, now);

    expect(result).toEqual({
      kind: "SCHEDULED",
      schedule: {
        shopId: shop.id,
        subscriptionId: "subscription-1",
        reinstallPendingAt: now,
        expectedNextReconcileAt: now,
      },
    });
    expect(dbMock.shop.updateMany).toHaveBeenCalledWith({
      where: { id: shop.id, status: "UNINSTALLED", reinstallPendingAt: null },
      data: { reinstallPendingAt: now },
    });
    expect(dbMock.subscription.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopId: shop.id },
      update: { nextReconcileAt: now },
    }));
  });

  it("does not reset an existing reinstall attempt", async () => {
    const pendingAt = new Date("2026-09-08T12:00:00.000Z");
    const nextReconcileAt = new Date("2026-09-08T12:05:00.000Z");
    dbMock.shop.findUnique.mockResolvedValue({ status: "UNINSTALLED", reinstallPendingAt: pendingAt });
    dbMock.subscription.findUnique.mockResolvedValue({ id: "subscription-1", nextReconcileAt });
    dbMock.subscription.upsert.mockResolvedValue({ id: "subscription-1", nextReconcileAt });

    const result = await new ShopService().beginReinstallReconciliation(shop.id, new Date("2026-09-08T13:00:00.000Z"));

    expect(result).toMatchObject({
      kind: "SCHEDULED",
      schedule: { reinstallPendingAt: pendingAt, expectedNextReconcileAt: nextReconcileAt },
    });
    expect(dbMock.shop.updateMany).not.toHaveBeenCalled();
    expect(dbMock.subscription.upsert).not.toHaveBeenCalled();
  });

  it("does not restart a stopped reinstall attempt", async () => {
    const pendingAt = new Date("2026-09-08T12:00:00.000Z");
    dbMock.shop.findUnique.mockResolvedValue({ status: "UNINSTALLED", reinstallPendingAt: pendingAt });
    dbMock.subscription.findUnique.mockResolvedValue({ id: "subscription-1", nextReconcileAt: null });

    await expect(
      new ShopService().beginReinstallReconciliation(shop.id),
    ).resolves.toEqual({ kind: "NO_CHANGE" });
    expect(dbMock.shop.updateMany).not.toHaveBeenCalled();
    expect(dbMock.subscription.upsert).not.toHaveBeenCalled();
  });

  it("returns the competing durable attempt after losing the marker CAS", async () => {
    const pendingAt = new Date("2026-09-08T12:01:00.000Z");
    const nextReconcileAt = new Date("2026-09-08T12:02:00.000Z");
    dbMock.shop.findUnique
      .mockResolvedValueOnce({ status: "UNINSTALLED", reinstallPendingAt: null })
      .mockResolvedValueOnce({ status: "UNINSTALLED", reinstallPendingAt: pendingAt });
    dbMock.subscription.findUnique
      .mockResolvedValueOnce({ id: null, nextReconcileAt: null })
      .mockResolvedValueOnce({ id: "subscription-1", nextReconcileAt });
    dbMock.shop.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      new ShopService().beginReinstallReconciliation(shop.id),
    ).resolves.toEqual({
      kind: "SCHEDULED",
      schedule: {
        shopId: shop.id,
        subscriptionId: "subscription-1",
        reinstallPendingAt: pendingAt,
        expectedNextReconcileAt: nextReconcileAt,
      },
    });
    expect(dbMock.subscription.upsert).not.toHaveBeenCalled();
  });

  it("rejects retry while an attempt is still scheduled", async () => {
    const pendingAt = new Date("2026-09-08T12:00:00.000Z");
    dbMock.shop.findUnique.mockResolvedValue({ status: "UNINSTALLED", reinstallPendingAt: pendingAt });
    dbMock.subscription.findUnique.mockResolvedValue({ id: "subscription-1", nextReconcileAt: new Date() });

    await expect(
      new ShopService().retryReinstallReconciliation(shop.id),
    ).resolves.toEqual({ kind: "NO_CHANGE" });
    expect(dbMock.shop.updateMany).not.toHaveBeenCalled();
    expect(dbMock.subscription.upsert).not.toHaveBeenCalled();
  });

  it("does not update a subscription when retry loses its exact-marker CAS", async () => {
    const pendingAt = new Date("2026-09-08T12:00:00.000Z");
    dbMock.shop.findUnique.mockResolvedValue({ status: "UNINSTALLED", reinstallPendingAt: pendingAt });
    dbMock.subscription.findUnique.mockResolvedValue({ id: "subscription-1", nextReconcileAt: null });
    dbMock.shop.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      new ShopService().retryReinstallReconciliation(shop.id),
    ).resolves.toEqual({ kind: "NO_CHANGE" });
    expect(dbMock.shop.updateMany).toHaveBeenCalledWith({
      where: { id: shop.id, status: "UNINSTALLED", reinstallPendingAt: pendingAt },
      data: { reinstallPendingAt: expect.any(Date) },
    });
    expect(dbMock.subscription.upsert).not.toHaveBeenCalled();
  });

  it("successfully retries a stopped attempt without changing entitlement fields", async () => {
    const oldPendingAt = new Date("2026-09-08T12:00:00.000Z");
    const now = new Date("2026-09-08T13:00:00.000Z");
    dbMock.shop.findUnique.mockResolvedValue({ status: "UNINSTALLED", reinstallPendingAt: oldPendingAt });
    dbMock.subscription.findUnique.mockResolvedValue({ id: "subscription-1", nextReconcileAt: null });
    dbMock.shop.updateMany.mockResolvedValue({ count: 1 });
    dbMock.subscription.upsert.mockResolvedValue({ id: "subscription-1", nextReconcileAt: now });

    await expect(
      new ShopService().retryReinstallReconciliation(shop.id, now),
    ).resolves.toEqual({
      kind: "SCHEDULED",
      schedule: {
        shopId: shop.id,
        subscriptionId: "subscription-1",
        reinstallPendingAt: now,
        expectedNextReconcileAt: now,
      },
    });
    expect(dbMock.shop.updateMany).toHaveBeenCalledWith({
      where: { id: shop.id, status: "UNINSTALLED", reinstallPendingAt: oldPendingAt },
      data: { reinstallPendingAt: now },
    });
    expect(dbMock.subscription.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopId: shop.id },
      update: { nextReconcileAt: now },
    }));
  });

  it("requires durable credentials before creating a marker or schedule", async () => {
    dbMock.shop.findUnique.mockResolvedValue({
      domain: shop.domain,
      status: "UNINSTALLED",
      reinstallPendingAt: null,
    });
    dbMock.session.findFirst.mockResolvedValue(null);

    await expect(new ShopService().beginReinstallReconciliation(shop.id)).resolves.toEqual({
      kind: "AUTHENTICATION_REQUIRED",
    });
    expect(dbMock.shop.updateMany).not.toHaveBeenCalled();
    expect(dbMock.subscription.findUnique).not.toHaveBeenCalled();
    expect(dbMock.subscription.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["empty access token", { accessToken: "   ", expires: null, refreshToken: null }, false],
    ["expired token without refresh", { accessToken: "expired", expires: new Date("2026-09-07T00:00:00.000Z"), refreshToken: " " }, false],
    ["non-expiring token", { accessToken: "valid", expires: null, refreshToken: null }, true],
    ["unexpired token", { accessToken: "valid", expires: new Date("2026-09-09T00:00:00.000Z"), refreshToken: null }, true],
    ["expired but refreshable token", { accessToken: "valid", expires: new Date("2026-09-07T00:00:00.000Z"), refreshToken: "refresh" }, true],
  ] as const)("applies the durable credential predicate to %s", async (_caseName, credentials, usable) => {
    const now = new Date("2026-09-08T12:00:00.000Z");
    const nextReconcileAt = new Date("2026-09-08T12:01:00.000Z");
    dbMock.shop.findUnique.mockResolvedValue({
      domain: shop.domain,
      status: "UNINSTALLED",
      reinstallPendingAt: null,
    });
    dbMock.session.findFirst.mockResolvedValue(credentials);
    dbMock.subscription.upsert.mockResolvedValue({ id: "subscription-1", nextReconcileAt });

    const result = await new ShopService().beginReinstallReconciliation(shop.id, now);

    expect(result.kind).toBe(usable ? "SCHEDULED" : "AUTHENTICATION_REQUIRED");
    expect(dbMock.session.findFirst).toHaveBeenCalledWith({
      where: { shop: shop.domain, isOnline: false },
      select: { accessToken: true, expires: true, refreshToken: true },
      orderBy: { expires: "desc" },
    });
    if (usable) {
      expect(dbMock.shop.updateMany).toHaveBeenCalledOnce();
      expect(dbMock.subscription.upsert).toHaveBeenCalledOnce();
    } else {
      expect(dbMock.shop.updateMany).not.toHaveBeenCalled();
      expect(dbMock.subscription.upsert).not.toHaveBeenCalled();
    }
  });
});

describe("reinstall admission failure diagnostics", () => {
  it.each([
    ["beginReinstallReconciliation", "begin_reinstall_reconciliation"],
    ["retryReinstallReconciliation", "retry_reinstall_reconciliation"],
  ] as const)("emits original database evidence for %s and rethrows the same error", async (method, operation) => {
    const records: string[] = [];
    vi.spyOn(console, "error").mockImplementation((record) => { records.push(String(record)); });
    const error = Object.assign(new Error("reinstall database failure marker", {
      cause: new Error("reinstall database cause marker"),
    }), { code: "P2034" });
    dbMock.$transaction.mockRejectedValue(error);

    try {
      await expect(new ShopService()[method](shop.id)).rejects.toBe(error);
      const record = JSON.parse(records[0] ?? "{}");
      expect(record.event).toBe("shopify.lifecycle.failed");
      expect(record.data).toMatchObject({
        operation,
        stage: "transaction",
        origin: "database",
        shopId: shop.id,
        databaseCode: "P2034",
        error: { message: "reinstall database failure marker" },
        causeChain: [{ message: "reinstall database cause marker" }],
      });
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("ShopService.resolveShopifyShop", () => {
  it("creates the no-contract projection once and keeps repeated resolution read-only", async () => {
    dbMock.shop.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...shop,
        storeLocale: null,
        defaultLanguageTag: null,
        defaultTimeZone: null,
        defaultCountryCode: null,
      });
    dbMock.subscription.findUnique.mockResolvedValue({ id: "subscription-1" });
    dbMock.shopSettings.findUnique.mockResolvedValue({
      id: "settings-1",
      defaultLanguageTag: null,
      defaultTimeZone: null,
      defaultCountryCode: null,
    });
    const admin = adminFor({
      shopifyShopId: shop.shopifyShopId,
      myshopifyDomain: shop.domain,
      shopLocales: [],
    });

    const service = new ShopService();
    await service.resolveShopifyShop({
      admin,
      domain: shop.domain,
    });
    await service.resolveShopifyShop({
      admin,
      domain: shop.domain,
    });

    expect(dbMock.subscription.upsert).toHaveBeenCalledTimes(1);
    expect(dbMock.subscription.upsert).toHaveBeenCalledWith({
      where: { shopId: shop.id },
      create: {
        shopId: shop.id,
        status: "NO_CONTRACT",
        planId: null,
        observedShopifyPlanHandle: null,
        billingPeriodId: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        providerSubscriptionId: null,
        pendingShopifyPlanHandle: null,
        pendingPlanId: null,
        pendingEffectiveAt: null,
      },
      update: {},
    });
    expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each(["ACTIVE", "TRIALING"] as const)(
    "does not write an existing %s subscription projection during resolution",
    async (status) => {
      dbMock.shop.findUnique.mockResolvedValue({
        ...shop,
        storeLocale: null,
        defaultLanguageTag: null,
        defaultTimeZone: null,
        defaultCountryCode: null,
      });
      dbMock.subscription.findUnique.mockResolvedValue({ id: "subscription-1", status });
      dbMock.shopSettings.findUnique.mockResolvedValue({
        id: "settings-1",
        defaultLanguageTag: null,
        defaultTimeZone: null,
        defaultCountryCode: null,
      });
      const admin = adminFor({
        shopifyShopId: shop.shopifyShopId,
        myshopifyDomain: shop.domain,
        shopLocales: [],
      });

      await new ShopService().resolveShopifyShop({
        admin,
        domain: shop.domain,
      });

      expect(dbMock.subscription.upsert).not.toHaveBeenCalled();
      expect(dbMock.$transaction).not.toHaveBeenCalled();
    },
  );

  it("creates shared and compatibility context from the primary Shopify locale", async () => {
    const admin = adminFor({
      shopifyShopId: shop.shopifyShopId,
      myshopifyDomain: shop.domain,
      ianaTimezone: "Europe/London",
      shopAddress: { countryCodeV2: "GB" },
      shopLocales: [
        { locale: "en-GB", primary: false, published: true },
        { locale: "fr-CA", primary: true, published: true },
      ],
    });

    await new ShopService().resolveShopifyShop({
      admin,
      domain: shop.domain,
    });

    expect(dbMock.shopSettings.upsert).toHaveBeenCalledWith({
      where: { shopId: shop.id },
      create: {
        shopId: shop.id,
        defaultLanguageTag: "fr-CA",
        defaultTimeZone: "Europe/London",
        defaultCountryCode: "GB",
      },
      update: {
        defaultLanguageTag: "fr-CA",
        defaultTimeZone: "Europe/London",
        defaultCountryCode: "GB",
      },
    });

    expect(dbMock.shop.upsert).toHaveBeenCalledWith({
      where: { domain: shop.domain },
      create: {
        domain: shop.domain,
        shopifyShopId: shop.shopifyShopId,
        status: "ACTIVE",
        storeLocale: "fr-CA",
        defaultLanguageTag: "fr-CA",
        defaultTimeZone: "Europe/London",
        defaultCountryCode: "GB",
      },
      update: {
        shopifyShopId: shop.shopifyShopId,
        storeLocale: "fr-CA",
        defaultLanguageTag: "fr-CA",
        defaultTimeZone: "Europe/London",
        defaultCountryCode: "GB",
      },
    });

    const query = (admin.graphql as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as string;
    expect(query).toContain("shopLocales");
    expect(query).toMatch(
      /shop \{[\s\S]*shopAddress \{[\s\S]*\}\s*\}\s*shopLocales \{/,
    );
    expect(query).toContain("            }\n          }\n          shopLocales {");
    expect(query).not.toContain("currency");
    expect(query).not.toContain("Session.locale");
  });

  it("updates shared and compatibility context without touching the existing subscription", async () => {
    dbMock.shop.findUnique.mockResolvedValue({
      ...shop,
      storeLocale: "en-GB",
      defaultLanguageTag: "en-GB",
      defaultTimeZone: "Europe/London",
      defaultCountryCode: "GB",
    });
    dbMock.subscription.findUnique.mockResolvedValue({ id: "subscription-1" });
    dbMock.shopSettings.findUnique.mockResolvedValue({
      id: "settings-1",
      defaultLanguageTag: "en-GB",
      defaultTimeZone: "Europe/London",
      defaultCountryCode: "GB",
    });
    const admin = adminFor({
      shopifyShopId: shop.shopifyShopId,
      myshopifyDomain: shop.domain,
      ianaTimezone: "America/Toronto",
      shopAddress: { countryCodeV2: "CA" },
      shopLocales: [{ locale: "fr-CA", primary: true, published: true }],
    });

    await new ShopService().resolveShopifyShop({
      admin,
      domain: shop.domain,
    });

    expect(dbMock.shop.update).toHaveBeenCalledWith({
      where: { id: shop.id },
      data: {
        shopifyShopId: shop.shopifyShopId,
        storeLocale: "fr-CA",
        defaultLanguageTag: "fr-CA",
        defaultTimeZone: "America/Toronto",
        defaultCountryCode: "CA",
      },
    });
    expect(dbMock.shopSettings.update).toHaveBeenCalledWith({
      where: { shopId: shop.id },
      data: {
        defaultLanguageTag: "fr-CA",
        defaultTimeZone: "America/Toronto",
        defaultCountryCode: "CA",
      },
    });
    expect(dbMock.subscription.upsert).not.toHaveBeenCalled();
  });

  it("preserves a valid provider locale without requiring Moda translation coverage", async () => {
    const admin = adminFor({
      shopifyShopId: shop.shopifyShopId,
      myshopifyDomain: shop.domain,
      shopLocales: [{ locale: "haw-US", primary: true, published: true }],
    });

    await new ShopService().resolveShopifyShop({ admin, domain: shop.domain });

    expect(dbMock.shop.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        storeLocale: "haw-US",
        defaultLanguageTag: "haw-US",
      }),
      update: expect.objectContaining({
        storeLocale: "haw-US",
        defaultLanguageTag: "haw-US",
      }),
    }));
  });

  it("does not change the shop lifecycle status during resolution", async () => {
    const admin = adminFor({
      shopifyShopId: shop.shopifyShopId,
      myshopifyDomain: shop.domain,
      ianaTimezone: "UTC",
      shopAddress: { countryCodeV2: "GB" },
      shopLocales: [],
    });

    await new ShopService().resolveShopifyShop({
      admin,
      domain: shop.domain,
    });

    expect(dbMock.shop.upsert).toHaveBeenCalledWith({
      where: { domain: shop.domain },
      create: {
        domain: shop.domain,
        shopifyShopId: shop.shopifyShopId,
        status: "ACTIVE",
        storeLocale: null,
        defaultLanguageTag: null,
        defaultTimeZone: "UTC",
        defaultCountryCode: "GB",
      },
      update: {
        shopifyShopId: shop.shopifyShopId,
        defaultTimeZone: "UTC",
        defaultCountryCode: "GB",
      },
    });
  });

  it("stores null for missing or invalid optional Shopify values", async () => {
    const admin = adminFor({
      shopifyShopId: shop.shopifyShopId,
      myshopifyDomain: shop.domain,
      ianaTimezone: "Not/A-Timezone",
      shopAddress: { countryCodeV2: "XX" },
      shopLocales: [{ locale: "!!!", primary: true, published: true }],
    });

    await new ShopService().resolveShopifyShop({
      admin,
      domain: shop.domain,
    });

    expect(dbMock.shopSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          shopId: shop.id,
          defaultLanguageTag: null,
          defaultTimeZone: null,
          defaultCountryCode: null,
        },
      }),
    );
    expect(dbMock.shop.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { shopifyShopId: shop.shopifyShopId },
    }));
  });
});

describe("merchant snapshot source diagnostics", () => {
  function capture() {
    const records: string[] = [];
    vi.spyOn(console, "error").mockImplementation((record) => {records.push(String(record));});
    return records;
  }
  it("returns the already-read full scalar rows without a duplicate existence probe", async () => {
    dbMock.shop.findUnique.mockResolvedValue(shop);
    dbMock.subscription.findUnique.mockResolvedValue({id: "subscription", status: "FROZEN"});
    dbMock.shopSettings.findUnique.mockResolvedValue({id: "settings"});
    const snapshot = await new ShopService().resolveShopifyMerchantSnapshot({
      admin: adminFor({shopifyShopId: shop.shopifyShopId, myshopifyDomain: shop.domain}), domain: shop.domain,
    });
    expect(snapshot.subscription.status).toBe("FROZEN");
    expect(dbMock.subscription.findUnique).toHaveBeenCalledExactlyOnceWith({where: {shopId: shop.id}});
    expect(dbMock.shopSettings.findUnique).toHaveBeenCalledExactlyOnceWith({where: {shopId: shop.id}});
  });
  it("retains errors-only provider message, code and request ID while redacting sensitive spans", async () => {
    const records = capture();
    const admin = {graphql: vi.fn(async () => Response.json({
      errors: [{message: "profile-original-marker token=private-token-sentinel email=private@example.test https://x.test/?signature=private-url-sentinel",
        extensions: {code: "PROFILE_DENIED"}}],
    }, {headers: {"x-request-id": "provider-request-marker"}}))} as unknown as AdminApiContext;
    try {
      await expect(new ShopService().resolveShopifyMerchantSnapshot({admin, domain: shop.domain}))
        .rejects.toThrow("profile-original-marker");
      const emitted = records.join("\n");
      expect(emitted).toContain("profile-original-marker");
      expect(emitted).toContain("PROFILE_DENIED");
      expect(emitted).toContain("provider-request-marker");
      expect(emitted).toContain("provider_response");
      expect(emitted).not.toMatch(/private-token-sentinel|private@example.test|private-url-sentinel/);
      expect(dbMock.shop.findUnique).not.toHaveBeenCalled();
      expect(dbMock.$transaction).not.toHaveBeenCalled();
    } finally {vi.restoreAllMocks();}
  });
  it.each(["network", "json", "identity", "domain"])("owns %s failure and performs no writes", async (kind) => {
    const records = capture();
    const original = Object.assign(new HttpRequestError("original-failure-marker"), {cause: new Error("cause-marker")});
    const admin = {
      graphql: vi.fn(async () => {
        if (kind === "network") throw original;
        if (kind === "json") return {json: async () => {throw original;}, status: 200, headers: new Headers()};
        return Response.json({data: {shop: {shopifyShopId: kind === "identity" ? {} : shop.shopifyShopId,
          myshopifyDomain: kind === "domain" ? "foreign.myshopify.com" : shop.domain}}});
      }),
    } as unknown as AdminApiContext;
    try {
      await expect(new ShopService().resolveShopifyMerchantSnapshot({admin, domain: shop.domain})).rejects.toThrow();
      const data = JSON.parse(records[0]).data;
      expect(data.origin).toBe(kind === "network" ? "transport" : "internal");
      expect(data.providerError).toBeUndefined();
      if (kind === "network" || kind === "json") {
        expect(data.error.message).toContain("original-failure-marker");
        expect(data.causeChain[0].message).toContain("cause-marker");
      }
      expect(dbMock.shop.upsert).not.toHaveBeenCalled();
      expect(dbMock.$transaction).not.toHaveBeenCalled();
    } finally {vi.restoreAllMocks();}
  });
  it("retains multiline Prisma safe reason, actual code and cause through real Shared JSON", async () => {
    const records = capture();
    const error = Object.assign(new Error(
      "Invalid prisma.shop.findUnique() invocation:\n\nDatabase failure: original-database-marker\nConnection: postgresql://user:password@db.test/private\nCause: safe-failure-reason",
      {cause: new Error("database-cause-marker")},
    ), {code: "P2021"});
    dbMock.shop.findUnique.mockRejectedValue(error);
    try {
      await expect(new ShopService().resolveShopifyShop({
        admin: adminFor({shopifyShopId: shop.shopifyShopId, myshopifyDomain: shop.domain}), domain: shop.domain,
      })).rejects.toBe(error);
      const emitted = records.join("\n");
      expect(emitted).toContain("original-database-marker");
      expect(emitted).toContain("safe-failure-reason");
      expect(emitted).toContain("database-cause-marker");
      expect(emitted).toContain("P2021");
      expect(emitted).not.toContain("user:password");
    } finally {vi.restoreAllMocks();}
  });
  it("throwing Shared sink preserves original failure identity and successful resolution", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {throw new Error("sink-failure");});
    const error = new Error("original-database-marker");
    dbMock.shop.findUnique.mockRejectedValueOnce(error);
    const admin = adminFor({shopifyShopId: shop.shopifyShopId, myshopifyDomain: shop.domain});
    try {
      await expect(new ShopService().resolveShopifyShop({admin, domain: shop.domain})).rejects.toBe(error);
      await expect(new ShopService().resolveShopifyShop({admin, domain: shop.domain})).resolves.toEqual(shop);
    } finally {vi.restoreAllMocks();}
  });
});


it("retains installed SDK GraphqlQueryError evidence without exposing its data body", async () => {
  const records: string[] = [];
  vi.spyOn(console, "error").mockImplementation(record => {records.push(String(record));});
  const source = new GraphqlQueryError({
    message: "sdk-original-marker",
    response: {status: 200}, headers: {"x-request-id": "sdk-request-marker"},
    body: {errors: {graphQLErrors: [{message: "provider-original-marker token=private-sdk-sentinel",
      extensions: {code: "SDK_PROVIDER_CODE"}}]}, data: {privateData: "private-data-sentinel"}},
  });
  const admin = {graphql: vi.fn().mockRejectedValue(source)} as unknown as AdminApiContext;
  try {
    await expect(new ShopService().resolveShopifyShop({admin, domain: shop.domain})).rejects.toBe(source);
    const data = JSON.parse(records[0]).data;
    expect(data.origin).toBe("provider_response");
    expect(data.error.message).toBe("sdk-original-marker");
    expect(data.providerError[0].message).toContain("provider-original-marker");
    expect(data.providerError[0].code).toBe("SDK_PROVIDER_CODE");
    expect(data.providerRequestId).toBe("sdk-request-marker");
    expect(data.redactionApplied).toBe(true);
    expect(records.join("")).not.toMatch(/private-sdk-sentinel|private-data-sentinel/);
  } finally {vi.restoreAllMocks();}
});
it("rejects an authenticated provider identity that conflicts with an existing local tenant", async () => {
  const record = vi.spyOn(console, "error").mockImplementation(() => undefined);
  dbMock.shop.findUnique.mockResolvedValue({...shop, shopifyShopId: "gid://shopify/Shop/999"});
  try {
    await expect(new ShopService().resolveShopifyShop({
      admin: adminFor({shopifyShopId: shop.shopifyShopId, myshopifyDomain: shop.domain}), domain: shop.domain,
    })).rejects.toThrow("conflicts with local tenant identity");
    expect(dbMock.shop.upsert).not.toHaveBeenCalled();
    expect(dbMock.shop.update).not.toHaveBeenCalled();
    expect(dbMock.$transaction).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalled();
  } finally {vi.restoreAllMocks();}
});


it("retains actual SDK HTTP provider status and safe error excerpt", async () => {
  const records: string[] = [];
  vi.spyOn(console, "error").mockImplementation(record => {records.push(String(record));});
  const source = new HttpResponseError({
    message: "sdk-http-marker", code: 503, statusText: "Service Unavailable",
    headers: {"x-request-id": "http-request-marker"},
    body: {errors: "upstream-http-marker token=private-http-sentinel", data: "private-body-sentinel"},
  });
  const admin = {graphql: vi.fn().mockRejectedValue(source)} as unknown as AdminApiContext;
  try {
    await expect(new ShopService().resolveShopifyShop({admin, domain: shop.domain})).rejects.toBe(source);
    const data = JSON.parse(records[0]).data;
    expect(data.origin).toBe("provider_response");
    expect(data.httpStatus).toBe(503);
    expect(data.error.message).toBe("sdk-http-marker");
    expect(data.providerError.message).toContain("upstream-http-marker");
    expect(data.providerRequestId).toBe("http-request-marker");
    expect(data.redactionApplied).toBe(true);
    expect(records.join("")).not.toMatch(/private-http-sentinel|private-body-sentinel/);
  } finally {vi.restoreAllMocks();}
});


describe("merchant bootstrap unique-index race", () => {
  const input = () => ({admin: adminFor({
    shopifyShopId: shop.shopifyShopId, myshopifyDomain: shop.domain,
  }), domain: shop.domain});
  it("retries once against an exact committed tenant without another provider observation", async () => {
    const records: string[] = [];
    vi.spyOn(console, "warn").mockImplementation(record => {records.push(String(record));});
    const source = Object.assign(new Error("bootstrap-race-marker", {cause: new Error("race-cause-marker")}), {code: "P2002"});
    dbMock.shop.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(shop);
    dbMock.$transaction.mockRejectedValueOnce(source);
    const args = input();
    try {
      const result = await new ShopService().resolveShopifyMerchantSnapshot(args);
      expect(result.shop.id).toBe(shop.id);
      expect(dbMock.$transaction).toHaveBeenCalledTimes(2);
      expect(args.admin.graphql).toHaveBeenCalledTimes(1);
      const data = JSON.parse(records[0]).data;
      expect(data.databaseCode).toBe("P2002");
      expect(data.error.message).toBe("bootstrap-race-marker");
      expect(data.causeChain[0].message).toBe("race-cause-marker");
      expect(data.shopId).toBe(shop.id);
    } finally {vi.restoreAllMocks();}
  });
  it.each(["missing", "different-identity", "different-platform"])("does not retry a %s winner", async kind => {
    const source = Object.assign(new Error("bootstrap-conflict-marker"), {code: "P2002"});
    dbMock.shop.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(kind === "missing" ? null : {
      ...shop, ...(kind === "different-identity" ? {shopifyShopId: "gid://shopify/Shop/999"} : {platform: "WOOCOMMERCE"}),
    });
    dbMock.$transaction.mockRejectedValueOnce(source);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(new ShopService().resolveShopifyShop(input())).rejects.toBe(source);
      expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
    } finally {log.mockRestore();}
  });
  it("retains the second failure and never performs an unbounded retry", async () => {
    const first = Object.assign(new Error("first-race"), {code: "P2002"});
    const second = Object.assign(new Error("second-race"), {code: "P2002"});
    dbMock.shop.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(shop);
    dbMock.$transaction.mockRejectedValueOnce(first).mockRejectedValueOnce(second);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(new ShopService().resolveShopifyShop(input())).rejects.toBe(second);
      expect(dbMock.$transaction).toHaveBeenCalledTimes(2);
    } finally {vi.restoreAllMocks();}
  });
});
