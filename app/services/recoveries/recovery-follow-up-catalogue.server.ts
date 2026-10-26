import { Prisma } from "@prisma/client";
import { canonicaliseLanguageTag } from "@modainteract/moda-interact-shared/internationalization";
import prisma from "../../db.server";
import { trustedRecoverySenderWaba } from "./recovery-follow-up-sender.server";

const FOLLOW_UP_PURPOSES = ["FOLLOW_UP_NO_OFFER", "FOLLOW_UP_CODE_OFFER", "FOLLOW_UP_AUTOMATIC_OFFER"] as const;
const NO_OFFER = "FOLLOW_UP_NO_OFFER";
const MAX_ROWS = 180;

type CatalogueDatabase = Pick<Prisma.TransactionClient, "shop" | "whatsAppTemplateVariant" | "whatsAppTemplatePublicationTarget" | "platformConfiguration">;
export type FollowUpTemplateChoice = Readonly<{
  id: string;
  name: string;
  language: string;
  purpose: typeof FOLLOW_UP_PURPOSES[number];
  providerLanguageCode: string;
}>;

/** Invalid language is not silently converted to English. It is unsafe to
 * select a different translated Meta template on behalf of the customer.
 */
function canonicalLanguage(value: string | null | undefined): string | null {
  if (!value) return null;
  try { return canonicaliseLanguageTag(value); } catch { return null; }
}

function preferredLanguages(conversationLanguageTag: string | null, merchantLanguageTag: string | null): string[] {
  if (conversationLanguageTag && !canonicalLanguage(conversationLanguageTag) ||
      merchantLanguageTag && !canonicalLanguage(merchantLanguageTag)) return [];
  const customer = canonicalLanguage(conversationLanguageTag);
  const merchant = canonicalLanguage(merchantLanguageTag);
  const candidates = [customer, customer ? new Intl.Locale(customer).language : null, merchant];
  return [...new Set(candidates.filter((tag): tag is string => Boolean(tag)))];
}

/** A provider APPROVED row alone is never publication or source identity.
 * Cross-check the immutable Moda definition, locale and exact saved Meta registration.
 * Background performs a fresh independent check at dispatch.
 */
function isCurrentModaPublication(row: CatalogueVariant, wabaId: string): boolean {
  const registration = row.metaRegistration;
  if (!registration || !row.metaRegistrationId || row.metaRegistrationId !== registration.id ||
      !row.providerTemplateId || registration.providerTemplateId !== row.providerTemplateId ||
      registration.wabaId !== wabaId || row.providerAccountId !== wabaId ||
      registration.providerTemplateName !== row.providerTemplateName ||
      registration.providerLanguageCode !== row.providerLanguageCode ||
      registration.providerStatus !== "APPROVED" ||
      !["SUBMITTED", "CONFIRMED", "APPROVED"].includes(registration.submissionState) ||
      registration.failureCode !== null || registration.driftDetectedAt !== null ||
      registration.lastObservedContentHash !== null &&
        registration.lastObservedContentHash !== registration.submittedContentHash ||
      registration.lastObservedCategory !== null && registration.lastObservedCategory !== registration.category) return false;
  const locale = registration.locale;
  const definition = locale.definition;
  const expectedOffer = row.purpose.slice("FOLLOW_UP_".length);
  // The immutable English source is saved as SOURCE_SAVED by ADMIN-003;
  // translations require a completed review. Provider approval and a
  // SUCCEEDED shop target are separate, mandatory checks for both paths.
  const reviewed = locale.status === "REVIEWED" ||
    (locale.status === "SOURCE_SAVED" && locale.languageTag === "en" &&
      definition.sourceLanguageTag === "en");
  return row.enabled && row.status === "APPROVED" &&
    row.purpose.startsWith("FOLLOW_UP_") && reviewed &&
    canonicalLanguage(locale.languageTag) === canonicalLanguage(row.languageTag) &&
    (locale.providerLanguageCode === null || locale.providerLanguageCode === row.providerLanguageCode) &&
    Boolean(locale.contentHash) && locale.contentHash === registration.submittedContentHash &&
    definition.kind === "META_RECOVERY" && definition.purpose === "FOLLOW_UP" &&
    definition.offerType === expectedOffer && definition.providerTemplateName === row.providerTemplateName &&
    definition.category === registration.category && definition.status === "PUBLISHED" &&
    Boolean(definition.publishedAt) && definition.retiredAt === null;
}

/** Query a bounded superset including legacy/unlinked rows. Hiding such rows
 * before ambiguity checking could make an unsafe shop/language slot appear unique.
 */
