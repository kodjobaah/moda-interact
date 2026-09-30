import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { selectCapabilities } from "@modainteract/moda-interact-shared/commerce";
import { z } from "zod";
import db from "@/db.server";

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
  if (
    !subscription ||
    !["ACTIVE", "TRIALING"].includes(subscription.status) ||
    subscription.shop.status !== "ACTIVE" ||
    !subscription.plan?.active
  )
    throw new PreferenceError("DENIED");
  const preferences = await client.shopFeaturePreference.findMany({
    where: { shopId },
    orderBy: { featureId: "asc" },
  });
  const mappings = subscription.plan.features.filter(
    (m) => m.enabled && m.feature.active,
  );
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
      [
        {
          binding: { kind: "BASE", key: "conversation_core" },
          enabled: true,
          position: 0,
        },
        ...mappings.map((m, i) => ({
          binding: {
            kind: "FEATURE" as const,
            key: `feature_${i}`,
            featureId: m.featureId,
          },
          enabled: true,
          position: i + 1,
        })),
      ],
      { features: facts, offerMode: "NONE" },
    ),
  );
  return {
    revision: revisionOf({
      planId: subscription.plan.id,
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
