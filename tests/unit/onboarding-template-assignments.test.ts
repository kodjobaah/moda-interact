import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_ID,
  WABA,
  commonWrapperFixture,
  languages,
  recoveryDefaultFixture,
} from "../fixtures/onboarding-recovery-defaults";

const mocks = vi.hoisted(() => ({ sender: vi.fn() }));
vi.mock(
  "../../app/services/recoveries/recovery-follow-up-sender.server",
  () => ({ trustedRecoverySenderWaba: mocks.sender }),
);
vi.mock("../../app/db.server", () => ({ default: {} }));
import {
  ONBOARDING_TEMPLATE_PURPOSES,
  ensureOnboardingRecoveryTemplatesBestEffort,
} from "../../app/services/recoveries/onboarding-template-assignments.server";
import {
  assignOnePurpose,
  type OnboardingTemplatePurpose,
} from "../../app/services/recoveries/onboarding-template-publication.server";

import {
  isBrandIndependentText,
  recoveryHeaderKind,
  recoveryTemplateFormat,
  type RecoveryTemplateFormat,
} from "../../app/services/recoveries/recovery-template-format.server";

const shopId = "cm123456789012345678901234";
const purpose = "INITIAL_NO_OFFER";
type Variant = {
  id: string;
  purpose: string;
  languageTag: string;
  providerAccountId: string;
  metaRegistrationId: string;
  providerTemplateName?: string;
  providerLanguageCode?: string;
  enabled?: boolean;
  status?: string;
  metaRegistration?: {
    componentsSnapshot: unknown;
    parameterBindingsSnapshot: unknown;
  } | null;
};

