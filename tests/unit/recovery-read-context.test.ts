import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
vi.mock("../../app/db.server", () => ({ default: {} }));
import { createRecoveryDetailReader, readRecoveryMessages, readRelatedRecoveries } from "../../app/services/recoveries/recovery-detail.server";
import { validFollowUpVariant } from "../fixtures/arch047-shopify-follow-up";
vi.mock("../../app/services/recoveries/recovery-follow-up-sender.server", () => ({ trustedRecoverySenderWaba: async () => "1234567890" }));
import { readCurrentFollowUpTemplates } from "../../app/services/recoveries/recovery-follow-up-catalogue.server";

const identity = { shopId: "shop-1", recoveryId: "recovery-1" };
const date = new Date("2026-11-01T00:00:00Z");
const owner = { id: identity.recoveryId, conversationId: "conversation-1", customerId: "customer-1",
  status: "ENGAGED", totalPrice: new Prisma.Decimal("10"), currency: "GBP", detectedAt: date };
const message = { id: "message-1", createdAt: date, direction: "INBOUND", senderType: "CUSTOMER",
  status: "DELIVERED", contentType: "TEXT", content: "Hello", transcriptionStatus: "NOT_REQUIRED" };
function database(row: unknown = owner) {
  const query = vi.fn(async (sql: Prisma.Sql) => {
    if (sql.text.includes('LEFT JOIN')) return row ? [row] : [];
    if (sql.text.includes('AS "before"')) return [{ before: false, after: false }];
    if (sql.text.includes('UNION ALL')) return [message];
    return [{ ...owner, id: "related-1" }];
  });
  return { $queryRaw: query as never, query };
}

describe("trusted recovery composition", () => {
  it("uses one full owner and five SELECTs, with navigation-only bound methods", async () => {
    const db = database(); const mutable = { ...identity };
    const reader = (await createRecoveryDetailReader(mutable, db))!;
    mutable.shopId = "forged";
    await reader.readMessages({ ...{ shopId: "forged", recoveryId: "foreign" }, window: undefined });
    await reader.readRelated();
    expect(db.query).toHaveBeenCalledTimes(5);
    expect(db.query.mock.calls.filter(([sql]) => sql.text.includes('r."lineItems"'))).toHaveLength(1);
    expect(db.query.mock.calls.flatMap(([sql]) => sql.values)).not.toContain("forged");
    expect(reader.detail).not.toHaveProperty("shopId");
    expect(reader.detail).not.toHaveProperty("readMessages");
    expect(reader.detail.id).toBe(identity.recoveryId);
  });
  it.each([null, { ...owner, conversationId: null, customerId: null }])("handles absent ownership or section links", async row => {
    const db = database(row); const reader = await createRecoveryDetailReader(identity, db);
    if (!row) expect(reader).toBeNull();
    else {
      expect((await reader!.readMessages()).items).toEqual([]);
      expect((await reader!.readRelated()).items).toEqual([]);
    }
    expect(db.query).toHaveBeenCalledTimes(1);
  });
  it.each([readRecoveryMessages, readRelatedRecoveries])("independently resolves only narrow tenant ownership", async read => {
    const db = database(); await read(identity, db);
    const sql = db.query.mock.calls[0][0];
    expect(sql.values).toEqual([identity.shopId, identity.recoveryId]);
    expect(sql.text).toContain('c."shopId" = r."shopId"');
    expect(sql.text).toContain("RECOVERY");
    expect(sql.text).not.toMatch(/lineItems|firstName|controlMode|Outreach|Moderation/);
  });
  it("does not rerun ownership for empty pages or malformed bound navigation", async () => {
    const query = vi.fn().mockResolvedValueOnce([owner]).mockResolvedValue([]);
    const reader = (await createRecoveryDetailReader(identity, { $queryRaw: query }))!;
    expect((await reader.readMessages()).items).toEqual([]);
    expect((await reader.readRelated()).items).toEqual([]);
    await expect(reader.readMessages({ cursor: "!" })).rejects.toThrow();
    await expect(reader.readRelated({ window: "latest" })).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(3);
  });
});

it("catalogue rejects a foreign snapshot and uses an inactive trusted snapshot without a fallback read", async () => {
  const shop = { id: "shop-1", status: "SUSPENDED", platform: "SHOPIFY", defaultLanguageTag: "en" } as const;
  const db = { shop: { findUnique: vi.fn() } };
  expect(await readCurrentFollowUpTemplates("shop-1", "en", db as never, shop)).toEqual([]);
  expect(await readCurrentFollowUpTemplates("other", "en", db as never, { ...shop, status: "ACTIVE" })).toEqual([]);
  expect(db.shop.findUnique).not.toHaveBeenCalled();
});


it("uses the trusted active snapshot language while retaining current variant/publication reads", async () => {
  const snapshot = { id: "shop-1", status: "ACTIVE", platform: "SHOPIFY", defaultLanguageTag: "en" } as const;
  const db = { shop: { findUnique: vi.fn().mockResolvedValue({...snapshot, defaultLanguageTag: "fr"}) },
    whatsAppTemplateVariant: { findMany: vi.fn().mockResolvedValue([validFollowUpVariant]) },
    whatsAppTemplatePublicationTarget: { findMany: vi.fn().mockResolvedValue([{newVariantId: "variant-1", metaRegistrationId: "registration-1", languageTag: "en"}]) } };
  expect(await readCurrentFollowUpTemplates("shop-1", null, db as never, snapshot)).toHaveLength(1);
  expect(db.shop.findUnique).not.toHaveBeenCalled();
  expect(db.whatsAppTemplateVariant.findMany).toHaveBeenCalledTimes(1);
  expect(db.whatsAppTemplatePublicationTarget.findMany).toHaveBeenCalledTimes(1);
  expect(await readCurrentFollowUpTemplates("shop-1", null, db as never)).toEqual([]);
  expect(db.shop.findUnique).toHaveBeenCalledTimes(1);
  db.whatsAppTemplatePublicationTarget.findMany.mockResolvedValue([]);
  expect(await readCurrentFollowUpTemplates("shop-1", null, db as never, snapshot)).toEqual([]);
});
