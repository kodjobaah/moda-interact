import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ADMIN_ID, WABA, languages, recoveryDefaultFixture } from "../fixtures/onboarding-recovery-defaults";

// Every query uses the explicit disposable database client, never app/db.server.
vi.mock("../../app/db.server", () => ({ default: {} }));
import { assignOnePurpose, ONBOARDING_TEMPLATE_PURPOSES, type OnboardingTemplatePurpose } from "../../app/services/recoveries/onboarding-template-publication.server";
import { ensureOnboardingRecoveryTemplatesBestEffort } from "../../app/services/recoveries/onboarding-template-assignments.server";
import { readCurrentFollowUpTemplates } from "../../app/services/recoveries/recovery-follow-up-catalogue.server";
import { trustedRecoverySenderWaba } from "../../app/services/recoveries/recovery-follow-up-sender.server";
import { RECOVERY_TEMPLATE_FORMATS, recoveryTemplateFormat, type RecoveryTemplateFormat } from "../../app/services/recoveries/recovery-template-format.server";

const runPostgres = process.env.MODA_ONBOARDING_RECOVERY_DEFAULTS_POSTGRES === "1";
const firstPurpose = "INITIAL_NO_OFFER";
const fixtures = new Map<string, ReturnType<typeof recoveryDefaultFixture>>(ONBOARDING_TEMPLATE_PURPOSES.flatMap(purpose => RECOVERY_TEMPLATE_FORMATS.map(format =>
  [`${purpose}:${format}`, recoveryDefaultFixture(purpose, format.toLowerCase(), undefined, format === "IMAGE")] as const)));
const context = { platform: "SHOPIFY" as const, environment: "test", readSenderWaba: trustedRecoverySenderWaba };

