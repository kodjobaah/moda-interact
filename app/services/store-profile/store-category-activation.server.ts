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

export async function publishStoreCategoryPromptRevisionInTransaction(input: {
  tx: Prisma.TransactionClient;
  shopId: string;
  categoryId: string;
  promptRevisionId: string;
  now: Date;
}): Promise<{ categoryId: string; promptRevisionId: string }> {
  const environment = resolveShopifyCommerceEnvironment();
  const [category, revision] = await Promise.all([
    input.tx.commercePromptTemplateCategory.findUnique({
      where: { id: input.categoryId },
      select: { id: true },
    }),
    input.tx.commerceAgentPromptRevision.findUnique({
      where: { id: input.promptRevisionId },
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
    !revision.promptText.trim()
  ) throw pendingStateConflict();

  const configurations = await input.tx.commerceAgentConfiguration.findMany({
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
  const published = await input.tx.commerceAgentPromptRevision.updateMany({
    where: {
      id: revision.id,
      promptId: revision.promptId,
      status: CommercePromptRevisionStatus.DRAFT,
    },
    data: {
      status: CommercePromptRevisionStatus.PUBLISHED,
      contentHash,
      publishedAt: input.now,
    },
  });
  if (published.count !== 1) throw pendingStateConflict();

  if (configurations[0]) {
    await input.tx.commerceAgentConfiguration.update({
      where: { id: configurations[0].id },
      data: {
        activePromptRevisionId: revision.id,
        promptEditVersion: { increment: 1 },
      },
    });
  } else {
    await input.tx.commerceAgentConfiguration.create({
      data: {
        environment,
        scope: CommerceAgentPromptScope.SHOP,
        shopId: input.shopId,
        activePromptRevisionId: revision.id,
        promptEditVersion: 2,
      },
    });
  }

  return {
    categoryId: category.id,
    promptRevisionId: revision.id,
  };
}

export async function activateInitialPendingStoreCategoryIfEligible(
  input: {
    shopId: string;
    expectedPendingSelectionGeneration?: number;
  },
  client: Pick<PrismaClient, "$transaction"> = db,
  now = new Date(),
): Promise<InitialStoreCategoryActivationResult> {
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

    const publication = await publishStoreCategoryPromptRevisionInTransaction({
      tx,
      shopId: input.shopId,
      categoryId: profile.pendingCategoryId,
      promptRevisionId: profile.pendingPromptRevisionId,
      now,
    });

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
        activeCategoryId: publication.categoryId,
        activeCategoryActivatedAt: now,
        pendingCategoryId: null,
        pendingPromptRevisionId: null,
        pendingSelectedAt: null,
      },
    });
    if (promoted.count !== 1) throw pendingStateConflict();

    return {
      kind: "ACTIVATED",
      categoryId: publication.categoryId,
      promptRevisionId: publication.promptRevisionId,
    };
  });
}
