import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MerchantKnowledgeFeatureConfigurationSchema,
  type MerchantKnowledgeFeatureConfiguration,
} from "@modainteract/moda-interact-shared/merchant-knowledge";
import db from "@/db.server";

const FEATURE_KEY = "merchant_knowledge";

export type MerchantKnowledgeEntitlement =
  | { kind: "entitled"; configuration: MerchantKnowledgeFeatureConfiguration }
  | { kind: "denied" }
  | { kind: "unavailable"; retryable: boolean };

const subscriptionSelection = {
  status: true,
  planId: true,
  plan: {
    select: {
      active: true,
      features: {
        where: {
          enabled: true,
          feature: {
            key: FEATURE_KEY,
            active: true,
            activationMode: "MERCHANT_OPT_IN",
          },
        },
        select: {
          enabled: true,
          configuration: true,
          feature: {
            select: { key: true, active: true, activationMode: true },
          },
        },
      },
    },
  },
} satisfies Prisma.SubscriptionSelect;

type SubscriptionRow = Prisma.SubscriptionGetPayload<{
  select: typeof subscriptionSelection;
}>;

export async function loadCurrentMerchantKnowledgeEntitlement(
  shopId: string,
  client: Pick<PrismaClient, "subscription"> = db,
): Promise<MerchantKnowledgeEntitlement> {
  let subscription: SubscriptionRow | null;
  try {
    subscription = await client.subscription.findUnique({
      where: { shopId },
      select: subscriptionSelection,
    });
  } catch {
    return { kind: "unavailable", retryable: true };
  }

  if (
    !subscription ||
    (subscription.status !== "ACTIVE" && subscription.status !== "TRIALING") ||
    !subscription.planId ||
    !subscription.plan?.active
  ) {
    return { kind: "denied" };
  }

  const mapping = subscription.plan.features.find(
    (candidate) =>
      candidate.enabled &&
      candidate.feature.key === FEATURE_KEY &&
      candidate.feature.active &&
      candidate.feature.activationMode === "MERCHANT_OPT_IN",
  );
  if (!mapping) return { kind: "denied" };

  const configuration = MerchantKnowledgeFeatureConfigurationSchema.safeParse(
    mapping.configuration,
  );
  if (!configuration.success)
    return { kind: "unavailable", retryable: false };

  return { kind: "entitled", configuration: configuration.data };
}