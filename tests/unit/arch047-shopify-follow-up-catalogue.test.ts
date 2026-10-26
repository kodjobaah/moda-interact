import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { validFollowUpVariant, WABA } from "../fixtures/arch047-shopify-follow-up";
vi.mock("../../app/db.server", () => ({ default: {} }));
const { eligibleFollowUpChoices, readCurrentFollowUpTemplates } =
  await import("../../app/services/recoveries/recovery-follow-up-catalogue.server");

const example = () => structuredClone(validFollowUpVariant);
const options = { shopId: "shop-1", wabaId: WABA, conversationLanguageTag: "en-GB", merchantLanguageTag: "fr" };
const eligible = (...rows: unknown[]) => eligibleFollowUpChoices(rows as never, options);

function fixture(rows: unknown[] = [example()], shop = { status: "ACTIVE", platform: "SHOPIFY", defaultLanguageTag: "en" }) {
  const db = { shop: { findUnique: vi.fn(async () => shop) },
    whatsAppTemplateVariant: { findMany: vi.fn(async () => rows) },
    whatsAppTemplatePublicationTarget: { findMany: vi.fn(async () => [{
      newVariantId: "variant-1", metaRegistrationId: "registration-1", languageTag: "en",
    }]) } } as unknown as PrismaClient;
  return { db, ...db };
}

const updated = (mutate: (row: ReturnType<typeof example>) => void) => {
  const value = example(); mutate(value); return value;
};

