import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_ID, WABA, commonWrapperFixture, languages, recoveryDefaultFixture } from "../fixtures/onboarding-recovery-defaults";

const mocks = vi.hoisted(() => ({ sender: vi.fn() }));
vi.mock("../../app/services/recoveries/recovery-follow-up-sender.server", () => ({ trustedRecoverySenderWaba: mocks.sender }));
vi.mock("../../app/db.server", () => ({ default: {} }));
import { ONBOARDING_TEMPLATE_PURPOSES, ensureOnboardingRecoveryTemplatesBestEffort } from "../../app/services/recoveries/onboarding-template-assignments.server";
import { assignOnePurpose, type OnboardingTemplatePurpose } from "../../app/services/recoveries/onboarding-template-publication.server";

const shopId = "cm123456789012345678901234";
const purpose = "INITIAL_NO_OFFER";
type Variant = { id: string; purpose: string; languageTag: string; providerAccountId: string; metaRegistrationId: string;
  providerTemplateName?: string; providerLanguageCode?: string };

function scenario(options: { missing?: boolean; existing?: "complete" | "partial"; common?: boolean } = {}) {
  const rows: Variant[] = [];
  const common = options.common ? commonWrapperFixture() : undefined;
  let activeCommon = common;
  const definitions = new Map(ONBOARDING_TEMPLATE_PURPOSES.map(p => [p, recoveryDefaultFixture(p, "one", common)]));
  const pointers = new Map(ONBOARDING_TEMPLATE_PURPOSES.map(p => [p, { id: `default-${p}`, definitionId: definitions.get(p)!.id,
    updatedByAdminId: ADMIN_ID, updatedAt: new Date("2026-11-24T16:30:00Z") }]));
  if (options.missing) pointers.clear();
  if (options.existing) for (const p of ONBOARDING_TEMPLATE_PURPOSES) {
    for (const languageTag of options.existing === "complete" ? languages : languages.slice(0, 1)) {
      rows.push({ id: `existing-${p}-${languageTag}`, purpose: p, languageTag, providerAccountId: WABA, metaRegistrationId: `previous-${languageTag}` });
    }
  }
  const findDefinition = (id: string) => [...definitions.values()].find(def => def.id === id);
  const tx = {
    $queryRaw: vi.fn(async (query: TemplateStringsArray, ...args: unknown[]) => {
      const sql = query.join("?");
      if (sql.includes('FROM "whatsapp"."WhatsAppTemplateMetaRegistration"')) return findDefinition(String(args[0]))?.locales
        .flatMap(locale => locale.metaRegistrations.filter(reg => reg.wabaId === args[1]).map(reg => ({ id: reg.id }))) ?? [];
      if (sql.includes('FROM "whatsapp"."WhatsAppTemplateLocale"')) return findDefinition(String(args[0]))?.locales.map(locale => ({ id: locale.id })) ?? [];
      return [];
    }),
    shop: { findUnique: vi.fn().mockResolvedValue({ id: shopId, platform: "SHOPIFY", status: "ACTIVE", onboardingCompleted: true }) },
    whatsAppTemplateVariant: {
      findMany: vi.fn(async ({ where }: { where: { purpose: string; providerAccountId?: string } }) => rows.filter(row =>
        row.purpose === where.purpose && (!where.providerAccountId || row.providerAccountId === where.providerAccountId))),
      createMany: vi.fn(async ({ data }: { data: Omit<Variant, "id">[] }) => {
        for (const item of data) rows.push({ id: `new-${item.purpose}-${item.languageTag}`, ...item });
        return { count: data.length };
      }),
    },
    whatsAppRecoveryTemplateDefault: { findUnique: vi.fn(async ({ where }: { where: { wabaId_purpose: { wabaId: string; purpose: OnboardingTemplatePurpose } } }) =>
      where.wabaId_purpose.wabaId === WABA ? pointers.get(where.wabaId_purpose.purpose) ?? null : null) },
    whatsAppTemplatePublicationOperation: {
      findFirst: vi.fn().mockResolvedValue({ id: "old-all-shops-publication" }),
      create: vi.fn<(input: { data: { scopeSnapshot: Record<string, unknown> & { automatedOnboarding: Record<string, unknown> } } }) => Promise<{ id: string }>>().mockResolvedValue({ id: "new-publication" }),
    },
    whatsAppTemplatePublicationTarget: {
      createMany: vi.fn().mockResolvedValue({ count: 20 }),
      findMany: vi.fn(async ({ where }: { where: { newVariantId: { in: string[] } } }) => rows.filter(row => where.newVariantId.in.includes(row.id))
        .map(row => ({ newVariantId: row.id, languageTag: row.languageTag, metaRegistrationId: row.metaRegistrationId }))),
    },
    whatsAppTemplateDefinition: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => findDefinition(where.id)) },
    whatsAppConversationWrapperActiveSlot: { findUnique: vi.fn(async () => activeCommon ? { definitionId: activeCommon.id, definition: activeCommon } : null) },
  };
  const db = { $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)) };
  const reporter = { report: vi.fn().mockResolvedValue({ incidentKey: "key", recorded: true, occurrenceCount: 1, status: "OPEN" }) };
  return { tx, db, rows, reporter, definitions, pointers, setCommon: (wrapper: typeof common) => { activeCommon = wrapper; } };
}
const run = (f: ReturnType<typeof scenario>) => ensureOnboardingRecoveryTemplatesBestEffort(shopId, f.db as never, f.reporter);
const assign = (f: ReturnType<typeof scenario>) => assignOnePurpose(f.tx as never, shopId, purpose, WABA);

