import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  PLATFORM_SUPPORT_LANGUAGE_TAG,
  requiresMerchantTranslation,
} from "@modainteract/moda-interact-shared/merchant-communications";
import { BILLING_SYSTEM_MESSAGE_CODES } from "@modainteract/moda-interact-shared/billing";

import prisma from "../../db.server";
import {
  enqueueTranslationBestEffort,
  trustedSupportLanguageTag,
} from "../merchant-support/merchant-support.service";

export type TranslationDispatch = (translationId: string) => Promise<void>;
export const defaultTranslationDispatch: TranslationDispatch = enqueueTranslationBestEffort;

export type SubscriptionLifecycle = {
  planHandle: string;
  provider: string;
  lifecycleIdentity: string | null;
};

export type SubscriptionIdentityFacts = {
  observedShopifyPlanHandle: string | null;
  providerSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
};

export const MISSING_SUBSCRIPTION_LIFECYCLE_IDENTITY =
  "Unable to derive a durable subscription lifecycle identity.";

export function deriveLifecycleIdentity(subscription: SubscriptionIdentityFacts): string | null {
  if (subscription.providerSubscriptionId?.trim()) {
    return `provider:${subscription.providerSubscriptionId.trim()}`;
  }

  const cycleFacts = [
    subscription.currentPeriodStart?.toISOString(),
    subscription.currentPeriodEnd?.toISOString(),
    subscription.trialEndsAt?.toISOString(),
  ];
  if (cycleFacts.every((fact) => !fact)) return null;
  return `cycle:${subscription.observedShopifyPlanHandle ?? "unknown"}:${cycleFacts.map((fact) => fact ?? "none").join(":")}`;
}

export function renderSubscriptionEndedMessage(planHandle: string): string {
  return `Your ${planHandle} subscription has ended and is no longer active.`;
}

export class SubscriptionEndedNotificationService {
  constructor(
    private readonly database: PrismaClient = prisma,
    private readonly dispatchTranslation: TranslationDispatch = defaultTranslationDispatch,
  ) {}

  async notifySubscriptionEnded(shopId: string, lifecycle: SubscriptionLifecycle): Promise<void> {
    try {
      const translationId = await this.persistNotification(shopId, lifecycle);
      if (translationId) await this.dispatchTranslation(translationId);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === MISSING_SUBSCRIPTION_LIFECYCLE_IDENTITY
      ) {
        throw error;
      }
    }
  }

  private async persistNotification(
    shopId: string,
    lifecycle: SubscriptionLifecycle,
  ): Promise<string | null> {
    return this.database.$transaction(async (transaction) => {
      const settings = await transaction.$queryRaw<[{ defaultLanguageTag: string | null }]>(Prisma.sql`
        SELECT "defaultLanguageTag"
        FROM "shopify"."ShopSettings"
        WHERE "shopId" = ${shopId}
      `);
      const configuredLanguageTag = trustedSupportLanguageTag(
        settings[0]?.defaultLanguageTag,
      );
      const now = new Date();
      if (!lifecycle.lifecycleIdentity) {
        throw new Error(MISSING_SUBSCRIPTION_LIFECYCLE_IDENTITY);
      }
      const sourceKey = [
        "subscription-ended:v1",
        shopId,
        lifecycle.provider,
        lifecycle.lifecycleIdentity,
      ].map((part) => encodeURIComponent(part)).join(":");
      const existing = await transaction.$queryRaw<[
        { id: string; displayLanguageTag: string | null } | undefined
      ]>(Prisma.sql`
        SELECT "id", "displayLanguageTag"
        FROM "support"."MerchantSupportMessage"
        WHERE "sourceKey" = ${sourceKey}
      `);
      let messageId = existing[0]?.id;
      let messageWasInserted = false;
      const displayLanguageTag = existing[0]?.displayLanguageTag ?? configuredLanguageTag;
      const needsTranslation = requiresMerchantTranslation(
        PLATFORM_SUPPORT_LANGUAGE_TAG,
        displayLanguageTag,
      );

      const thread = await transaction.$queryRaw<[{ id: string }]>(Prisma.sql`
        INSERT INTO "support"."MerchantSupportThread" (
          "id", "shopId", "createdAt", "updatedAt"
        ) VALUES (${randomUUID()}, ${shopId}, ${now}, ${now})
        ON CONFLICT ("shopId") DO UPDATE SET "updatedAt" = ${now}
        RETURNING "id"
      `);
      const threadId = thread[0]?.id;
      if (!threadId) {
        throw new Error("Unable to create subscription-ended support thread.");
      }

      if (!messageId) {
        messageId = randomUUID();
        const inserted = await transaction.$queryRaw<[{ id: string } | undefined]>(Prisma.sql`
          INSERT INTO "support"."MerchantSupportMessage" (
            "id", "threadId", "kind", "state", "originalBody",
            "sourceLanguageTag", "displayLanguageTag", "systemCode",
            "systemVersion", "sourceKey", "availableAt", "createdAt", "updatedAt"
          ) VALUES (
            ${messageId}, ${threadId}, 'SYSTEM',
            ${needsTranslation ? "PROCESSING" : "AVAILABLE"},
            ${renderSubscriptionEndedMessage(lifecycle.planHandle)},
            ${PLATFORM_SUPPORT_LANGUAGE_TAG}, ${displayLanguageTag},
            ${BILLING_SYSTEM_MESSAGE_CODES.SUBSCRIPTION_ENDED}, '1', ${sourceKey},
            ${needsTranslation ? null : now}, ${now}, ${now}
          ) ON CONFLICT ("sourceKey") DO NOTHING
          RETURNING "id"
        `);
        messageId = inserted[0]?.id;
        messageWasInserted = Boolean(messageId);
        if (!messageId) {
          const persisted = await transaction.$queryRaw<[{ id: string } | undefined]>(Prisma.sql`
            SELECT "id"
            FROM "support"."MerchantSupportMessage"
            WHERE "sourceKey" = ${sourceKey}
          `);
          messageId = persisted[0]?.id;
        }
        if (!messageId) {
          throw new Error("Unable to persist subscription-ended support message.");
        }
      }

      await transaction.$executeRaw(Prisma.sql`
        UPDATE "support"."MerchantSupportThread"
        SET "lastMessageAt" = CASE
          WHEN ${!messageWasInserted} THEN "lastMessageAt"
          ELSE ${now}
        END,
        "updatedAt" = ${now}
        WHERE "id" = ${threadId} AND "shopId" = ${shopId}
      `);

      if (!needsTranslation) return null;

      const translations = await transaction.$queryRaw<[{ id: string } | undefined]>(Prisma.sql`
        SELECT "id"
        FROM "support"."MerchantMessageTranslation"
        WHERE "messageId" = ${messageId}
          AND "targetLanguageTag" = ${displayLanguageTag}
      `);
      if (translations[0]?.id) return null;

      const translationId = randomUUID();
      const insertedTranslation = await transaction.$queryRaw<[{ id: string } | undefined]>(Prisma.sql`
        INSERT INTO "support"."MerchantMessageTranslation" (
          "id", "messageId", "direction", "sourceLanguageTag",
          "targetLanguageTag", "status", "createdAt", "updatedAt"
        ) VALUES (
          ${translationId}, ${messageId}, 'SYSTEM_TO_MERCHANT',
          ${PLATFORM_SUPPORT_LANGUAGE_TAG}, ${displayLanguageTag},
          'PENDING', ${now}, ${now}
        ) ON CONFLICT ("messageId", "targetLanguageTag") DO NOTHING
        RETURNING "id"
      `);
      return insertedTranslation[0]?.id ?? null;
    });
  }
}