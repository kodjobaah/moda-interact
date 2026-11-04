import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { selectCapabilities } from "@modainteract/moda-interact-shared/commerce";
import { z } from "zod";
import db from "@/db.server";
import type { SettingsReadContext } from "./settings-read-context.server";

export class PreferenceError extends Error {}
export const revisionOf = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function lockSettingsShop(
  client: Prisma.TransactionClient,
  shopId: string,
) {
  const rows = await client.$queryRaw<
    Array<{ id: string }>
  >`SELECT "id" FROM "commerce"."Shop" WHERE "id" = ${shopId} AND "status" = 'ACTIVE' FOR UPDATE`;
  if (!rows.length) throw new PreferenceError("DENIED");
}
function requireFeaturePlan(
  subscription: SettingsReadContext["subscription"],
  status: SettingsReadContext["shop"]["status"] | undefined,
  plan: SettingsReadContext["plan"],
): asserts plan is NonNullable<SettingsReadContext["plan"]> {
  if (!subscription || !["ACTIVE", "TRIALING"].includes(subscription.status) ||
    status !== "ACTIVE" || !plan?.active) throw new PreferenceError("DENIED");
}
export async function loadFeaturePreferences(
  shopId: string,
  client: Prisma.TransactionClient = db,
) {
  const subscription = await client.subscription.findUnique({
    where: { shopId },
    include: {
      plan: {
        include: {
          features: {
            include: { feature: true },
            orderBy: [
              { feature: { displayName: "asc" } },
              { featureId: "asc" },
            ],
          },
        },
      },
      shop: { select: { status: true } },
    },
  });
  requireFeaturePlan(subscription, subscription?.shop.status, subscription?.plan ?? null);
  const preferences = await client.shopFeaturePreference.findMany({
    where: { shopId },
    orderBy: { featureId: "asc" },
  });
  return projectFeaturePreferences({
    shop: subscription?.shop ?? { status: "ACTIVE" },
    subscription,
    plan: subscription?.plan ?? null,
    preferences,
  });
}
export function projectFeaturePreferences({
  shop,
  subscription,
  plan,
  preferences,
}: Pick<SettingsReadContext, "subscription" | "plan" | "preferences"> & {
  shop: Pick<SettingsReadContext["shop"], "status">;
}) {
  requireFeaturePlan(subscription, shop.status, plan);
  const mappings = plan.features.filter((m) => m.enabled && m.feature.active);
  const facts = mappings.map((m) => ({
    id: m.featureId,
    active: m.feature.active,
    planMappingEnabled: m.enabled,
    mode: m.feature.activationMode,
    preferenceEnabled:
      preferences.find((p) => p.featureId === m.featureId)?.enabled ?? false,
  }));
  const selected = new Set(
    selectCapabilities(
      mappings.map((mapping, position) => ({
        key: `feature_${position}`,
        featureId: mapping.featureId,
        enabled: true,
        position,
      })),
      { features: facts },
    ),
  );
  return {
    revision: revisionOf({
      planId: plan.id,
      mappings: mappings.map((m) => [
        m.featureId,
        m.feature.updatedAt,
        m.enabled,
      ]),
      preferences: preferences.map((p) => [
        p.featureId,
        p.enabled,
        p.updatedAt,
      ]),
    }),
    features: mappings.map((m, i) => ({
      id: m.featureId,
      key: m.feature.key,
      name: m.feature.displayName,
      description: m.feature.description,
      enabled: facts[i].preferenceEnabled,
      effective: selected.has(`feature_${i}`),
      editable:
        m.feature.activationMode === "MERCHANT_OPT_IN" &&
        !m.feature.systemRequired,
    })),
  };
}
const DesiredPreferences = z
  .array(
    z.strictObject({
      featureId: z.string().min(1).max(128),
      enabled: z.boolean(),
    }),
  )
  .max(1000)
  .refine((rows) => new Set(rows.map((r) => r.featureId)).size === rows.length);
export async function saveFeaturePreferences(
  shopId: string,
  input: unknown,
  expectedRevision: string,
  client: PrismaClient = db,
) {
  const desired = DesiredPreferences.parse(input);
  return client.$transaction(async (transaction) => {
    await lockSettingsShop(transaction, shopId);
    const current = await loadFeaturePreferences(shopId, transaction);
    for (const row of desired)
      if (!current.features.some((f) => f.id === row.featureId && f.editable))
        throw new PreferenceError("DENIED");
    const changes = desired.filter(
      (row) =>
        current.features.find((f) => f.id === row.featureId)!.enabled !==
        row.enabled,
    );
    if (!changes.length) return current;
    if (current.revision !== expectedRevision)
      throw new PreferenceError("CONFLICT");
    for (const row of changes)
      await transaction.shopFeaturePreference.upsert({
        where: { shopId_featureId: { shopId, featureId: row.featureId } },
        create: { shopId, ...row },
        update: { enabled: row.enabled },
      });
    return loadFeaturePreferences(shopId, transaction);
  });
}
