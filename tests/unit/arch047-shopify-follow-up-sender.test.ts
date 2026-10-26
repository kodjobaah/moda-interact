import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
const { trustedRecoverySenderWaba } = await import(
  "../../app/services/recoveries/recovery-follow-up-sender.server"
);

afterEach(() => vi.unstubAllEnvs());
const db = (row: unknown) => ({
  platformConfiguration: { findUnique: vi.fn(async () => row) },
}) as unknown as Pick<Prisma.TransactionClient, "platformConfiguration">;

describe("ARCH-047 Shopify authoritative sender WABA", () => {
  it("uses a strictly valid environment fallback only when the ARCH-043 row is absent", async () => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT_NAME", "test");
    vi.stubEnv("WHATSAPP_BUSINESS_ACCOUNT_ID", "1234567890");
    const missing = db(null);
    expect(await trustedRecoverySenderWaba(missing)).toBe("1234567890");
    expect(missing.platformConfiguration.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { environment_key: { environment: "test", key: "messaging.sender" } },
    }));
    vi.stubEnv("WHATSAPP_BUSINESS_ACCOUNT_ID", "other-account");
    await expect(trustedRecoverySenderWaba(db(null))).rejects.toThrow();
  });
  it("does not fall back after a configured but unavailable sealed sender", async () => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT_NAME", "test");
    vi.stubEnv("WHATSAPP_BUSINESS_ACCOUNT_ID", "1234567890");
    vi.stubEnv("MODA_CONFIG_UNSEAL_KEY", "");
    await expect(trustedRecoverySenderWaba(db({ environment: "test", key: "messaging.sender",
      version: 1, value: { kind: "disabled", schemaVersion: 1 } }))).rejects.toThrow();
  });
  it("never treats a database error as a missing record eligible for environment fallback", async () => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT_NAME", "test");
    vi.stubEnv("WHATSAPP_BUSINESS_ACCOUNT_ID", "1234567890");
    const broken = { platformConfiguration: { findUnique: vi.fn(async () => { throw new Error("db down"); }) } };
    await expect(trustedRecoverySenderWaba(broken as never)).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
  });
});
