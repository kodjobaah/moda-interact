import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Client } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import {
  selectCapabilities,
  deduplicateTools,
  currentlyGrantedTools,
  exampleGrant,
  exampleManifest,
  exampleTool,
} from "@modainteract/moda-interact-shared/commerce";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../../app/db.server", () => ({ default: {} }));
import {
  loadFeaturePreferences,
  saveFeaturePreferences,
} from "../../app/services/feature-preferences/feature-preferences.server";
import {
  loadRecoveryPolicySnapshot,
  saveMerchantRecoveryPolicy,
} from "../../app/services/recovery-policy/recovery-policy.server";
const enabled = process.env.MODA_SETTINGS_POSTGRES === "1";
let db: PrismaClient;
let postgres: StartedPostgreSqlContainer | undefined;
const prefix = `arch020-test-${randomUUID()}`;
let shopId: string, otherId: string, planId: string;
const featureIds: string[] = [];
describe.skipIf(!enabled)("merchant settings PostgreSQL persistence", () => {
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:15-alpine").start();
    const url = postgres.getConnectionUri();
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const migrations = new URL(
        "../../database/prisma/migrations/",
        import.meta.url,
      );
      for (const name of (await readdir(migrations)).sort())
        if (/^\d/.test(name))
          await client.query(
            await readFile(
              new URL(`${name}/migration.sql`, migrations),
              "utf8",
            ),
          );
    } finally {
      await client.end();
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    const plan = await db.billingPlan.create({
      data: { shopifyPlanHandle: prefix, name: prefix, kind: "FREE" },
    });
    planId = plan.id;
    for (const name of ["own", "other"]) {
      const shop = await db.shop.create({
        data: {
          domain: `${prefix}-${name}.myshopify.com`,
          settings: { create: { onboardingCompleted: true } },
          subscription: { create: { planId, status: "ACTIVE" } },
        },
      });
      if (name === "own") shopId = shop.id;
      else otherId = shop.id;
    }
    for (const [i, mode, required, active, mapped] of [
      [0, "MERCHANT_OPT_IN", false, true, true],
      [1, "MERCHANT_OPT_IN", false, true, true],
      [2, "ALWAYS_ENABLED", false, true, true],
      [3, "MERCHANT_OPT_IN", true, true, true],
      [4, "MERCHANT_OPT_IN", false, false, true],
      [5, "MERCHANT_OPT_IN", false, true, false],
    ] as const) {
      const f = await db.feature.create({
        data: {
          key: `${prefix}-${i}`,
          displayName: `Feature ${i}`,
          activationMode: mode,
          systemRequired: required,
          active,
        },
      });
      featureIds.push(f.id);
      if (mapped)
        await db.billingPlanFeature.create({
          data: { planId, featureId: f.id },
        });
    }
  }, 180000);
  afterAll(async () => {
    try {
      await db?.$disconnect();
    } finally {
      await postgres?.stop();
    }
  }, 60000);
  it("arbitrary mapped features follow Free/Paid eligibility; missing opt-in is false and required/system features are immutable", async () => {
    for (const kind of ["FREE", "PAID_METERED"] as const) {
      await db.billingPlan.update({ where: { id: planId }, data: { kind } });
      const s = await loadFeaturePreferences(shopId, db);
      expect(s.features).toHaveLength(4);
      expect(s.features.find((f) => f.id === featureIds[0])).toMatchObject({
        enabled: false,
        effective: false,
        editable: true,
      });
      expect(s.features.find((f) => f.id === featureIds[2])).toMatchObject({
        effective: true,
        editable: false,
      });
      expect(s.features.find((f) => f.id === featureIds[3])).toMatchObject({
        effective: false,
        editable: false,
      });
      for (const featureId of featureIds.slice(2))
        await expect(
          saveFeaturePreferences(
            shopId,
            [{ featureId, enabled: true }],
            s.revision,
            db,
          ),
        ).rejects.toThrow("DENIED");
    }
  });
  it("inactive subscription, plan and shop cannot write preferences", async () => {
    const initial = await loadFeaturePreferences(otherId, db);
    const save = () =>
      saveFeaturePreferences(
        otherId,
        [{ featureId: featureIds[0], enabled: true }],
        initial.revision,
        db,
      );
    await db.subscription.update({
      where: { shopId: otherId },
      data: { status: "FROZEN" },
    });
    await expect(save()).rejects.toThrow("DENIED");
    await db.subscription.update({
      where: { shopId: otherId },
      data: { status: "ACTIVE" },
    });
    await db.billingPlan.update({
      where: { id: planId },
      data: { active: false },
    });
    await expect(save()).rejects.toThrow("DENIED");
    await db.billingPlan.update({
      where: { id: planId },
      data: { active: true },
    });
    await db.shop.update({
      where: { id: otherId },
      data: { status: "UNINSTALLED" },
    });
    await expect(save()).rejects.toThrow("DENIED");
    await db.shop.update({
      where: { id: otherId },
      data: { status: "ACTIVE" },
    });
    expect(
      await db.shopFeaturePreference.count({ where: { shopId: otherId } }),
    ).toBe(0);
  });
  it("persisted opt-in changes initial tools but cannot expand an existing grant; discount policy works on Free and Paid", async () => {
    const candidates = [
      {
        binding: { kind: "BASE" as const, key: "conversation_core" as const },
        enabled: true,
        position: 0,
      },
      {
        binding: {
          kind: "FEATURE" as const,
          key: "optional",
          featureId: featureIds[0],
        },
        enabled: true,
        position: 1,
      },
      {
        binding: {
          kind: "RECOVERY_POLICY" as const,
          key: "discount_assistance" as const,
        },
        enabled: true,
        position: 2,
      },
    ];
    const keys = async (offerMode: "NONE" | "FIXED" | "AI_BEST_APPLICABLE") => {
      const preference = await db.shopFeaturePreference.findUnique({
        where: {
          shopId_featureId: { shopId: otherId, featureId: featureIds[0] },
        },
      });
      return selectCapabilities(candidates, {
        features: [
          {
            id: featureIds[0],
            active: true,
            planMappingEnabled: true,
            mode: "MERCHANT_OPT_IN",
            preferenceEnabled: preference?.enabled ?? null,
          },
        ],
        offerMode,
      });
    };
    const tools = (selected: string[]) =>
      deduplicateTools(
        selected.map((key) => ({
          key,
          toolDescriptors: key === "optional" ? [exampleTool] : [],
        })),
      );
    const original = exampleGrant(exampleManifest(() => "a".repeat(64)));
    original.grantedTools = tools(await keys("NONE"));
    expect(original.grantedTools).toHaveLength(0);
    const snapshot = await loadFeaturePreferences(otherId, db);
    await saveFeaturePreferences(
      otherId,
      [{ featureId: featureIds[0], enabled: true }],
      snapshot.revision,
      db,
    );
    expect(tools(await keys("NONE"))).toHaveLength(1);
    expect(
      currentlyGrantedTools(
        original,
        new Set(await keys("NONE")),
        new Set([exampleTool.toolId]),
      ),
    ).toHaveLength(0);
    for (const kind of ["FREE", "PAID_METERED"] as const) {
      await db.billingPlan.update({ where: { id: planId }, data: { kind } });
      for (const mode of ["NONE", "FIXED", "AI_BEST_APPLICABLE"] as const)
        expect((await keys(mode)).includes("discount_assistance")).toBe(
          mode !== "NONE",
        );
    }
    await saveFeaturePreferences(
      otherId,
      [{ featureId: featureIds[0], enabled: false }],
      (await loadFeaturePreferences(otherId, db)).revision,
      db,
    );
    expect(tools(await keys("NONE"))).toHaveLength(0);
    await db.shopFeaturePreference.deleteMany({ where: { shopId: otherId } });
  });
  it("direct concurrent equal values persist one preference with no repeated update or recovery-policy side effect", async () => {
    const s = await loadFeaturePreferences(shopId, db);
    const before = await db.shopSettings.findUniqueOrThrow({
      where: { shopId },
    });
    const desired = [{ featureId: featureIds[0], enabled: true }];
    const result = await Promise.all([
      saveFeaturePreferences(shopId, desired, s.revision, db),
      saveFeaturePreferences(shopId, desired, s.revision, db),
    ]);
    expect(result[0].revision).toBe(result[1].revision);
    const preference = await db.shopFeaturePreference.findUniqueOrThrow({
      where: { shopId_featureId: { shopId, featureId: featureIds[0] } },
    });
    await saveFeaturePreferences(shopId, desired, s.revision, db);
    expect(
      await db.shopFeaturePreference.findUnique({
        where: { id: preference.id },
      }),
    ).toEqual(preference);
    expect(
      await db.shopFeaturePreference.count({
        where: { shopId, featureId: featureIds[0] },
      }),
    ).toBe(1);
    expect(
      await db.shopFeaturePreference.count({ where: { shopId: otherId } }),
    ).toBe(0);
    expect(await db.shopSettings.findUnique({ where: { shopId } })).toEqual(
      before,
    );
  });
  it("conflicting concurrent forms require authoritative refetch; disabled mapping denies without deleting preference", async () => {
    let s = await loadFeaturePreferences(shopId, db);
    await saveFeaturePreferences(
      shopId,
      [{ featureId: featureIds[0], enabled: false }],
      s.revision,
      db,
    );
    s = await loadFeaturePreferences(shopId, db);
    const result = await Promise.allSettled([
      saveFeaturePreferences(
        shopId,
        [{ featureId: featureIds[0], enabled: true }],
        s.revision,
        db,
      ),
      saveFeaturePreferences(
        shopId,
        [{ featureId: featureIds[1], enabled: true }],
        s.revision,
        db,
      ),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
    const fresh = await loadFeaturePreferences(shopId, db);
    await saveFeaturePreferences(
      shopId,
      [
        { featureId: featureIds[0], enabled: true },
        { featureId: featureIds[1], enabled: true },
      ],
      fresh.revision,
      db,
    );
    await db.billingPlanFeature.update({
      where: { planId_featureId: { planId, featureId: featureIds[0] } },
      data: { enabled: false },
    });
    const denied = await loadFeaturePreferences(shopId, db);
    expect(denied.features.some((f) => f.id === featureIds[0])).toBe(false);
    await expect(
      saveFeaturePreferences(
        shopId,
        [{ featureId: featureIds[0], enabled: false }],
        denied.revision,
        db,
      ),
    ).rejects.toThrow("DENIED");
    expect(
      (
        await db.shopFeaturePreference.findUniqueOrThrow({
          where: { shopId_featureId: { shopId, featureId: featureIds[0] } },
        })
      ).enabled,
    ).toBe(true);
  });
  it("recovery duplicates are no-op, conflicting stale writes fail and active overrides keep precedence", async () => {
    const initial = await db.shopSettings.findUniqueOrThrow({
      where: { shopId },
    });
    const input = {
      recoveryDelayMinutes: "40",
      recoveryOfferMode: "AI_BEST_APPLICABLE",
      followUpEnabled: "true",
      followUpDelayMinutes: "60",
    };
    const rows = await Promise.all([
      saveMerchantRecoveryPolicy(
        shopId,
        input,
        new Date(),
        initial.updatedAt.toISOString(),
        db,
      ),
      saveMerchantRecoveryPolicy(
        shopId,
        input,
        new Date(),
        initial.updatedAt.toISOString(),
        db,
      ),
    ]);
    expect(rows[0].updatedAt).toEqual(rows[1].updatedAt);
    await expect(
      saveMerchantRecoveryPolicy(
        shopId,
        { ...input, recoveryDelayMinutes: "50" },
        new Date(),
        initial.updatedAt.toISOString(),
        db,
      ),
    ).rejects.toThrow("CONFLICT");
    const admin = await db.platformAdmin.create({
      data: { email: `${prefix}@example.test` },
    });
    await db.shopRecoveryPolicyOverride.create({
      data: {
        updatedByPlatformAdminId: admin.id,
        shopId,
        recoveryDelayMinutes: 90,
        recoveryOfferMode: "NONE",
        followUpEnabled: false,
        reason: "Fixture",
      },
    });
    const snapshot = await loadRecoveryPolicySnapshot(shopId, new Date(), db);
    expect(snapshot.merchant.recoveryOfferMode).toBe("AI_BEST_APPLICABLE");
    expect(snapshot.effective.recoveryOfferMode).toBe("NONE");
    expect(snapshot.overrideActive).toBe(true);
    await db.shopRecoveryPolicyOverride.update({
      where: { shopId },
      data: { expiresAt: new Date(0) },
    });
    expect(
      (await loadRecoveryPolicySnapshot(shopId, new Date(), db)).effective
        .recoveryOfferMode,
    ).toBe("AI_BEST_APPLICABLE");
  });
});