function scenario(
  options: {
    missing?: boolean;
    existing?: "complete" | "partial";
    common?: boolean;
    image?: boolean;
    existingFormat?: RecoveryTemplateFormat;
  } = {},
) {
  const rows: Variant[] = [];
  const common = options.common ? commonWrapperFixture() : undefined;
  let activeCommon = common;
  const definitions = new Map<
    string,
    ReturnType<typeof recoveryDefaultFixture>
  >(
    ONBOARDING_TEMPLATE_PURPOSES.map((p) => [
      p,
      recoveryDefaultFixture(p, "one", common),
    ]),
  );
  const pointers = new Map<
    string,
    {
      id: string;
      definitionId: string;
      updatedByAdminId: string;
      updatedAt: Date;
    }
  >(
    ONBOARDING_TEMPLATE_PURPOSES.map((p) => [
      p,
      {
        id: `default-${p}`,
        definitionId: definitions.get(p)!.id,
        updatedByAdminId: ADMIN_ID,
        updatedAt: new Date("2026-11-24T16:30:00Z"),
      },
    ]),
  );
  function setImage(p: OnboardingTemplatePurpose, revision = "image") {
    const image = recoveryDefaultFixture(p, revision, common, true);
    definitions.set(`${p}:IMAGE`, image);
    pointers.set(`${p}:IMAGE`, {
      id: `default-${p}-image`,
      definitionId: image.id,
      updatedByAdminId: ADMIN_ID,
      updatedAt: new Date("2026-11-24T16:30:00Z"),
    });
    return image;
  }
  if (options.image) for (const p of ONBOARDING_TEMPLATE_PURPOSES) setImage(p);
  if (options.missing) pointers.clear();
  if (options.existing)
    for (const p of ONBOARDING_TEMPLATE_PURPOSES) {
      for (const languageTag of options.existing === "complete"
        ? languages
        : languages.slice(0, 1)) {
        const reg = recoveryDefaultFixture(
          p,
          "override",
          common,
          options.existingFormat === "IMAGE",
        ).locales.find((locale) => locale.languageTag === languageTag)!
          .metaRegistrations[0];
        rows.push({
          id: `existing-${p}-${languageTag}`,
          purpose: p,
          languageTag,
          providerAccountId: WABA,
          metaRegistrationId: reg.id,
          enabled: true,
          status: "APPROVED",
          metaRegistration: reg,
        });
      }
    }
  const findDefinition = (id: string) =>
    [...definitions.values()].find((def) => def.id === id);
  const tx = {
    $queryRaw: vi.fn(
      async (query: TemplateStringsArray, ...args: unknown[]) => {
        const sql = query.join("?");
        if (sql.includes('FROM "whatsapp"."WhatsAppTemplateMetaRegistration"'))
          return (
            findDefinition(String(args[0]))?.locales.flatMap((locale) =>
              locale.metaRegistrations
                .filter((reg) => reg.wabaId === args[1])
                .map((reg) => ({ id: reg.id })),
            ) ?? []
          );
        if (sql.includes('FROM "whatsapp"."WhatsAppTemplateLocale"'))
          return (
            findDefinition(String(args[0]))?.locales.map((locale) => ({
              id: locale.id,
            })) ?? []
          );
        return [];
      },
    ),
    shop: {
      findUnique: vi.fn().mockResolvedValue({
        id: shopId,
        platform: "SHOPIFY",
        status: "ACTIVE",
        onboardingCompleted: true,
      }),
    },
    whatsAppTemplateVariant: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            purpose: string;
            providerAccountId?: string;
            enabled?: boolean;
            status?: string;
            metaRegistrationId?: { in: string[] };
          };
        }) =>
          rows.filter(
            (row) =>
              row.purpose === where.purpose &&
              (!where.providerAccountId ||
                row.providerAccountId === where.providerAccountId) &&
              (where.enabled === undefined || row.enabled === where.enabled) &&
              (!where.status || row.status === where.status) &&
              (!where.metaRegistrationId ||
                where.metaRegistrationId.in.includes(row.metaRegistrationId)),
          ),
      ),
      createMany: vi.fn(async ({ data }: { data: Omit<Variant, "id">[] }) => {
        for (const item of data) {
          const reg = [...definitions.values()]
            .flatMap((def) =>
              def.locales.flatMap((locale) => locale.metaRegistrations),
            )
            .find(
              (registration) => registration.id === item.metaRegistrationId,
            );
          if (!reg) throw new Error("Missing mock registration");
          rows.push({
            id: `new-${reg.id}`,
            ...item,
            metaRegistration: structuredClone(reg),
          });
        }
        return { count: data.length };
      }),
    },
    whatsAppRecoveryTemplateDefault: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: {
            wabaId_purpose_format: {
              wabaId: string;
              purpose: OnboardingTemplatePurpose;
              format: RecoveryTemplateFormat;
            };
          };
        }) =>
          where.wabaId_purpose_format.wabaId === WABA
            ? (pointers.get(
                where.wabaId_purpose_format.format === "TEXT"
                  ? where.wabaId_purpose_format.purpose
                  : `${where.wabaId_purpose_format.purpose}:IMAGE`,
              ) ?? null)
            : null,
      ),
    },
    whatsAppTemplatePublicationOperation: {
      findFirst: vi.fn().mockResolvedValue({ id: "old-all-shops-publication" }),
      create: vi
        .fn<
          (input: {
            data: {
              scopeSnapshot: Record<string, unknown> & {
                automatedOnboarding: Record<string, unknown>;
              };
            };
          }) => Promise<{ id: string }>
        >()
        .mockResolvedValue({ id: "new-publication" }),
    },
    whatsAppTemplatePublicationTarget: {
      createMany: vi.fn().mockResolvedValue({ count: 20 }),
      findMany: vi.fn(
        async ({ where }: { where: { newVariantId: { in: string[] } } }) =>
          rows
            .filter((row) => where.newVariantId.in.includes(row.id))
            .map((row) => ({
              newVariantId: row.id,
              languageTag: row.languageTag,
              metaRegistrationId: row.metaRegistrationId,
            })),
      ),
    },
    whatsAppTemplateDefinition: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        findDefinition(where.id),
      ),
    },
    whatsAppConversationWrapperActiveSlot: {
      findUnique: vi.fn(async () =>
        activeCommon
          ? { definitionId: activeCommon.id, definition: activeCommon }
          : null,
      ),
    },
  };
  const db = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const reporter = {
    report: vi.fn().mockResolvedValue({
      incidentKey: "key",
      recorded: true,
      occurrenceCount: 1,
      status: "OPEN",
    }),
  };
  return {
    tx,
    db,
    rows,
    reporter,
    definitions,
    pointers,
    setImage,
    setCommon: (wrapper: typeof common) => {
      activeCommon = wrapper;
    },
  };
}
const run = (f: ReturnType<typeof scenario>) =>
  ensureOnboardingRecoveryTemplatesBestEffort(
    shopId,
    f.db as never,
    f.reporter,
  );