const variantSelect = {
  id: true, shopId: true, providerAccountId: true, purpose: true,
  languageTag: true, providerTemplateName: true, providerTemplateId: true,
  providerLanguageCode: true, metaRegistrationId: true, status: true, enabled: true,
  metaRegistration: { select: {
    id: true, wabaId: true, providerTemplateName: true, providerLanguageCode: true,
    providerTemplateId: true, providerStatus: true, submissionState: true,
    category: true, failureCode: true, submittedContentHash: true,
    lastObservedContentHash: true, lastObservedCategory: true, driftDetectedAt: true,
    locale: { select: {
      languageTag: true, providerLanguageCode: true, status: true, contentHash: true,
      definition: { select: {
        kind: true, purpose: true, offerType: true, sourceLanguageTag: true, providerTemplateName: true,
        category: true, status: true, publishedAt: true, retiredAt: true,
      } },
    } },
  } },
} as const satisfies Prisma.WhatsAppTemplateVariantSelect;
type CatalogueVariant = Prisma.WhatsAppTemplateVariantGetPayload<{ select: typeof variantSelect }>;

/** Only the no-offer purpose is selectable until BG007 supplies verified,
 * checkout-specific positive-offer evidence. A stored initial offer or merchant
 * configuration is not provider proof and must not enable a CODE/AUTOMATIC choice.
 */
export function eligibleFollowUpChoices(rows: readonly CatalogueVariant[], input: {
  shopId: string; wabaId: string; conversationLanguageTag: string | null;
  merchantLanguageTag: string | null;
}): FollowUpTemplateChoice[] {
  const languages = preferredLanguages(input.conversationLanguageTag, input.merchantLanguageTag);
  if (!languages.length || rows.length > MAX_ROWS || rows.some((r) =>
    r.shopId !== input.shopId || r.providerAccountId !== input.wabaId ||
    !FOLLOW_UP_PURPOSES.includes(r.purpose as typeof FOLLOW_UP_PURPOSES[number]) ||
    r.status !== "APPROVED" || !r.enabled || !canonicalLanguage(r.languageTag))) return [];

  for (const language of languages) {
    const matches = rows.filter((row) => row.purpose === NO_OFFER && canonicalLanguage(row.languageTag) === language);
    if (!matches.length) continue;
    // More than one candidate in the same purpose/language is not a choice.
    // Do not fall through to a different language after encountering ambiguity.
    if (matches.length !== 1 || !isCurrentModaPublication(matches[0], input.wabaId)) return [];
    const variant = matches[0];
    return [{ id: variant.id, name: variant.providerTemplateName, language,
      purpose: NO_OFFER, providerLanguageCode: variant.providerLanguageCode }];
  }
  return [];
}

/** Same function runs for both authenticated loader and serializable command
 * admission. Never accepts a browser-supplied WABA, language or Meta name.
 */
export async function readCurrentFollowUpTemplates(
  shopId: string, conversationLanguageTag: string | null,
  db: CatalogueDatabase = prisma,
  sender: (db: CatalogueDatabase) => Promise<string> = trustedRecoverySenderWaba,
): Promise<FollowUpTemplateChoice[]> {
  const shop = await db.shop.findUnique({ where: { id: shopId },
    select: { status: true, platform: true, defaultLanguageTag: true } });
  if (!shop || shop.status !== "ACTIVE" || shop.platform !== "SHOPIFY") return [];
  const wabaId = await sender(db);
  if (!/^\d{4,32}$/.test(wabaId)) return [];
  const rows = await db.whatsAppTemplateVariant.findMany({
    where: { shopId, providerAccountId: wabaId, purpose: { in: [...FOLLOW_UP_PURPOSES] },
      enabled: true, status: "APPROVED" },
    select: variantSelect, take: MAX_ROWS + 1,
  });
  const selected = eligibleFollowUpChoices(rows, {
    shopId, wabaId, conversationLanguageTag, merchantLanguageTag: shop.defaultLanguageTag,
  });
  if (!selected.length) return [];
  // A published definition and registration are necessary but insufficient:
  // require durable evidence of this shop/language/variant's successful
  // Admin publication, not an adopted or hand-inserted catalogue record.
  const targets = await db.whatsAppTemplatePublicationTarget.findMany({
    where: { shopId, status: "SUCCEEDED", newVariantId: selected[0].id },
    select: { newVariantId: true, metaRegistrationId: true, languageTag: true },
    take: 2,
  });
  const matching = rows.find((row) => row.id === selected[0].id);
  if (!matching || !targets.some((target) =>
    target.newVariantId === selected[0].id &&
    target.metaRegistrationId === matching.metaRegistrationId &&
    canonicalLanguage(target.languageTag) === selected[0].language)) return [];
  return selected;
}
