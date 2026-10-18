import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encryptCredential, parseCredentialKeyring,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import {
  ShopifyPlatformConfigurationError,
  type ShopifyConfigurationKey,
} from "../../../app/services/platform-configuration/contracts.server";
import {
  createShopifyPlatformConfigurationService,
} from "../../../app/services/platform-configuration/service.server";
import {
  platformConfigurationAAD,
} from "../../../app/services/platform-configuration/seal.server";
import type {
  PlatformConfigurationDatabase, PlatformConfigurationRow,
} from "../../../app/services/platform-configuration/repository.server";

const root = parseCredentialKeyring(JSON.stringify({ "root-v1": randomBytes(32).toString("base64") }));
const otherRoot = parseCredentialKeyring(JSON.stringify({ "other-v1": randomBytes(32).toString("base64") }));
const r2 = {
  endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`, bucket: "knowledge-bucket",
  accessKeyId: "r2-user", secretAccessKey: "r2-secret", maxUploadBytes: 1024,
  maxXlsxUncompressedBytes: 2048,
};
const oauth = { apiKey: "shopify-client", apiSecret: "shopify-secret" };
const partner = { accessToken: "partner-token", organizationId: "partner_1", appId: "app_2" };

function sealed(key: ShopifyConfigurationKey, payload: unknown, revision = 1, environment = "test") {
  const envelope = encryptCredential({ keyring: root, activeKeyId: "root-v1", plaintext: JSON.stringify(payload),
    aad: platformConfigurationAAD(environment, key, revision) });
  return {
    kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM", wrappingKeyId: envelope.keyId,
    nonce: Buffer.from(envelope.nonce).toString("base64"),
    ciphertext: Buffer.from(envelope.ciphertext).toString("base64"),
    authTag: Buffer.from(envelope.authTag).toString("base64"),
  };
}

function fixture(environment = "test") {
  const rows = new Map<string, PlatformConfigurationRow>();
  const queries: string[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  let keyring = root;
  const database: PlatformConfigurationDatabase = { platformConfiguration: {
    async findUnique({ where, select }) {
      expect(select).toEqual({ environment: true, key: true, version: true, value: true });
      const { environment: env, key } = where.environment_key;
      queries.push(`${env}:${key}`);
      return rows.get(`${env}:${key}`) ?? null;
    },
  } };
  const service = createShopifyPlatformConfigurationService({
    database, environment, loadUnsealKeyring: () => keyring,
    logger: {
      info: (event, fields) => logs.push({ event, fields }),
      warn: (event, fields) => logs.push({ event, fields }),
    },
  });
  function set(key: ShopifyConfigurationKey, value: unknown, version = 1, env = environment) {
    rows.set(`${env}:${key}`, { environment: env, key, version, value });
  }
  return { service, set, queries, logs, rows, changeKeyring: (next: typeof root) => { keyring = next; } };
}

async function fails(task: Promise<unknown>, code: ShopifyPlatformConfigurationError["code"]) {
  await expect(task).rejects.toMatchObject({ name: "ShopifyPlatformConfigurationError", code });
}

describe("ARCH-043-SHOPIFY-001 three isolated server-only readers", () => {
  it("uses canonical AAD and Admin writer's sealed envelope format", async () => {
    expect(platformConfigurationAAD("test", "shopify.oauth", 5)).toBe(
      JSON.stringify(["moda-platform-config-v1", "test", "shopify.oauth", 5, 1]));
    const { service, set } = fixture();
    set("shopify.oauth", sealed("shopify.oauth", oauth, 5), 5);
    expect(await service.requireShopifyOAuthCredentials()).toEqual({ version: 5, ...oauth });
    set("shopify.partner", sealed("shopify.partner", { ...partner, apiVersion: "2026-10" }, 1));
    expect(await service.requireShopifyPartnerCredentials()).toEqual({ version: 1, ...partner, apiVersion: "2026-10" });
    set("merchant.knowledge.r2", sealed("merchant.knowledge.r2", r2));
    expect(await service.requireMerchantKnowledgeR2Configuration()).toEqual({ version: 1, ...r2 });
  });

  it("decrypts a pinned independent AES-GCM writer vector using canonical Admin AAD", async () => {
    // Independently produced with AES-256-GCM: 0x11 * 32 key, 0x22 * 12 IV.
    const fixedRoot = parseCredentialKeyring(JSON.stringify({
      "root-v1": "ERERERERERERERERERERERERERERERERERERERERERE=",
    }));
    const fixtureValue = {
      kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM", wrappingKeyId: "root-v1",
      nonce: "IiIiIiIiIiIiIiIi",
      ciphertext: "bNVmOamE+ibHBfxfJM+Mu2u+q4sS5Mhpfm1rmGCyAGA3Gt8gaYqKuy0qiFnLPiBN1ra8Hw==",
      authTag: "g3wWCk+hxCiMpWwZgCeObw==",
    };
    const { service, set } = fixture();
    // Fixture service is wired with a random key; a different root must fail.
    set("shopify.oauth", fixtureValue, 7);
    await fails(service.requireShopifyOAuthCredentials(), "UNSEAL_FAILED");
    const database: PlatformConfigurationDatabase = { platformConfiguration: {
      findUnique: async () => ({ environment: "test", key: "shopify.oauth", version: 7, value: fixtureValue }),
    } };
    const reader = createShopifyPlatformConfigurationService({
      database, environment: "test", loadUnsealKeyring: () => fixedRoot,
    });
    expect(await reader.requireShopifyOAuthCredentials()).toEqual({
      version: 7, apiKey: "client-fixed", apiSecret: "secret-fixed",
    });
  });

  it("never caches reads and does not fall back across environments", async () => {
    const { service, set, queries } = fixture();
    set("shopify.oauth", sealed("shopify.oauth", oauth, 1, "production"), 1, "production");
    await fails(service.requireShopifyOAuthCredentials(), "MISSING");
    set("shopify.oauth", sealed("shopify.oauth", oauth));
    expect((await service.requireShopifyOAuthCredentials()).version).toBe(1);
    set("shopify.oauth", sealed("shopify.oauth", { ...oauth, apiKey: "new-key" }, 2), 2);
    expect((await service.requireShopifyOAuthCredentials()).apiKey).toBe("new-key");
    set("shopify.oauth", { kind: "disabled", schemaVersion: 1 }, 3);
    await fails(service.requireShopifyOAuthCredentials(), "DISABLED");
    expect(queries).toEqual(Array(4).fill("test:shopify.oauth"));
  });

  it("rejects wrong key, version, ciphertext, AAD, envelope and wrapping root", async () => {
    const { service, set, changeKeyring } = fixture();
    const correct = sealed("shopify.oauth", oauth);
    set("shopify.oauth", correct, 2);
    await fails(service.requireShopifyOAuthCredentials(), "UNSEAL_FAILED");
    set("shopify.oauth", sealed("shopify.partner", partner));
    await fails(service.requireShopifyOAuthCredentials(), "UNSEAL_FAILED");
    set("shopify.oauth", { ...correct, ciphertext: "AAAA" });
    await fails(service.requireShopifyOAuthCredentials(), "UNSEAL_FAILED");
    set("shopify.oauth", { ...correct, extra: "not-allowed" });
    await fails(service.requireShopifyOAuthCredentials(), "INVALID_ENVELOPE");
    set("shopify.oauth", { ...correct, nonce: "invalid" });
    await fails(service.requireShopifyOAuthCredentials(), "INVALID_ENVELOPE");
    set("shopify.oauth", correct);
    changeKeyring(otherRoot);
    await fails(service.requireShopifyOAuthCredentials(), "UNSEAL_FAILED");
  });

  it("rejects incomplete, hostile and non-atomic Partner tuples", async () => {
    const { service, set } = fixture();
    for (const invalid of [
      { accessToken: "token", organizationId: "org" },
      { ...partner, appId: "invalid with spaces" },
      { ...partner, organizationId: "0".repeat(129) },
      { ...partner, apiVersion: "latest" },
      { ...partner, apiKey: "shopify OAuth" },
      { ...partner, accessToken: "" },
    ]) {
      set("shopify.partner", sealed("shopify.partner", invalid));
      await fails(service.requireShopifyPartnerCredentials(), "INVALID_VALUE");
    }
    set("shopify.partner", sealed("shopify.partner", partner));
    expect(await service.requireShopifyPartnerCredentials()).toEqual({ version: 1, ...partner });
  });

  it("rejects R2 SSRF, invalid sizes, missing credentials and plaintext rows", async () => {
    const { service, set } = fixture();
    for (const invalid of [
      { ...r2, endpoint: "http://localhost" },
      { ...r2, endpoint: "https://127.0.0.1" },
      { ...r2, endpoint: `${r2.endpoint}/bucket` },
      { ...r2, endpoint: `${r2.endpoint}?token=secret` },
      { ...r2, bucket: "../escape" },
      { ...r2, secretAccessKey: "" },
      { ...r2, maxUploadBytes: 25 * 1024 * 1024 + 1 },
      { ...r2, maxXlsxUncompressedBytes: 2_147_483_648 },
      { ...r2, maxXlsxUncompressedBytes: 10 },
      { ...r2, unexpectedField: "secret" },
    ]) {
      set("merchant.knowledge.r2", sealed("merchant.knowledge.r2", invalid));
      await fails(service.requireMerchantKnowledgeR2Configuration(), "INVALID_VALUE");
    }
    set("merchant.knowledge.r2", r2);
    await fails(service.requireMerchantKnowledgeR2Configuration(), "INVALID_ENVELOPE");
  });

  it("fails closed on database/unseal outages without logging secrets", async () => {
    const { service, set, rows, logs } = fixture();
    set("shopify.oauth", sealed("shopify.oauth", oauth));
    await service.requireShopifyOAuthCredentials();
    expect(logs.at(-1)?.fields).toMatchObject({ key: "shopify.oauth", outcome: "success", version: 1 });
    rows.delete("test:shopify.oauth");
    await fails(service.requireShopifyOAuthCredentials(), "MISSING");
    const all = JSON.stringify(logs);
    expect(all).not.toContain(oauth.apiSecret);
    expect(all).not.toContain(r2.secretAccessKey);
    expect(all).not.toContain("ciphertext");
    const unavailable = createShopifyPlatformConfigurationService({
      database: { platformConfiguration: { findUnique: async () => { throw Error("SECRET_DB_PASSWORD"); } } },
      environment: "production", loadUnsealKeyring: () => root,
    });
    await fails(unavailable.requireShopifyPartnerCredentials(), "DATABASE_UNAVAILABLE");
    const invalidEnv = createShopifyPlatformConfigurationService({
      database: { platformConfiguration: { findUnique: async () => { throw Error("should not query"); } } },
      environment: "unknown", loadUnsealKeyring: () => root,
    });
    await fails(invalidEnv.requireShopifyPartnerCredentials(), "INVALID_ENVIRONMENT");
  });
});