beforeEach(() => { vi.clearAllMocks(); mocks.sender.mockResolvedValue(WABA); });

describe("Shopify onboarding recovery template provisioning", () => {
  it("reports missing explicit defaults even if old publication history exists", async () => {
    const f = scenario({ missing: true }); await run(f);
    expect(f.reporter.report).toHaveBeenCalledTimes(6);
    expect(f.reporter.report.mock.calls[0]?.[0]).toMatchObject({ category: "WHATSAPP_TEMPLATE_PROVISIONING",
      reasonCode: "NO_APPROVED_DEFAULT", shopId, resourceKey: `${shopId}:INITIAL_NO_OFFER` });
    expect(f.reporter.report.mock.calls[0]?.[0].errorMessage).toContain("Set as default");
    expect(f.tx.whatsAppTemplatePublicationOperation.findFirst).not.toHaveBeenCalled();
    expect(f.tx.whatsAppTemplateVariant.createMany).not.toHaveBeenCalled();
  });

  it("inherits exactly six configured definitions and writes 120 locale assignments with truthful provenance", async () => {
    const f = scenario(); await run(f);
    expect(f.rows).toHaveLength(120);
    expect(f.tx.whatsAppRecoveryTemplateDefault.findUnique).toHaveBeenCalledTimes(6);
    expect(f.tx.whatsAppTemplatePublicationOperation.findFirst).not.toHaveBeenCalled();
    expect(f.tx.whatsAppTemplateVariant.createMany).toHaveBeenCalledTimes(6);
    expect(f.tx.whatsAppTemplatePublicationTarget.createMany).toHaveBeenCalledTimes(6);
    expect(f.tx.whatsAppTemplatePublicationOperation.create).toHaveBeenCalledTimes(6);
    expect(f.tx.whatsAppTemplatePublicationOperation.create.mock.calls[0]?.[0]).toMatchObject({ data: {
      definitionId: f.pointers.get(purpose)!.definitionId, requestedByAdminId: ADMIN_ID, status: "COMPLETE", totalTargets: 20,
      scopeSnapshot: { scope: { mode: "one", shopId }, automatedOnboarding: { source: "PLATFORM_RECOVERY_DEFAULT",
        defaultId: `default-${purpose}`, defaultDefinitionId: f.pointers.get(purpose)!.definitionId } } } });
    const snapshot = f.tx.whatsAppTemplatePublicationOperation.create.mock.calls[0]![0].data.scopeSnapshot;
    expect(snapshot.automatedOnboarding).not.toHaveProperty("sourcePublicationOperationId");
    expect(snapshot).not.toHaveProperty("previewFingerprint");
    expect(f.rows.find(row => row.purpose === purpose && row.languageTag === "zh-Hans")?.providerLanguageCode).toBe("zh_CN");
    expect(f.rows.find(row => row.purpose === purpose && row.languageTag === "pt-BR")?.providerLanguageCode).toBe("pt_BR");
    expect(f.reporter.report).not.toHaveBeenCalled();
  });

  it("retries previously completed onboarding after defaults are configured and never overwrites on replacement", async () => {
    const f = scenario(); const saved = [...f.pointers]; f.pointers.clear(); await run(f);
    expect(f.rows).toHaveLength(0); f.reporter.report.mockClear();
    for (const [p, pointer] of saved) f.pointers.set(p, pointer);
    await run(f); const before = structuredClone(f.rows);
    const replacement = recoveryDefaultFixture(purpose, "two"); f.definitions.set(purpose, replacement);
    f.pointers.set(purpose, { ...f.pointers.get(purpose)!, definitionId: replacement.id, updatedAt: new Date() });
    await run(f);
    expect(f.rows).toEqual(before); expect(f.rows).toHaveLength(120);
    expect(f.tx.whatsAppTemplateVariant.createMany).toHaveBeenCalledTimes(6);
    expect(f.reporter.report).not.toHaveBeenCalled();
  });

  it("preserves existing complete shop overrides even without platform defaults", async () => {
    const f = scenario({ existing: "complete", missing: true }); await run(f);
    expect(f.tx.whatsAppRecoveryTemplateDefault.findUnique).not.toHaveBeenCalled();
    expect(f.tx.whatsAppTemplateVariant.createMany).not.toHaveBeenCalled();
    expect(f.reporter.report).not.toHaveBeenCalled();
  });

  it("does not repair partial or orphaned assignments by mixing sources", async () => {
    const partial = scenario({ existing: "partial" }); await run(partial);
    expect(partial.reporter.report.mock.calls[0]?.[0].reasonCode).toBe("ASSIGNMENT_REVIEW_REQUIRED");
    const orphan = scenario({ existing: "complete" }); orphan.tx.whatsAppTemplatePublicationTarget.findMany.mockResolvedValue([]);
    expect(await assign(orphan)).toBe("ASSIGNMENT_REVIEW_REQUIRED");
    expect(partial.tx.whatsAppTemplateVariant.createMany).not.toHaveBeenCalled();
    expect(orphan.tx.whatsAppTemplateVariant.createMany).not.toHaveBeenCalled();
  });

  it.each(["approval", "wrong-waba", "missing-locale", "missing-review", "wrong-code", "observed-hash", "bindings", "source-hash", "retired", "wrong-purpose"] as const)(
    "rejects invalid default evidence: %s", async failure => {
      const f = scenario(); const definition = f.definitions.get(purpose)!; const locale = definition.locales[0]; const reg = locale.metaRegistrations[0];
      switch (failure) {
        case "approval": reg.providerStatus = "REJECTED"; break;
        case "wrong-waba": reg.wabaId = "9999999999"; break;
        case "missing-locale": definition.locales.pop(); break;
        case "missing-review": locale.status = "SOURCE_SAVED"; break;
        case "wrong-code": reg.providerLanguageCode = "xx"; locale.providerLanguageCode = "xx"; break;
        case "observed-hash": reg.lastObservedContentHash = "a".repeat(64); break;
        case "bindings": reg.parameterBindingsSnapshot.body[0].variable = "checkout.url"; break;
        case "source-hash": definition.sourceHash = "b".repeat(64); break;
        case "retired": definition.retiredAt = new Date(); break;
        case "wrong-purpose": definition.offerType = "CODE_OFFER"; break;
      }
      expect(await assign(f)).toBe("DEFAULT_NOT_APPLICABLE");
      expect(f.tx.whatsAppTemplatePublicationOperation.create).not.toHaveBeenCalled();
      expect(f.tx.whatsAppTemplateVariant.createMany).not.toHaveBeenCalled();
    });

  it("accepts the frozen IMAGE registration format without inventing TEXT metadata", async () => {
    const f = scenario(); const image = recoveryDefaultFixture(purpose, "image", undefined, true);
    f.definitions.set(purpose, image); f.pointers.get(purpose)!.definitionId = image.id;
    expect(await assign(f)).toBe("ASSIGNED");
    expect(f.rows).toHaveLength(20);
  });

  it("accepts the exact active common layout and rejects stale or unstamped sources", async () => {
    const valid = scenario({ common: true }); expect(await assign(valid)).toBe("ASSIGNED");
    const stale = scenario({ common: true }); stale.setCommon(commonWrapperFixture("two"));
    expect(await assign(stale)).toBe("DEFAULT_NOT_APPLICABLE");
    const unstamped = scenario(); unstamped.setCommon(commonWrapperFixture());
    expect(await assign(unstamped)).toBe("DEFAULT_NOT_APPLICABLE");
    const absent = scenario({ common: true }); absent.setCommon(undefined);
    expect(await assign(absent)).toBe("DEFAULT_NOT_APPLICABLE");
  });

  it("reports an unusable default for just that purpose and continues other purposes", async () => {
    const f = scenario(); f.definitions.get(purpose)!.locales[0].metaRegistrations[0].driftDetectedAt = new Date(); await run(f);
    expect(f.rows).toHaveLength(100); expect(f.reporter.report).toHaveBeenCalledOnce();
    expect(f.reporter.report.mock.calls[0]?.[0]).toMatchObject({ reasonCode: "DEFAULT_NOT_APPLICABLE", resourceKey: `${shopId}:${purpose}` });
  });

  it("rejects an inactive or not yet onboarded shop", async () => {
    const f = scenario(); f.tx.shop.findUnique.mockResolvedValue({ id: shopId, platform: "SHOPIFY", status: "ACTIVE", onboardingCompleted: false });
    expect(await assign(f)).toBe("SHOP_INELIGIBLE"); expect(f.tx.whatsAppRecoveryTemplateDefault.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a changed sender before writing the assignment", async () => {
    const f = scenario(); mocks.sender.mockResolvedValueOnce("9999999999");
    expect(await assign(f)).toBe("SENDER_CONFIGURATION_UNAVAILABLE"); expect(f.tx.whatsAppTemplateVariant.createMany).not.toHaveBeenCalled();
  });

  it("reports sender misconfiguration without changing onboarding or writing templates", async () => {
    const f = scenario(); mocks.sender.mockRejectedValueOnce(new Error("provider config failure"));
    await expect(run(f)).resolves.toBeUndefined(); expect(f.reporter.report).toHaveBeenCalledOnce();
    expect(f.reporter.report.mock.calls[0]?.[0].reasonCode).toBe("SENDER_CONFIGURATION_UNAVAILABLE");
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });
});