const assign = (
  f: ReturnType<typeof scenario>,
  format: RecoveryTemplateFormat = "TEXT",
  platform: "SHOPIFY" | "WOOCOMMERCE" = "SHOPIFY",
) =>
  assignOnePurpose(f.tx as never, shopId, purpose, WABA, format, {
    platform,
    environment: "test",
    readSenderWaba: mocks.sender,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sender.mockResolvedValue(WABA);
});

describe("Shopify onboarding recovery template provisioning", () => {
  it("reports missing explicit defaults even if old publication history exists", async () => {
    const f = scenario({ missing: true });
    await run(f);
    expect(f.reporter.report).toHaveBeenCalledTimes(6);
    expect(f.reporter.report.mock.calls[0]?.[0]).toMatchObject({
      category: "WHATSAPP_TEMPLATE_PROVISIONING",
      reasonCode: "NO_APPROVED_DEFAULT",
      shopId,
      resourceKey: `${shopId}:INITIAL_NO_OFFER:TEXT`,
    });
    expect(f.reporter.report.mock.calls[0]?.[0].errorMessage).toContain(
      "Set as default",
    );
    expect(
      f.tx.whatsAppTemplatePublicationOperation.findFirst,
    ).not.toHaveBeenCalled();
    expect(f.tx.whatsAppTemplateVariant.createMany).not.toHaveBeenCalled();
  });

  it("inherits six required TEXT defaults with optional IMAGE absent and writes 120 assignments", async () => {
    const f = scenario();
    await run(f);
    expect(f.rows).toHaveLength(120);
    expect(
      f.tx.whatsAppRecoveryTemplateDefault.findUnique,
    ).toHaveBeenCalledTimes(12);
    expect(
      f.tx.whatsAppTemplatePublicationOperation.findFirst,
    ).not.toHaveBeenCalled();
    expect(f.tx.whatsAppTemplateVariant.createMany).toHaveBeenCalledTimes(6);
    expect(
      f.tx.whatsAppTemplatePublicationTarget.createMany,
    ).toHaveBeenCalledTimes(6);
    expect(
      f.tx.whatsAppTemplatePublicationOperation.create,
    ).toHaveBeenCalledTimes(6);
    expect(
      f.tx.whatsAppTemplatePublicationOperation.create.mock.calls[0]?.[0],
    ).toMatchObject({
      data: {
        definitionId: f.pointers.get(purpose)!.definitionId,
        requestedByAdminId: ADMIN_ID,
        status: "COMPLETE",
        totalTargets: 20,
        scopeSnapshot: {
          scope: { mode: "one", shopId },
          automatedOnboarding: {
            source: "PLATFORM_RECOVERY_DEFAULT",
            format: "TEXT",
            platform: "SHOPIFY",
            defaultId: `default-${purpose}`,
            defaultDefinitionId: f.pointers.get(purpose)!.definitionId,
          },
        },
      },
    });
    const snapshot =
      f.tx.whatsAppTemplatePublicationOperation.create.mock.calls[0]![0].data
        .scopeSnapshot;
    expect(snapshot.automatedOnboarding).not.toHaveProperty(
      "sourcePublicationOperationId",
    );
    expect(snapshot).not.toHaveProperty("previewFingerprint");
    expect(
      f.rows.find(
        (row) => row.purpose === purpose && row.languageTag === "zh-Hans",
      )?.providerLanguageCode,
    ).toBe("zh_CN");
    expect(
      f.rows.find(
        (row) => row.purpose === purpose && row.languageTag === "pt-BR",
      )?.providerLanguageCode,
    ).toBe("pt_BR");
    expect(f.reporter.report).not.toHaveBeenCalled();
  });

  it("retries previously completed onboarding after defaults are configured and never overwrites on replacement", async () => {
    const f = scenario();
    const saved = [...f.pointers];
    f.pointers.clear();
    await run(f);
    expect(f.rows).toHaveLength(0);
    f.reporter.report.mockClear();
    for (const [p, pointer] of saved) f.pointers.set(p, pointer);
    await run(f);
    const before = structuredClone(f.rows);
    const replacement = recoveryDefaultFixture(purpose, "two");
    f.definitions.set(purpose, replacement);
    f.pointers.set(purpose, {
      ...f.pointers.get(purpose)!,
      definitionId: replacement.id,
      updatedAt: new Date(),
    });
    await run(f);
    expect(f.rows).toEqual(before);
    expect(f.rows).toHaveLength(120);
    expect(f.tx.whatsAppTemplateVariant.createMany).toHaveBeenCalledTimes(6);
    expect(f.reporter.report).not.toHaveBeenCalled();
  });

  it("preserves existing complete shop overrides even without platform defaults", async () => {
    const f = scenario({ existing: "complete", missing: true });
    await run(f);
    expect(
      f.tx.whatsAppRecoveryTemplateDefault.findUnique,
    ).toHaveBeenCalledTimes(6);
    expect(f.tx.whatsAppTemplateVariant.createMany).not.toHaveBeenCalled();
    expect(f.reporter.report).not.toHaveBeenCalled();
  });

  it("does not repair partial or orphaned assignments by mixing sources", async () => {
    const partial = scenario({ existing: "partial" });
    await run(partial);
    expect(partial.reporter.report.mock.calls[0]?.[0].reasonCode).toBe(
      "ASSIGNMENT_REVIEW_REQUIRED",
    );
    const orphan = scenario({ existing: "complete" });
    orphan.tx.whatsAppTemplatePublicationTarget.findMany.mockResolvedValue([]);
    expect(await assign(orphan)).toBe("ASSIGNMENT_REVIEW_REQUIRED");
    expect(
      partial.tx.whatsAppTemplateVariant.createMany,
    ).not.toHaveBeenCalled();
    expect(orphan.tx.whatsAppTemplateVariant.createMany).not.toHaveBeenCalled();
  });

  it.each([
    "approval",
    "wrong-waba",
    "missing-locale",
    "missing-review",
    "wrong-code",
    "observed-hash",
    "bindings",
    "source-hash",
    "retired",
    "wrong-purpose",
  ] as const)("rejects invalid default evidence: %s", async (failure) => {
    const f = scenario();
    const definition = f.definitions.get(purpose)!;
    const locale = definition.locales[0];
    const reg = locale.metaRegistrations[0];
    switch (failure) {
      case "approval":
        reg.providerStatus = "REJECTED";
        break;
      case "wrong-waba":
        reg.wabaId = "9999999999";
        break;
      case "missing-locale":
        definition.locales.pop();
        break;
      case "missing-review":
        locale.status = "SOURCE_SAVED";
        break;
      case "wrong-code":
        reg.providerLanguageCode = "xx";
        locale.providerLanguageCode = "xx";
        break;
      case "observed-hash":
        reg.lastObservedContentHash = "a".repeat(64);
        break;
      case "bindings":
        reg.parameterBindingsSnapshot.body[0].variable = "checkout.url";
        break;
      case "source-hash":
        definition.sourceHash = "b".repeat(64);
        break;
      case "retired":
        definition.retiredAt = new Date();
        break;
      case "wrong-purpose":
        definition.offerType = "CODE_OFFER";
        break;
    }
    expect(await assign(f)).toBe("DEFAULT_NOT_APPLICABLE");
    expect(
      f.tx.whatsAppTemplatePublicationOperation.create,
    ).not.toHaveBeenCalled();
    expect(f.tx.whatsAppTemplateVariant.createMany).not.toHaveBeenCalled();
  });

  it("accepts the frozen IMAGE registration format without inventing TEXT metadata", async () => {
    const f = scenario();
    f.setImage(purpose);
    expect(await assign(f, "IMAGE")).toBe("ASSIGNED");
    expect(f.rows).toHaveLength(20);
  });

  it("accepts the exact active common layout and rejects stale or unstamped sources", async () => {
    const valid = scenario({ common: true });
    expect(await assign(valid)).toBe("ASSIGNED");
    const stale = scenario({ common: true });
    stale.setCommon(commonWrapperFixture("two"));
    expect(await assign(stale)).toBe("DEFAULT_NOT_APPLICABLE");
    const unstamped = scenario();
    unstamped.setCommon(commonWrapperFixture());
    expect(await assign(unstamped)).toBe("DEFAULT_NOT_APPLICABLE");
    const absent = scenario({ common: true });
    absent.setCommon(undefined);
    expect(await assign(absent)).toBe("DEFAULT_NOT_APPLICABLE");
  });

  it("reports an unusable default for just that purpose and continues other purposes", async () => {
    const f = scenario();
    f.definitions.get(
      purpose,
    )!.locales[0].metaRegistrations[0].driftDetectedAt = new Date();
    await run(f);
    expect(f.rows).toHaveLength(100);
    expect(f.reporter.report).toHaveBeenCalledOnce();
    expect(f.reporter.report.mock.calls[0]?.[0]).toMatchObject({
      reasonCode: "DEFAULT_NOT_APPLICABLE",
      resourceKey: `${shopId}:${purpose}:TEXT`,
    });
  });

  it("provisions both formats for each purpose and retries without duplicate operations", async () => {
    const f = scenario({ image: true });
    await run(f);
    expect(f.rows).toHaveLength(240);
    expect(new Set(f.rows.map((row) => row.id)).size).toBe(240);
    expect(
      f.tx.whatsAppTemplatePublicationOperation.create,
    ).toHaveBeenCalledTimes(12);
    for (const p of ONBOARDING_TEMPLATE_PURPOSES)
      for (const format of ["TEXT", "IMAGE"]) {
        expect(
          f.rows.filter(
            (row) =>
              row.purpose === p &&
              recoveryTemplateFormat(
                row.metaRegistration?.componentsSnapshot,
              ) === format,
          ),
        ).toHaveLength(20);
      }
    const before = structuredClone(f.rows);
    await run(f);
    expect(f.rows).toEqual(before);
    expect(f.reporter.report).not.toHaveBeenCalled();
    expect(
      f.tx.whatsAppTemplatePublicationOperation.create,
    ).toHaveBeenCalledTimes(12);
  });

  it("adds required TEXT without replacing a previously published IMAGE override", async () => {
    const f = scenario({
      image: true,
      existing: "complete",
      existingFormat: "IMAGE",
    });
    const before = structuredClone(f.rows);
    await run(f);
    expect(f.rows).toHaveLength(240);
    expect(f.rows.slice(0, 120)).toEqual(before);
    expect(
      f.tx.whatsAppTemplatePublicationOperation.create,
    ).toHaveBeenCalledTimes(6);
    expect(f.reporter.report).not.toHaveBeenCalled();
  });

  it("reports missing required TEXT but still provisions approved IMAGE", async () => {
    const f = scenario({ missing: true });
    f.setImage(purpose);
    await run(f);
    expect(f.rows).toHaveLength(20);
    expect(f.reporter.report).toHaveBeenCalledTimes(6);
    expect(f.reporter.report.mock.calls[0]?.[0]).toMatchObject({
      reasonCode: "NO_APPROVED_DEFAULT",
      resourceKey: `${shopId}:${purpose}:TEXT`,
    });
  });

  it("classifies headerless and text-header defaults together and rejects unsupported headers", () => {
    const body = { type: "BODY", text: "Example" };
    expect(recoveryHeaderKind([body])).toBe("NONE");
    expect(recoveryTemplateFormat([body])).toBe("TEXT");
    expect(
      recoveryTemplateFormat([
        { type: "HEADER", format: "TEXT", text: "Hello" },
        body,
      ]),
    ).toBe("TEXT");
    expect(
      recoveryTemplateFormat([{ type: "HEADER", format: "IMAGE" }, body]),
    ).toBe("IMAGE");
    expect(
      recoveryTemplateFormat([{ type: "HEADER", format: "VIDEO" }, body]),
    ).toBeNull();
    expect(
      recoveryTemplateFormat([
        { type: "HEADER", format: "TEXT" },
        { type: "HEADER", format: "IMAGE" },
        body,
      ]),
    ).toBeNull();
    expect(recoveryTemplateFormat([])).toBeNull();
    expect(
      isBrandIndependentText({
        header: [],
        body: [{ variable: "shop.name" }],
        buttons: [{ variable: "checkout.url" }],
      }),
    ).toBe(true);
    expect(
      isBrandIndependentText({
        header: [],
        body: [{ variable: "shopBrand.brandName" }],
        buttons: [],
      }),
    ).toBe(false);
    expect(
      isBrandIndependentText({
        headerMediaRole: "LOGO",
        header: [],
        body: [],
        buttons: [],
      }),
    ).toBe(false);
  });

  it("rejects a correctly hashed TEXT definition that still depends on merchant branding", async () => {
    const f = scenario();
    const branding = recoveryDefaultFixture(
      purpose,
      "brand-dependent",
      undefined,
      false,
      "shopBrand.brandName",
    );
    f.definitions.set(purpose, branding);
    f.pointers.get(purpose)!.definitionId = branding.id;
    expect(await assign(f)).toBe("DEFAULT_NOT_APPLICABLE");
    expect(f.tx.whatsAppTemplateVariant.createMany).not.toHaveBeenCalled();
  });

  it("rejects a default pointer for the wrong frozen format", async () => {
    const f = scenario();
    const image = f.setImage(purpose);
    f.pointers.get(purpose)!.definitionId = image.id;
    expect(await assign(f)).toBe("DEFAULT_NOT_APPLICABLE");
    expect(f.rows).toHaveLength(0);
  });

  it("does not allow disabled history in a different format to block the required fallback", async () => {
    const f = scenario({ existing: "complete", existingFormat: "IMAGE" });
    for (const row of f.rows) row.enabled = false;
    expect(await assign(f)).toBe("ASSIGNED");
    expect(
      f.rows.filter((row) => row.purpose === purpose && row.enabled),
    ).toHaveLength(20);
  });

  it("does not reactivate disabled history of the same format", async () => {
    const f = scenario({ existing: "complete" });
    for (const row of f.rows) row.enabled = false;
    expect(await assign(f)).toBe("ASSIGNMENT_REVIEW_REQUIRED");
    expect(f.tx.whatsAppTemplateVariant.createMany).not.toHaveBeenCalled();
  });

  it("isolates a partial IMAGE override from valid TEXT provisioning", async () => {
    const f = scenario({
      image: true,
      existing: "partial",
      existingFormat: "IMAGE",
    });
    expect(await assign(f)).toBe("ASSIGNED");
    expect(await assign(f, "IMAGE")).toBe("ASSIGNMENT_REVIEW_REQUIRED");
  });

  it("keeps the platform gate explicit for reuse by the WooCommerce integration", async () => {
    const f = scenario();
    f.tx.shop.findUnique.mockResolvedValue({
      id: shopId,
      platform: "WOOCOMMERCE",
      status: "ACTIVE",
      onboardingCompleted: true,
    });
    expect(await assign(f)).toBe("SHOP_INELIGIBLE");
    expect(await assign(f, "TEXT", "WOOCOMMERCE")).toBe("ASSIGNED");
  });

  it("rejects an inactive or not yet onboarded shop", async () => {
    const f = scenario();
    f.tx.shop.findUnique.mockResolvedValue({
      id: shopId,
      platform: "SHOPIFY",
      status: "ACTIVE",
      onboardingCompleted: false,
    });
    expect(await assign(f)).toBe("SHOP_INELIGIBLE");
    expect(
      f.tx.whatsAppRecoveryTemplateDefault.findUnique,
    ).not.toHaveBeenCalled();
  });

  it("rejects a changed sender before writing the assignment", async () => {
    const f = scenario();
    mocks.sender.mockResolvedValueOnce("9999999999");
    expect(await assign(f)).toBe("SENDER_CONFIGURATION_UNAVAILABLE");
    expect(f.tx.whatsAppTemplateVariant.createMany).not.toHaveBeenCalled();
  });

  it("reports sender misconfiguration without changing onboarding or writing templates", async () => {
    const f = scenario();
    mocks.sender.mockRejectedValueOnce(new Error("provider config failure"));
    await expect(run(f)).resolves.toBeUndefined();
    expect(f.reporter.report).toHaveBeenCalledOnce();
    expect(f.reporter.report.mock.calls[0]?.[0].reasonCode).toBe(
      "SENDER_CONFIGURATION_UNAVAILABLE",
    );
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });
});
