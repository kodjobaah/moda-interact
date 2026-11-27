import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  decryptCredential,
  encryptCredential,
  parseCredentialKeyring,
  resolveActiveCredentialKey,
  type CredentialEnvelope,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import {
  ConsentReceiptServiceError,
  issueConsentReceipt,
  readReturningShopperConsentStatus,
  SHOPIFY_CONSENT_RECEIPT_ATTRIBUTE,
  verifyConsentReceipt,
  verifyConsentReceiptAttributes,
} from "../../../app/services/shopify-consent/consent-receipt.server";

const KEYRING_ENV = "MODA_ENCRYPTION_KEYS_JSON";
const ACTIVE_KEY_ENV = "MODA_ENCRYPTION_ACTIVE_KEY_ID";
const SHOP_ID = "cmwexample000000000000001";
const TOKEN = "test-cart-token-001";
const NOW = 1_794_900_000_000;
const OLD_KEY = Buffer.alloc(32, 0x11).toString("base64");
const NEW_KEY = Buffer.alloc(32, 0x22).toString("base64");
const DEFAULT_KEYS = { "receipt-old": OLD_KEY };

type ExpectedReceipt = {
  shopId: string;
  kind: "c" | "x";
  token: string;
  customerId: string | null;
};

function configureKeys(
  keys: Record<string, string> = DEFAULT_KEYS,
  activeKeyId = "receipt-old",
): void {
  vi.stubEnv(KEYRING_ENV, JSON.stringify(keys));
  vi.stubEnv(ACTIVE_KEY_ENV, activeKeyId);
}

function bindingDigest(kind: "c" | "x", token: string): string {
  const boundToken = kind === "c" ? token.split("?", 1)[0] : token;
  return createHash("sha256").update(boundToken, "utf8").digest("base64url");
}

function receiptAad(expected: ExpectedReceipt): string {
  return JSON.stringify([
    "moda-shopify-wa-consent",
    1,
    expected.shopId,
    expected.kind,
    bindingDigest(expected.kind, expected.token),
  ]);
}

function decodeEnvelope(receipt: string): CredentialEnvelope {
  const parts = receipt.split(".");
  if (parts.length !== 5)
    throw new Error("Fixture receipt has the wrong field count");
  const [, keyId, nonce, ciphertext, authTag] = parts;
  if (!keyId || !nonce || !ciphertext || !authTag)
    throw new Error("Fixture receipt has empty fields");
  return {
    keyId,
    nonce: Uint8Array.from(Buffer.from(nonce, "base64url")),
    ciphertext: Uint8Array.from(Buffer.from(ciphertext, "base64url")),
    authTag: Uint8Array.from(Buffer.from(authTag, "base64url")),
  };
}

function encodeFixtureReceipt(envelope: CredentialEnvelope): string {
  return [
    "v1",
    envelope.keyId,
    Buffer.from(envelope.nonce).toString("base64url"),
    Buffer.from(envelope.ciphertext).toString("base64url"),
    Buffer.from(envelope.authTag).toString("base64url"),
  ].join(".");
}

function encryptedFixture(
  plaintext: string,
  expected: ExpectedReceipt,
): string {
  const keyring = parseCredentialKeyring(process.env[KEYRING_ENV]);
  const activeKeyId = resolveActiveCredentialKey(
    keyring,
    process.env[ACTIVE_KEY_ENV],
  );
  return encodeFixtureReceipt(
    encryptCredential({
      keyring,
      activeKeyId,
      plaintext,
      aad: receiptAad(expected),
    }),
  );
}

function fixturePayload(
  expected: ExpectedReceipt,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify([
    1,
    expected.shopId,
    expected.kind,
    bindingDigest(expected.kind, expected.token),
    "G",
    "1",
    "en-GB",
    Math.floor(NOW / 1000),
    expected.customerId ?? "-",
    ...Object.values(overrides),
  ]);
}

beforeEach(() => configureKeys());
afterEach(() => vi.unstubAllEnvs());