describe("ARCH-047 Shopify current, published follow-up catalogue", () => {
  it("resolves conversation's exact language before base and merchant fallback", () => {
    expect(eligible(example())).toEqual([expect.objectContaining({
      id: "variant-1", language: "en", purpose: "FOLLOW_UP_NO_OFFER", providerLanguageCode: "en",
    })]);
    const fr = updated((row) => {
      row.languageTag = "fr"; row.providerLanguageCode = "fr";
      row.metaRegistration.providerLanguageCode = "fr";
      row.metaRegistration.locale.languageTag = "fr";
      row.metaRegistration.locale.providerLanguageCode = "fr";
    });
    expect(eligibleFollowUpChoices([fr] as never, { ...options, conversationLanguageTag: "fr" }))
      .toEqual([expect.objectContaining({ language: "fr" })]);
    expect(eligibleFollowUpChoices([fr] as never, options)).toEqual([expect.objectContaining({ language: "fr" })]);
  });

  it.each([
    ["legacy unlinked", (r: ReturnType<typeof example>) => { r.metaRegistrationId = null as never; }],
    ["foreign tenant", (r: ReturnType<typeof example>) => { r.shopId = "other"; }],
    ["foreign WABA", (r: ReturnType<typeof example>) => { r.providerAccountId = "222233334444"; }],
    ["provider identity", (r: ReturnType<typeof example>) => { r.providerTemplateId = "spoofed"; }],
    ["name identity", (r: ReturnType<typeof example>) => { r.metaRegistration.providerTemplateName = "foreign"; }],
    ["locale identity", (r: ReturnType<typeof example>) => { r.metaRegistration.locale.languageTag = "de"; }],
    ["wrong locale code", (r: ReturnType<typeof example>) => { r.metaRegistration.locale.providerLanguageCode = "fr"; }],
    ["retired definition", (r: ReturnType<typeof example>) => { r.metaRegistration.locale.definition.retiredAt = new Date() as never; }],
    ["draft definition", (r: ReturnType<typeof example>) => { r.metaRegistration.locale.definition.status = "SAVED"; }],
    ["unpublished definition", (r: ReturnType<typeof example>) => { r.metaRegistration.locale.definition.publishedAt = null as never; }],
    ["foreign definition purpose", (r: ReturnType<typeof example>) => { r.metaRegistration.locale.definition.purpose = "INITIAL"; }],
    ["unreviewed locale", (r: ReturnType<typeof example>) => { r.metaRegistration.locale.status = "PENDING"; }],
    ["stale locale content", (r: ReturnType<typeof example>) => { r.metaRegistration.locale.contentHash = "bad"; }],
    ["pending provider", (r: ReturnType<typeof example>) => { r.metaRegistration.providerStatus = "PENDING"; }],
    ["failed registration", (r: ReturnType<typeof example>) => { r.metaRegistration.failureCode = "REJECTED" as never; }],
    ["drift flag", (r: ReturnType<typeof example>) => { r.metaRegistration.driftDetectedAt = new Date() as never; }],
    ["content drift", (r: ReturnType<typeof example>) => { r.metaRegistration.lastObservedContentHash = "bad"; }],
    ["category drift", (r: ReturnType<typeof example>) => { r.metaRegistration.lastObservedCategory = "UTILITY"; }],
    ["disabled variant", (r: ReturnType<typeof example>) => { r.enabled = false; }],
    ["unapproved variant", (r: ReturnType<typeof example>) => { r.status = "PAUSED"; }],
    ["obsolete purpose", (r: ReturnType<typeof example>) => { r.purpose = "checkout-recovery"; }],
  ] as Array<[string, (row: ReturnType<typeof example>) => void]>)(
    "rejects %s without falling back to a different template",
    (_, mutate) => {
      expect(eligible(updated(mutate))).toEqual([]);
    },
  );

  it("accepts the immutable published English source while requiring review of translated locales", () => {
    const english = updated((row) => { row.metaRegistration.locale.status = "SOURCE_SAVED"; });
    expect(eligible(english)).toEqual([expect.objectContaining({ language: "en" })]);
    const french = updated((row) => {
      row.languageTag = "fr"; row.providerLanguageCode = "fr";
      row.metaRegistration.providerLanguageCode = "fr";
      row.metaRegistration.locale.languageTag = "fr";
      row.metaRegistration.locale.providerLanguageCode = "fr";
      row.metaRegistration.locale.status = "SOURCE_SAVED";
    });
    expect(eligibleFollowUpChoices([french] as never, { ...options, conversationLanguageTag: "fr" })).toEqual([]);
  });

  it("rejects ambiguous active rows in the same shop/purpose/language slot, even when one is unlinked", () => {
    const duplicate = updated((r) => { r.id = "new-variant"; r.metaRegistrationId = null as never; });
    expect(eligible(example(), duplicate)).toEqual([]);
  });
  it("never treats a configured initial offer as verified checkout-specific savings", () => {
    for (const offer of ["CODE_OFFER", "AUTOMATIC_OFFER"]) {
      const row = updated((r) => {
        r.purpose = `FOLLOW_UP_${offer}`;
        r.metaRegistration.locale.definition.offerType = offer;
      });
      expect(eligible(row)).toEqual([]);
    }
  });
  it("rejects invalid customer/merchant language and >180 active records", () => {
    expect(eligibleFollowUpChoices([example()] as never,
      { ...options, conversationLanguageTag: "invalid_language!" })).toEqual([]);
    expect(eligibleFollowUpChoices([example()] as never,
      { ...options, merchantLanguageTag: "invalid_language!" })).toEqual([]);
    expect(eligibleFollowUpChoices(Array.from({ length: 181 }, example) as never, options)).toEqual([]);
  });
  it("checks the authenticated Shopify shop and configured WABA before querying rows", async () => {
    const { db } = fixture();
    expect(await readCurrentFollowUpTemplates("shop-1", "en", db, async () => WABA))
      .toEqual([expect.objectContaining({ id: "variant-1" })]);
    expect((db.whatsAppTemplateVariant.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where)
      .toMatchObject({ shopId: "shop-1", providerAccountId: WABA, status: "APPROVED", enabled: true });
    expect(await readCurrentFollowUpTemplates("shop-1", "en", fixture([], { status: "UNINSTALLED", platform: "SHOPIFY", defaultLanguageTag: "en" }).db, async () => WABA)).toEqual([]);
    expect(await readCurrentFollowUpTemplates("shop-1", "en", fixture([], { status: "ACTIVE", platform: "WOOCOMMERCE", defaultLanguageTag: "en" }).db, async () => WABA)).toEqual([]);
    const foreign = fixture([updated((r) => { r.shopId = "shop-2"; })]);
    expect(await readCurrentFollowUpTemplates("shop-1", "en", foreign.db, async () => WABA)).toEqual([]);
    const notPublished = fixture();
    (notPublished.db.whatsAppTemplatePublicationTarget.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    expect(await readCurrentFollowUpTemplates("shop-1", "en", notPublished.db, async () => WABA)).toEqual([]);
    const wrongRegistration = fixture();
    (wrongRegistration.db.whatsAppTemplatePublicationTarget.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { newVariantId: "variant-1", metaRegistrationId: "foreign", languageTag: "en" },
    ]);
    expect(await readCurrentFollowUpTemplates("shop-1", "en", wrongRegistration.db, async () => WABA)).toEqual([]);
  });
});
