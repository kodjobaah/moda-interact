import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startShopifyWebhookRedis, type ShopifyWebhookRedis } from "../helpers/shopify-webhook-redis";

const { findCustomer } = vi.hoisted(() => ({ findCustomer: vi.fn() }));
vi.mock("../../app/db.server", () => ({
  default: { customer: { findUnique: findCustomer } },
}));

const {
  prepareCartMarker,
  readCartConsentStatus,
  recordCartChoice,
  shopifyConsentDigest,
  ShopifyConsentServiceError,
} = await import("../../app/services/shopify-consent/shopify-consent.server");

describe.skipIf(process.env.MODA_SHOPIFY_CONSENT_REDIS !== "1")("Shopify consent Redis contract", () => {
  let fixture: ShopifyWebhookRedis;

  beforeAll(async () => {
    fixture = await startShopifyWebhookRedis();
    vi.stubEnv("REDIS_URL", fixture.url);
  }, 60_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    await fixture.control.flushdb();
  });

  afterAll(async () => {
    await fixture?.cleanup();
    vi.unstubAllEnvs();
  }, 30_000);

  it("uses the frozen digest vectors and atomically returns one marker to concurrent preparations", async () => {
    expect(shopifyConsentDigest("cart", "shop-test-1", "cart-test-abc"))
      .toBe("0a94ff8d890538741764fd84a838b283a1b05f4f73cb6ea86e2d07bf3d9127c7");
    expect(shopifyConsentDigest("checkout", "shop-test-1", "checkout-test-xyz"))
      .toBe("7125b952f6bdaf71d8fcf620cf091989e659dfb58a9952125479110efb5039cd");

    const results = await Promise.all(Array.from({ length: 16 }, () =>
      prepareCartMarker({
        shopId: "shop-test-1",
        cartToken: "cart-test-abc?key=private-test-only",
      }),
    ));
    expect(new Set(results.map(result => result.marker)).size).toBe(1);
    expect(results.every(result => result.version === 1 && result.ownerRevision === 0)).toBe(true);

    const digest = shopifyConsentDigest("cart", "shop-test-1", "cart-test-abc");
    const cartRaw = await fixture.control.get(`shopify:consent:v1:cart:shop-test-1:${digest}`);
    const markerRaw = await fixture.control.get(`shopify:consent:v1:marker:shop-test-1:${results[0].marker}`);
    expect(JSON.parse(cartRaw!)).toMatchObject({
      v: 1,
      shopId: "shop-test-1",
      cartDigest: digest,
      marker: results[0].marker,
      choiceRevision: 0,
    });
    expect(JSON.parse(markerRaw!)).toMatchObject({ v: 1, shopId: "shop-test-1", cartDigest: digest });
    expect(await fixture.control.pttl(`shopify:consent:v1:cart:shop-test-1:${digest}`))
      .toBeGreaterThan(0);
    expect(await fixture.control.get(`shopify:consent:v1:cart:shop-test-1:${digest}`))
      .not.toContain("private-test-only");
  });

  it("records idempotent, revision-ordered cart choices without querying or writing SQL", async () => {
    const marker = (await prepareCartMarker({ shopId: "shop-test-1", cartToken: "cart-1" })).marker;
    const baseChoice = {
      shopId: "shop-test-1",
      cartToken: "cart-1",
      marker,
      actionId: "action-1",
      decision: "GRANT" as const,
      disclosureText: "Send me WhatsApp shopping updates, reminders and offers.",
      disclosureVersion: "shopify-consent-v1",
      locale: "en",
      expectedRevision: 0,
      shopifyCustomerIdAtAction: "123",
    };
    expect(await recordCartChoice(baseChoice)).toMatchObject({ acknowledged: true, decision: "GRANT", revision: 1 });
    expect(await recordCartChoice(baseChoice)).toMatchObject({ acknowledged: true, decision: "GRANT", revision: 1 });

    const revoke = await recordCartChoice({
      ...baseChoice,
      actionId: "action-2",
      decision: "REVOKE",
      expectedRevision: 1,
    });
    expect(revoke).toMatchObject({ acknowledged: true, decision: "REVOKE", revision: 2 });
    expect(await recordCartChoice(baseChoice)).toMatchObject({
      acknowledged: true,
      decision: "REVOKE",
      revision: 2,
    });
    await expect(recordCartChoice({
      ...baseChoice,
      decision: "REVOKE",
      expectedRevision: 2,
    })).rejects.toMatchObject({ code: "ACTION_ID_CONFLICT" });

    const status = await readCartConsentStatus({
      shopId: "shop-test-1",
      cartToken: "cart-1",
      shopifyCustomerId: "123",
    });
    expect(status).toEqual({
      checked: false,
      decision: "REVOKE",
      source: "current_cart",
      revision: 2,
    });
    expect(findCustomer).not.toHaveBeenCalled();
  });

  it("uses PostgreSQL for a new cart, then lets the same cart's explicit Redis choice override it", async () => {
    findCustomer.mockResolvedValue({
      phones: [{
        whatsappCanonicalPhone: "447700900123",
        whatsappPhoneVerifiedAt: new Date(),
        whatsappConsentPurpose: "WHATSAPP_CHECKOUT_RECOVERY",
        whatsappConsentDecision: "GRANTED",
        whatsappConsentVerifiedAt: new Date(),
        whatsappNoContact: false,
      }],
    });
    const initial = await readCartConsentStatus({
      shopId: "shop-test-1",
      cartToken: "cart-new",
      shopifyCustomerId: "123",
    });
    expect(initial).toEqual({
      checked: true,
      decision: "GRANTED",
      source: "postgresql",
      revision: null,
    });
    expect(findCustomer).toHaveBeenCalledOnce();

    const marker = (await prepareCartMarker({ shopId: "shop-test-1", cartToken: "cart-new" })).marker;
    await recordCartChoice({
      shopId: "shop-test-1",
      cartToken: "cart-new",
      marker,
      actionId: "action-revoke",
      decision: "REVOKE",
      disclosureText: "Send me WhatsApp shopping updates, reminders and offers.",
      disclosureVersion: "shopify-consent-v1",
      locale: "en",
      expectedRevision: 0,
      shopifyCustomerIdAtAction: "123",
    });
    findCustomer.mockClear();

    const overridden = await readCartConsentStatus({
      shopId: "shop-test-1",
      cartToken: "cart-new",
      shopifyCustomerId: "123",
    });
    expect(overridden).toEqual({
      checked: false,
      decision: "REVOKE",
      source: "current_cart",
      revision: 1,
    });
    expect(findCustomer).not.toHaveBeenCalled();
  });

  it("rejects stale writes and cross-shop use of a prepared marker", async () => {
    const marker = (await prepareCartMarker({ shopId: "shop-test-1", cartToken: "cart-race" })).marker;
    const choice = {
      shopId: "shop-test-1",
      cartToken: "cart-race",
      marker,
      disclosureText: "Send me WhatsApp shopping updates, reminders and offers.",
      disclosureVersion: "shopify-consent-v1",
      locale: "en",
      expectedRevision: 0,
      shopifyCustomerIdAtAction: null,
    };
    const writes = await Promise.allSettled([
      recordCartChoice({ ...choice, actionId: "race-a", decision: "GRANT" }),
      recordCartChoice({ ...choice, actionId: "race-b", decision: "REVOKE" }),
    ]);
    expect(writes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter(result =>
      result.status === "rejected" && result.reason instanceof ShopifyConsentServiceError &&
      result.reason.code === "STALE_REVISION",
    )).toHaveLength(1);

    await expect(recordCartChoice({
      ...choice,
      shopId: "shop-test-2",
      actionId: "foreign-shop",
      decision: "GRANT",
    })).rejects.toMatchObject({ code: "RECORD_CONFLICT" });
  });
});
