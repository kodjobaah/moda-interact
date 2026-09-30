import { createHash } from "node:crypto";
import {
  CommerceAgentPromptScope,
  CommerceEnvironment,
  CommercePromptRevisionStatus,
  Prisma,
  SubscriptionProjectionStatus,
  type PrismaClient,
} from "@prisma/client";
import db from "@/db.server";
import { resolveDeploymentEnvironmentName } from "@/services/otel/otel.runtime";

export type InitialStoreCategoryActivationResult =
  | { kind: "ACTIVATED"; categoryId: string; promptRevisionId: string }
  | { kind: "ALREADY_ACTIVE" }
  | { kind: "NO_PENDING" }
  | { kind: "SUBSCRIPTION_NOT_ACTIVE" };

export class StoreCategoryActivationError extends Error {
  readonly code = "STORE_CATEGORY_PENDING_STATE_CONFLICT";

  constructor() {
    super("The pending Store Category state is inconsistent.");
    this.name = "StoreCategoryActivationError";
  }
}

const pendingStateConflict = () => new StoreCategoryActivationError();

export function resolveShopifyCommerceEnvironment(): CommerceEnvironment {
  const environments: Record<string, CommerceEnvironment> = {
    local: CommerceEnvironment.LOCAL,
    test: CommerceEnvironment.TEST,
    development: CommerceEnvironment.DEVELOPMENT,
    staging: CommerceEnvironment.STAGING,
    production: CommerceEnvironment.PRODUCTION,
  };
  const environment = environments[resolveDeploymentEnvironmentName()];
  if (!environment) throw new Error("Commerce environment is unavailable.");
  return environment;
}

export async function activateInitialPendingStoreCategoryIfEligible(
  input: {
    shopId: string;
    expectedPendingSelectionGeneration?: number;
  },
  client: Pick<PrismaClient, "$transaction"> = db,
  now = new Date(),
): Promise<InitialStoreCategoryActivationResult> {
  const environment = resolveShopifyCommerceEnvironment();

  return client.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "commerce"."Shop" WHERE "id" = ${input.shopId} FOR UPDATE
    `);

    const subscription = await tx.subscription.findUnique({
      where: { shopId: input.shopId },
      select: { status: true, planId: true },
    });
    if (
      !subscription ||
      (subscription.status !== SubscriptionProjectionStatus.ACTIVE &&
        subscription.status !== SubscriptionProjectionStatus.TRIALING) ||
      subscription.planId === null
    ) return { kind: "SUBSCRIPTION_NOT_ACTIVE" };

    const profile = await tx.commerceShopProfile.findUnique({
      where: { shopId: input.shopId },
      select: {
        activeCategoryId: true,
        pendingCategoryId: true,
        pendingPromptRevisionId: true,
        pendingSelectionGeneration: true,
        pendingSelectedAt: true,
      },
    });
    if (!profile) return { kind: "NO_PENDING" };
    if (profile.activeCategoryId !== null) return { kind: "ALREADY_ACTIVE" };

    const hasPendingState =
      profile.pendingCategoryId !== null ||
      profile.pendingPromptRevisionId !== null ||
      profile.pendingSelectedAt !== null;
    if (!hasPendingState) return { kind: "NO_PENDING" };
    if (
      profile.pendingCategoryId === null ||
      profile.pendingPromptRevisionId === null ||
      profile.pendingSelectedAt === null ||
      (input.expectedPendingSelectionGeneration !== undefined &&
        input.expectedPendingSelectionGeneration !== profile.pendingSelectionGeneration)
    ) throw pendingStateConflict();

    const [category, revision] = await Promise.all([
      tx.commercePromptTemplateCategory.findUnique({
        where: { id: profile.pendingCategoryId },
        select: { id: true, defaultTemplateId: true },
      }),
      tx.commerceAgentPromptRevision.findUnique({
        where: { id: profile.pendingPromptRevisionId },
        include: { prompt: true },
      }),
    ]);
    if (
      !category ||
      !revision ||
      revision.status !== CommercePromptRevisionStatus.DRAFT ||
      revision.prompt.scope !== CommerceAgentPromptScope.SHOP ||
      revision.prompt.shopId !== input.shopId ||
      !revision.sourceTemplateId ||
      revision.sourceTemplateEditVersion === null ||
      revision.sourceTemplateId !== category.defaultTemplateId ||
      !revision.promptText.trim()
    ) throw pendingStateConflict();

    const configurations = await tx.commerceAgentConfiguration.findMany({
      where: {
        environment,
        scope: CommerceAgentPromptScope.SHOP,
        shopId: input.shopId,
      },
      select: { id: true },
    });
    if (configurations.length > 1) throw pendingStateConflict();

    const contentHash = createHash("sha256")
      .update(revision.promptText, "utf8")
      .digest("hex");
    const published = await tx.commerceAgentPromptRevision.updateMany({
      where: {
        id: revision.id,
        promptId: revision.promptId,
        status: CommercePromptRevisionStatus.DRAFT,
      },
      data: {
        status: CommercePromptRevisionStatus.PUBLISHED,
        contentHash,
        publishedAt: now,
      },
    });
    if (published.count !== 1) throw pendingStateConflict();

    if (configurations[0]) {
      await tx.commerceAgentConfiguration.update({
        where: { id: configurations[0].id },
        data: {
          activePromptRevisionId: revision.id,
          promptEditVersion: { increment: 1 },
        },
      });
    } else {
      await tx.commerceAgentConfiguration.create({
        data: {
          environment,
          scope: CommerceAgentPromptScope.SHOP,
          shopId: input.shopId,
          activePromptRevisionId: revision.id,
          promptEditVersion: 2,
        },
      });
    }

    const promoted = await tx.commerceShopProfile.updateMany({
      where: {
        shopId: input.shopId,
        activeCategoryId: null,
        pendingCategoryId: profile.pendingCategoryId,
        pendingPromptRevisionId: profile.pendingPromptRevisionId,
        pendingSelectionGeneration: profile.pendingSelectionGeneration,
        pendingSelectedAt: profile.pendingSelectedAt,
      },
      data: {
        activeCategoryId: category.id,
        activeCategoryActivatedAt: now,
        pendingCategoryId: null,
        pendingPromptRevisionId: null,
        pendingSelectedAt: null,
      },
    });
    if (promoted.count !== 1) throw pendingStateConflict();

    return {
      kind: "ACTIVATED",
      categoryId: category.id,
      promptRevisionId: revision.id,
    };
  });
}