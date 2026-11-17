import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  ConsentReceiptServiceError,
  initializeConsentReceiptSigningKey,
  issueConsentReceipt,
  readReturningShopperConsentStatus,
  SHOPIFY_CONSENT_RECEIPT_KEY_ENV,
  verifyConsentReceipt,
} from "../../../app/services/shopify-consent/consent-receipt.server";

const TEST_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const SHOP_ID = "cmwexample000000000000001";

beforeEach(() => {
  vi.stubEnv(SHOPIFY_CONSENT_RECEIPT_KEY_ENV, TEST_KEY);
  initializeConsentReceiptSigningKey();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Shopify consent receipts", () => {
  it("reproduces and verifies the approved v1 cart vector", () => {
    const receipt = issueConsentReceipt({
      shopId: SHOP_ID,
      kind: "c",
      token: "test-cart-token-001",
      decision: "G",
      locale: "en-GB",
      customerId: null,
    }, { now: 1_794_900_000_000 });

    expect(receipt).toBe(
      "v1.cmwexample000000000000001.c.CqNn7cXy0D3FFItDIoTupWsTV3AK9KiMvHKWdQB1pG8.G.1.en-GB.1794900000.-.4ksjVFSbs2syVaE59VAR7KoyiX6RzcjDpGkKDMriSxE",
    );
    expect(verifyConsentReceipt(receipt, {
      shopId: SHOP_ID,
      kind: "c",
      token: "test-cart-token-001",
    }, { now: 1_794_900_000_000 })).toEqual({
      shopId: SHOP_ID,
      kind: "c",
      bindingDigest: "CqNn7cXy0D3FFItDIoTupWsTV3AK9KiMvHKWdQB1pG8",
      decision: "G",
      disclosureVersion: "1",
      locale: "en-GB",
      acceptedAt: 1_794_900_000,
      customerId: "-",
    });
  });

  it("strips Ajax query suffixes and rejects copied receipts across shops or checkout tokens", () => {
    const receipt = issueConsentReceipt({
      shopId: SHOP_ID,
      kind: "c",
      token: "cart-token?key=private",
      decision: "R",
      locale: "en",
      customerId: "123",
    }, { now: 1_794_900_000_000 });

    expect(verifyConsentReceipt(receipt, {
      shopId: SHOP_ID,
      kind: "c",
      token: "cart-token",
    }, { now: 1_794_900_000_000 }).decision).toBe("R");
    expect(() => verifyConsentReceipt(receipt, {
      shopId: "cmwexample000000000000002",
      kind: "c",
      token: "cart-token",
    }, { now: 1_794_900_000_000 })).toThrowError(ConsentReceiptServiceError);
    expect(() => verifyConsentReceipt(receipt, {
      shopId: SHOP_ID,
      kind: "c",
      token: "different-cart",
    }, { now: 1_794_900_000_000 })).toThrowError(ConsentReceiptServiceError);
  });

  it("rejects malformed, tampered, noncanonical, and excessively future receipts", () => {
    const receipt = issueConsentReceipt({
      shopId: SHOP_ID,
      kind: "x",
      token: "checkout-token",
      decision: "G",
      locale: "en-GB",
      customerId: null,
    }, { now: 1_794_900_000_000 });
    const expected = { shopId: SHOP_ID, kind: "x" as const, token: "checkout-token" };

    expect(() => verifyConsentReceipt(`${receipt}.extra`, expected, { now: 1_794_900_000_000 }))
      .toThrowError(ConsentReceiptServiceError);
    expect(() => verifyConsentReceipt(receipt.replace(".G.1.", ".R.1."), expected, { now: 1_794_900_000_000 }))
      .toThrowError(ConsentReceiptServiceError);
    expect(() => verifyConsentReceipt(receipt, expected, { now: 1_794_899_699_999 }))
      .toThrowError(ConsentReceiptServiceError);
    expect(verifyConsentReceipt(receipt, expected, { now: 1_794_899_700_000 }).decision)
      .toBe("G");
  });

  it("allows historic valid receipts without an inactivity expiry", () => {
    const receipt = issueConsentReceipt({
      shopId: SHOP_ID,
      kind: "x",
      token: "historic-checkout",
      decision: "R",
      locale: "fr-CA",
      customerId: null,
    }, { now: 1_000 });

    expect(verifyConsentReceipt(receipt, {
      shopId: SHOP_ID,
      kind: "x",
      token: "historic-checkout",
    }, { now: Date.now() }).decision).toBe("R");
  });

  it("requires a canonical 32-byte deployment key and clears a previous key on invalid startup config", () => {
    vi.stubEnv(SHOPIFY_CONSENT_RECEIPT_KEY_ENV, `${TEST_KEY}=`);
    expect(() => initializeConsentReceiptSigningKey()).toThrowError(ConsentReceiptServiceError);
    expect(() => issueConsentReceipt({
      shopId: SHOP_ID,
      kind: "c",
      token: "cart-token",
      decision: "G",
      locale: "en",
      customerId: null,
    })).toThrowError(ConsentReceiptServiceError);
  });

  it("reads returning-customer consent from SQL only and leaves guests unchecked", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      phones: [{
        whatsappCanonicalPhone: "+15551234567",
        whatsappPhoneVerifiedAt: new Date(),
        whatsappConsentPurpose: "WHATSAPP_CHECKOUT_RECOVERY",
        whatsappConsentDecision: "GRANTED",
        whatsappConsentVerifiedAt: new Date(),
        whatsappNoContact: false,
      }],
    });
    const database = {
      customer: { findUnique },
    } as unknown as Pick<PrismaClient, "customer">;

    await expect(readReturningShopperConsentStatus({
      shopId: SHOP_ID,
      shopifyCustomerId: "123",
      database,
    })).resolves.toEqual({
      checked: true,
      decision: "GRANTED",
      source: "postgresql",
    });
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopId_shopifyCustomerId: { shopId: SHOP_ID, shopifyCustomerId: "123" } },
    }));

    await expect(readReturningShopperConsentStatus({
      shopId: SHOP_ID,
      shopifyCustomerId: null,
      database,
    })).resolves.toEqual({
      checked: false,
      decision: "NO_CUSTOMER",
      source: "postgresql",
    });
    expect(findUnique).toHaveBeenCalledOnce();
  });
});