describe.skipIf(!runPostgres)("onboarding recovery defaults on migrated PostgreSQL", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let db: PrismaClient;
  const shop = (name: string) => db.shop.create({ data: { domain: `${name}.myshopify.com`, platform: "SHOPIFY",
    status: "ACTIVE", onboardingCompleted: true, storeLocale: "fr", defaultLanguageTag: "fr" } });
  const assign = (shopId: string, purpose: OnboardingTemplatePurpose = firstPurpose, format: RecoveryTemplateFormat = "TEXT") => db.$transaction(
    tx => assignOnePurpose(tx, shopId, purpose, WABA, format, context), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });

  async function seedDefinition(fixture: ReturnType<typeof recoveryDefaultFixture>) {
    const { locales, ...definition } = fixture;
    await db.whatsAppTemplateDefinition.create({ data: { ...definition, createdByAdminId: ADMIN_ID } });
    for (const { metaRegistrations, ...locale } of locales) {
      await db.whatsAppTemplateLocale.create({ data: { ...locale, localeAst: locale.localeAst as Prisma.InputJsonValue } });
      await db.whatsAppTemplateMetaRegistration.createMany({ data: metaRegistrations.map(reg => ({ ...reg,
        componentsSnapshot: reg.componentsSnapshot as Prisma.InputJsonValue,
        parameterBindingsSnapshot: reg.parameterBindingsSnapshot as Prisma.InputJsonValue })) });
    }
  }
  beforeAll(async () => {
    try {
      container = await new PostgreSqlContainer("pgvector/pgvector:pg17").withDatabase("recovery_defaults_test")
        .withUsername("postgres").withPassword(randomUUID()).start();
      const url = container.getConnectionUri();
      await promisify(execFile)(resolve("node_modules/.bin/prisma"), ["migrate", "deploy", "--schema", "database/prisma/schema.prisma"],
        { env: { ...process.env, DATABASE_URL: url }, timeout: 180_000 });
      db = new PrismaClient({ datasourceUrl: url }); await db.$connect();
      vi.stubEnv("DEPLOYMENT_ENVIRONMENT_NAME", "test"); vi.stubEnv("WHATSAPP_BUSINESS_ACCOUNT_ID", WABA);
      await db.platformAdmin.create({ data: { id: ADMIN_ID, email: "recovery-defaults@example.invalid", role: "SUPER_ADMIN" } });
      expect(await db.shop.count()).toBe(0);
      for (const purpose of ONBOARDING_TEMPLATE_PURPOSES) for (const format of RECOVERY_TEMPLATE_FORMATS) {
        const fixture = fixtures.get(`${purpose}:${format}`)!;
        await seedDefinition(fixture);
        await db.whatsAppRecoveryTemplateDefault.create({ data: { wabaId: WABA, purpose, format, definitionId: fixture.id, updatedByAdminId: ADMIN_ID } });
      }
      expect(await db.whatsAppTemplatePublicationOperation.count()).toBe(0);
    } catch (error) {
      try { await db?.$disconnect(); } finally { await container?.stop(); container = undefined; }
      throw error;
    }
  }, 240_000);
  afterAll(async () => { vi.unstubAllEnvs(); try { await db?.$disconnect(); } finally { await container?.stop(); } }, 60_000);

  it("provisions twelve format defaults without publication history and preserves both merchant formats", async () => {
    const merchant = await shop("first-shop");
    const reporter = { report: vi.fn().mockResolvedValue({ incidentKey: "key", recorded: true, occurrenceCount: 1, status: "OPEN" }) };
    await ensureOnboardingRecoveryTemplatesBestEffort(merchant.id, db, reporter);
    expect(reporter.report).not.toHaveBeenCalled();
    const variants = await db.whatsAppTemplateVariant.findMany({ where: { shopId: merchant.id }, orderBy: { id: "asc" }, include: { metaRegistration: true } });
    expect(variants).toHaveLength(240);
    const targets = await db.whatsAppTemplatePublicationTarget.findMany({ where: { shopId: merchant.id }, include: { operation: true } });
    expect(targets).toHaveLength(240);
    expect(new Set(targets.map(target => target.operationId)).size).toBe(12);
    for (const purpose of ONBOARDING_TEMPLATE_PURPOSES) for (const format of RECOVERY_TEMPLATE_FORMATS) {
      const rows = variants.filter(row => row.purpose === purpose && recoveryTemplateFormat(row.metaRegistration?.componentsSnapshot) === format);
      expect(rows.map(row => row.languageTag).sort()).toEqual([...languages].sort());
      expect(rows.every(row => row.enabled && row.status === "APPROVED" && row.providerAccountId === WABA)).toBe(true);
      for (const row of rows) {
        const target = targets.find(item => item.newVariantId === row.id)!;
        expect(target).toMatchObject({ status: "SUCCEEDED", metaRegistrationId: row.metaRegistrationId, languageTag: row.languageTag,
          operation: { status: "COMPLETE", definitionId: fixtures.get(`${purpose}:${format}`)!.id, totalTargets: 20, succeededTargets: 20, failedTargets: 0,
            scopeSnapshot: { automatedOnboarding: { source: "PLATFORM_RECOVERY_DEFAULT", format, platform: "SHOPIFY", defaultDefinitionId: fixtures.get(`${purpose}:${format}`)!.id } } } });
      }
    }
    const followUp = await readCurrentFollowUpTemplates(merchant.id, null, db);
    expect(followUp).toEqual(RECOVERY_TEMPLATE_FORMATS.map(format => expect.objectContaining({ language: "fr", providerLanguageCode: "fr",
      purpose: "FOLLOW_UP_NO_OFFER", name: fixtures.get(`FOLLOW_UP_NO_OFFER:${format}`)!.providerTemplateName })));
    await ensureOnboardingRecoveryTemplatesBestEffort(merchant.id, db, reporter);
    expect(await db.whatsAppTemplateVariant.findMany({ where: { shopId: merchant.id }, orderBy: { id: "asc" }, include: { metaRegistration: true } })).toEqual(variants);
    expect(await db.whatsAppTemplatePublicationTarget.count({ where: { shopId: merchant.id } })).toBe(240);
  }, 60_000);

  it("does not use historical publications when a pointer is absent; retry and replacement affect only unassigned shops", async () => {
    const oldDefault = await db.whatsAppRecoveryTemplateDefault.findUniqueOrThrow({ where: { wabaId_purpose_format: { wabaId: WABA, purpose: firstPurpose, format: "TEXT" } } });
    const merchant = await shop("missing-default");
    const { id: defaultId, ...pointer } = oldDefault;
    await db.whatsAppRecoveryTemplateDefault.delete({ where: { id: defaultId } });
    try {
      expect(await assign(merchant.id)).toBe("NO_APPROVED_DEFAULT");
      expect(await db.whatsAppTemplateVariant.count({ where: { shopId: merchant.id } })).toBe(0);
      await db.whatsAppRecoveryTemplateDefault.create({ data: { id: defaultId, ...pointer } });
      expect(await assign(merchant.id)).toBe("ASSIGNED");
      const replacement = recoveryDefaultFixture(firstPurpose, "replacement");
      await seedDefinition(replacement);
      await db.whatsAppRecoveryTemplateDefault.update({ where: { id: defaultId }, data: { definitionId: replacement.id } });
      expect(await assign(merchant.id)).toBe("ALREADY_ASSIGNED");
      const other = await shop("replacement-default");
      expect(await assign(other.id)).toBe("ASSIGNED");
      expect(await db.whatsAppTemplateVariant.count({ where: { shopId: merchant.id, providerTemplateName: fixtures.get(`${firstPurpose}:TEXT`)!.providerTemplateName } })).toBe(20);
      expect(await db.whatsAppTemplateVariant.count({ where: { shopId: other.id, providerTemplateName: replacement.providerTemplateName } })).toBe(20);
    } finally {
      await db.whatsAppRecoveryTemplateDefault.upsert({ where: { wabaId_purpose_format: { wabaId: WABA, purpose: firstPurpose, format: "TEXT" } },
        create: { id: defaultId, ...pointer }, update: { definitionId: oldDefault.definitionId } });
    }
  }, 60_000);

  it("preserves all original IMAGE assignments while provisioning the TEXT baseline", async () => {
    const merchant = await shop("image-only-upgrade");
    for (const purpose of ONBOARDING_TEMPLATE_PURPOSES) expect(await assign(merchant.id, purpose, "IMAGE")).toBe("ASSIGNED");
    const before = await db.whatsAppTemplateVariant.findMany({ where: { shopId: merchant.id }, orderBy: { id: "asc" } });
    expect(before).toHaveLength(120);
    const reporter = { report: vi.fn() };
    await ensureOnboardingRecoveryTemplatesBestEffort(merchant.id, db, reporter);
    expect(reporter.report).not.toHaveBeenCalled();
    expect(await db.whatsAppTemplateVariant.count({ where: { shopId: merchant.id } })).toBe(240);
    expect(await db.whatsAppTemplateVariant.findMany({ where: { id: { in: before.map(row => row.id) } }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await db.whatsAppTemplatePublicationTarget.count({ where: { shopId: merchant.id } })).toBe(240);
  }, 60_000);

  it("rolls back variants and operation when writing durable publication targets fails", async () => {
    const merchant = await shop("rollback-default");
    const operationCount = await db.whatsAppTemplatePublicationOperation.count();
    const failure = new Error("injected target write failure");
    await expect(db.$transaction(async tx => {
      const broken = new Proxy(tx, { get(target, key) {
        if (key === "whatsAppTemplatePublicationTarget") return { createMany: async () => { throw failure; } };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
      await assignOnePurpose(broken, merchant.id, firstPurpose, WABA, "TEXT", context);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 })).rejects.toThrow(failure.message);
    expect(await db.whatsAppTemplateVariant.count({ where: { shopId: merchant.id } })).toBe(0);
    expect(await db.whatsAppTemplatePublicationTarget.count({ where: { shopId: merchant.id } })).toBe(0);
    expect(await db.whatsAppTemplatePublicationOperation.count()).toBe(operationCount);
    expect(await assign(merchant.id)).toBe("ASSIGNED");
  });
});