describe("Shopify consent receipts using the Shared credential AEAD", () => {
  it("uses the exact v1 plaintext and AAD bytes and decrypts with an independent Shared reader", () => {
    const expected: ExpectedReceipt = {
      shopId: SHOP_ID,
      kind: "c",
      token: `${TOKEN}?key=private`,
      customerId: "123",
    };
    const receipt = issueConsentReceipt(
      {
        shopId: expected.shopId,
        kind: expected.kind,
        token: expected.token,
        decision: "G",
        locale: "en-gb",
        customerId: expected.customerId,
      },
      { now: NOW },
    );

    const fields = receipt.split(".");
    expect(fields).toHaveLength(5);
    expect(fields[0]).toBe("v1");
    expect(fields[1]).toBe("receipt-old");
    expect(Buffer.byteLength(receipt, "ascii")).toBeLessThanOrEqual(512);

    const keyring = parseCredentialKeyring(process.env[KEYRING_ENV]);
    const plaintext = decryptCredential({
      keyring,
      envelope: decodeEnvelope(receipt),
      aad: receiptAad(expected),
    });
    expect(plaintext).toBe(
      JSON.stringify([
        1,
        SHOP_ID,
        "c",
        "CqNn7cXy0D3FFItDIoTupWsTV3AK9KiMvHKWdQB1pG8",
        "G",
        "1",
        "en-GB",
        1_794_900_000,
        "123",
      ]),
    );
    expect(receiptAad(expected)).toBe(
      JSON.stringify([
        "moda-shopify-wa-consent",
        1,
        SHOP_ID,
        "c",
        "CqNn7cXy0D3FFItDIoTupWsTV3AK9KiMvHKWdQB1pG8",
      ]),
    );
    expect(verifyConsentReceipt(receipt, expected, { now: NOW })).toMatchObject(
      {
        shopId: SHOP_ID,
        kind: "c",
        decision: "G",
        disclosureVersion: "1",
        locale: "en-GB",
        acceptedAt: 1_794_900_000,
        customerId: "123",
      },
    );
  });

  it("binds shop, kind, token and verified customer while stripping only the cart query suffix", () => {
    const expected: ExpectedReceipt = {
      shopId: SHOP_ID,
      kind: "c",
      token: `${TOKEN}?key=current`,
      customerId: "123",
    };
    const receipt = issueConsentReceipt(
      {
        ...expected,
        decision: "R",
        locale: "en",
      },
      { now: NOW },
    );

    expect(
      verifyConsentReceipt(
        receipt,
        {
          ...expected,
          token: TOKEN,
        },
        { now: NOW },
      ).decision,
    ).toBe("R");
    expect(() =>
      verifyConsentReceipt(
        receipt,
        {
          ...expected,
          shopId: "cmwexample000000000000002",
        },
        { now: NOW },
      ),
    ).toThrowError(ConsentReceiptServiceError);
    expect(() =>
      verifyConsentReceipt(
        receipt,
        {
          ...expected,
          kind: "x",
        },
        { now: NOW },
      ),
    ).toThrowError(ConsentReceiptServiceError);
    expect(() =>
      verifyConsentReceipt(
        receipt,
        {
          ...expected,
          token: "different-cart",
        },
        { now: NOW },
      ),
    ).toThrowError(ConsentReceiptServiceError);
    expect(() =>
      verifyConsentReceipt(
        receipt,
        {
          ...expected,
          customerId: "456",
        },
        { now: NOW },
      ),
    ).toThrowError(ConsentReceiptServiceError);
    expect(() =>
      verifyConsentReceipt(
        receipt,
        {
          ...expected,
          customerId: null,
        },
        { now: NOW },
      ),
    ).toThrowError(ConsentReceiptServiceError);

    const checkoutExpected: ExpectedReceipt = {
      shopId: SHOP_ID,
      kind: "x",
      token: "checkout-token?locator=one",
      customerId: null,
    };
    const checkoutReceipt = issueConsentReceipt(
      {
        ...checkoutExpected,
        decision: "G",
        locale: "en",
      },
      { now: NOW },
    );
    expect(
      verifyConsentReceipt(checkoutReceipt, checkoutExpected, { now: NOW })
        .kind,
    ).toBe("x");
    expect(() =>
      verifyConsentReceipt(
        checkoutReceipt,
        {
          ...checkoutExpected,
          token: "checkout-token",
        },
        { now: NOW },
      ),
    ).toThrowError(ConsentReceiptServiceError);
  });

  it("verifies one authoritative customAttributes receipt and rejects duplicates", () => {
    const expected: ExpectedReceipt = {
      shopId: SHOP_ID,
      kind: "c",
      token: TOKEN,
      customerId: null,
    };
    const receipt = issueConsentReceipt(
      {
        ...expected,
        decision: "G",
        locale: "en-GB",
      },
      { now: NOW },
    );
    const customAttributes = [
      { key: "unrelated_attribute", value: "kept" },
      { key: SHOPIFY_CONSENT_RECEIPT_ATTRIBUTE, value: receipt },
    ];

    expect(
      verifyConsentReceiptAttributes(customAttributes, expected, { now: NOW }),
    ).toMatchObject({ decision: "G", shopId: SHOP_ID });
    expect(
      verifyConsentReceiptAttributes(
        [{ key: "unrelated_attribute", value: "kept" }],
        expected,
        { now: NOW },
      ),
    ).toBeNull();
    expect(() =>
      verifyConsentReceiptAttributes(
        [
          ...customAttributes,
          { key: SHOPIFY_CONSENT_RECEIPT_ATTRIBUTE, value: receipt },
        ],
        expected,
        { now: NOW },
      ),
    ).toThrowError(ConsentReceiptServiceError);
    expect(() =>
      verifyConsentReceiptAttributes(
        [{ key: SHOPIFY_CONSENT_RECEIPT_ATTRIBUTE, value: null }],
        expected,
        { now: NOW },
      ),
    ).toThrowError(ConsentReceiptServiceError);
  });

  it("preserves old-key receipts across active-key rotation and rejects removed keys", () => {
    const expected: ExpectedReceipt = {
      shopId: SHOP_ID,
      kind: "x",
      token: "checkout-token?opaque=part-of-checkout-token",
      customerId: null,
    };
    const oldReceipt = issueConsentReceipt(
      {
        ...expected,
        decision: "G",
        locale: "fr-CA",
      },
      { now: NOW },
    );

    configureKeys(
      { "receipt-old": OLD_KEY, "receipt-new": NEW_KEY },
      "receipt-new",
    );
    expect(
      verifyConsentReceipt(oldReceipt, expected, { now: NOW }).decision,
    ).toBe("G");
    const newReceipt = issueConsentReceipt(
      {
        ...expected,
        decision: "R",
        locale: "fr-CA",
      },
      { now: NOW },
    );
    expect(newReceipt.split(".")[1]).toBe("receipt-new");
    expect(
      verifyConsentReceipt(newReceipt, expected, { now: NOW }).decision,
    ).toBe("R");

    configureKeys({ "receipt-new": NEW_KEY }, "receipt-new");
    expect(() =>
      verifyConsentReceipt(oldReceipt, expected, { now: NOW }),
    ).toThrowError(ConsentReceiptServiceError);
  });

  it("rejects malformed, noncanonical, tampered, non-ASCII and oversized envelopes", () => {
    const expected: ExpectedReceipt = {
      shopId: SHOP_ID,
      kind: "c",
      token: TOKEN,
      customerId: null,
    };
    const receipt = issueConsentReceipt(
      {
        ...expected,
        decision: "G",
        locale: "en-GB",
      },
      { now: NOW },
    );
    const parts = receipt.split(".");
    const tag = parts[4];
    if (!tag)
      throw new Error("Fixture receipt is missing its authentication tag");
    const tamperedTag = tag.replace(/^./, (first) =>
      first === "A" ? "B" : "A",
    );
    const tampered = [...parts.slice(0, 4), tamperedTag].join(".");

    for (const invalid of [
      `${receipt}.extra`,
      receipt.replace(/^v1\./, "v2."),
      `${parts[0]}.${parts[1]}.AQ.${parts[3]}.${parts[4]}`,
      `${parts[0]}.${parts[1]}.${parts[2]}=.${parts[3]}.${parts[4]}`,
      `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}.A`,
      tampered,
      `${receipt}é`,
      `v1.receipt-old.${"A".repeat(600)}.AA.AA`,
    ]) {
      expect(() =>
        verifyConsentReceipt(invalid, expected, { now: NOW }),
      ).toThrowError(ConsentReceiptServiceError);
    }
  });

  it("rejects invalid plaintext shape, unsafe future clocks and noncanonical locale claims", () => {
    const expected: ExpectedReceipt = {
      shopId: SHOP_ID,
      kind: "c",
      token: TOKEN,
      customerId: null,
    };
    const valid = issueConsentReceipt(
      {
        ...expected,
        decision: "G",
        locale: "en-GB",
      },
      { now: NOW },
    );
    expect(() =>
      verifyConsentReceipt(valid, expected, { now: NOW - 301_000 }),
    ).toThrowError(ConsentReceiptServiceError);
    expect(
      verifyConsentReceipt(valid, expected, { now: NOW - 300_000 }).decision,
    ).toBe("G");

    const malformedPlaintext = encryptedFixture(
      fixturePayload(expected, { extra: "unexpected" }),
      expected,
    );
    expect(() =>
      verifyConsentReceipt(malformedPlaintext, expected, { now: NOW }),
    ).toThrowError(ConsentReceiptServiceError);

    const noncanonicalLocale = JSON.stringify([
      1,
      SHOP_ID,
      "c",
      bindingDigest("c", TOKEN),
      "G",
      "1",
      "EN-gb",
      Math.floor(NOW / 1000),
      "-",
    ]);
    expect(() =>
      verifyConsentReceipt(
        encryptedFixture(noncanonicalLocale, expected),
        expected,
        { now: NOW },
      ),
    ).toThrowError(ConsentReceiptServiceError);
  });

  it("fails closed for missing or invalid existing deployment keyring configuration", () => {
    const expected: ExpectedReceipt = {
      shopId: SHOP_ID,
      kind: "c",
      token: TOKEN,
      customerId: null,
    };
    const receipt = issueConsentReceipt(
      {
        ...expected,
        decision: "G",
        locale: "en",
      },
      { now: NOW },
    );

    vi.stubEnv(KEYRING_ENV, "");
    expect(() =>
      issueConsentReceipt(
        {
          ...expected,
          decision: "G",
          locale: "en",
        },
        { now: NOW },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "CREDENTIAL_CONFIGURATION_UNAVAILABLE",
      }),
    );
    expect(() =>
      verifyConsentReceipt(receipt, expected, { now: NOW }),
    ).toThrowError(
      expect.objectContaining({ code: "CREDENTIAL_CONFIGURATION_UNAVAILABLE" }),
    );

    vi.stubEnv(KEYRING_ENV, "{invalid");
    expect(() =>
      issueConsentReceipt(
        {
          ...expected,
          decision: "G",
          locale: "en",
        },
        { now: NOW },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "CREDENTIAL_CONFIGURATION_UNAVAILABLE",
      }),
    );

    configureKeys(DEFAULT_KEYS, "missing-key");
    expect(() =>
      issueConsentReceipt(
        {
          ...expected,
          decision: "G",
          locale: "en",
        },
        { now: NOW },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "CREDENTIAL_CONFIGURATION_UNAVAILABLE",
      }),
    );
  });

  it("keeps maximum-sized identifiers and a long valid locale within Shopify's attribute limit", () => {
    const longestKeyId = "r".repeat(64);
    configureKeys({ [longestKeyId]: OLD_KEY }, longestKeyId);
    const receipt = issueConsentReceipt(
      {
        shopId: "a".repeat(40),
        kind: "c",
        token: TOKEN,
        decision: "G",
        locale: "en-US-u-ca-islamic-civil-nu-latn",
        customerId: "12345678901234567890",
      },
      { now: NOW },
    );
    expect(Buffer.byteLength(receipt, "ascii")).toBeLessThanOrEqual(512);
  });

  it("accepts historic valid receipts without an inactivity expiry", () => {
    const expected: ExpectedReceipt = {
      shopId: SHOP_ID,
      kind: "x",
      token: "historic-checkout",
      customerId: null,
    };
    const receipt = issueConsentReceipt(
      {
        ...expected,
        decision: "R",
        locale: "fr-CA",
      },
      { now: 1_000 },
    );

    expect(
      verifyConsentReceipt(receipt, expected, { now: Date.now() }).decision,
    ).toBe("R");
  });

  it("reads only current verified Moda Shopify consent and keeps guests unchecked", async () => {
    const currentPhone = {
      whatsappCanonicalPhone: "+15551234567",
      whatsappPhoneVerifiedAt: new Date(),
      whatsappConsentPurpose: "WHATSAPP_CHECKOUT_RECOVERY",
      whatsappConsentDecision: "GRANTED",
      whatsappConsentSource: "SHOPIFY_NATIVE",
      whatsappConsentProviderObservedAt: null,
      whatsappConsentVerifiedAt: new Date(),
      whatsappNoContact: false,
      whatsappNoContactReason: null,
      whatsappNoContactClearedAt: null,
    };
    const findUnique = vi.fn().mockResolvedValue({ phones: [currentPhone] });
    const database = {
      customer: { findUnique },
    } as unknown as Pick<PrismaClient, "customer">;

    await expect(
      readReturningShopperConsentStatus({
        shopId: SHOP_ID,
        shopifyCustomerId: "123",
        database,
      }),
    ).resolves.toEqual({
      checked: true,
      decision: "GRANTED",
      source: "postgresql",
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        shopId_shopifyCustomerId: { shopId: SHOP_ID, shopifyCustomerId: "123" },
      },
      select: {
        phones: {
          where: { endedAt: null },
          select: {
            whatsappCanonicalPhone: true,
            whatsappPhoneVerifiedAt: true,
            whatsappConsentPurpose: true,
            whatsappConsentDecision: true,
            whatsappConsentSource: true,
            whatsappConsentProviderObservedAt: true,
            whatsappConsentVerifiedAt: true,
            whatsappNoContact: true,
            whatsappNoContactReason: true,
            whatsappNoContactClearedAt: true,
          },
        },
      },
    });

    findUnique.mockResolvedValueOnce({
      phones: [
        {
          ...currentPhone,
          whatsappConsentProviderObservedAt: new Date(),
        },
      ],
    });
    await expect(
      readReturningShopperConsentStatus({
        shopId: SHOP_ID,
        shopifyCustomerId: "123",
        database,
      }),
    ).resolves.toMatchObject({ checked: false, decision: "UNVERIFIED" });

    findUnique.mockResolvedValueOnce({
      phones: [
        {
          ...currentPhone,
          whatsappConsentDecision: "REVOKED",
        },
      ],
    });
    await expect(
      readReturningShopperConsentStatus({
        shopId: SHOP_ID,
        shopifyCustomerId: "123",
        database,
      }),
    ).resolves.toMatchObject({ checked: false, decision: "REVOKED" });

    findUnique.mockResolvedValueOnce({
      phones: [
        {
          ...currentPhone,
          whatsappNoContact: true,
          whatsappNoContactReason: "CUSTOMER_STOP",
        },
      ],
    });
    await expect(
      readReturningShopperConsentStatus({
        shopId: SHOP_ID,
        shopifyCustomerId: "123",
        database,
      }),
    ).resolves.toMatchObject({ checked: false, decision: "NO_CONTACT" });

    await expect(
      readReturningShopperConsentStatus({
        shopId: SHOP_ID,
        shopifyCustomerId: null,
        database,
      }),
    ).resolves.toEqual({
      checked: false,
      decision: "NO_CUSTOMER",
      source: "postgresql",
    });
    expect(findUnique).toHaveBeenCalledTimes(4);
  });

  it("reuses Shared's base64 keyring format without exposing key material", () => {
    const key = randomBytes(32).toString("base64");
    configureKeys({ "fixture-v1": key }, "fixture-v1");
    const expected: ExpectedReceipt = {
      shopId: SHOP_ID,
      kind: "c",
      token: TOKEN,
      customerId: null,
    };
    const receipt = issueConsentReceipt(
      {
        ...expected,
        decision: "G",
        locale: "en",
      },
      { now: NOW },
    );
    expect(receipt).not.toContain(key);
    expect(verifyConsentReceipt(receipt, expected, { now: NOW }).shopId).toBe(
      SHOP_ID,
    );
  });
});
