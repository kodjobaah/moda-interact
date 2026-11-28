import { createHash, randomUUID } from "node:crypto";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  startBillingPostgresFixture,
  type BillingPostgresFixture,
} from "../helpers/billing-postgres";

vi.mock("../../app/db.server", () => ({ default: {} }));
import {
  readUsageHistory,
  readUsageSources,
} from "../../app/services/usage/history.server";
import { readRecoveryCohortSummary } from "../../app/services/recoveries/recovery-readers.server";
import { normalizeRecoveryQuery } from "../../app/services/recoveries/recovery-query.server";

const october = new Date("2026-10-01T00:00:00Z");
const november = new Date("2026-11-01T00:00:00Z");
const december = new Date("2026-12-01T00:00:00Z");
const beforeClose = new Date("2026-10-31T23:59:59Z");
const afterClose = new Date("2026-11-02T00:00:00Z");

describe.skipIf(process.env.MODA_DISPOSABLE_INTEGRATION !== "1")(
  "Shopify retry ledger on migrated PostgreSQL",
  () => {
    let fixture: BillingPostgresFixture;
    beforeAll(async () => {
      fixture = await startBillingPostgresFixture();
    }, 240_000);
    afterAll(async () => {
      await fixture?.cleanup();
    }, 60_000);

    it("includes purchased/promotional debits and late corrections in the original period without provider or tenant leakage", async () => {
      const db = fixture.database;
      const suffix = randomUUID();
      const shop = await db.shop.create({
        data: { domain: `${suffix}.myshopify.com`, platform: "SHOPIFY" },
      });
      const foreign = await db.shop.create({
        data: {
          domain: `foreign-${suffix}.myshopify.com`,
          platform: "SHOPIFY",
        },
      });
      const plan = await db.billingPlan.create({
        data: {
          name: `Usage ${suffix}`,
          kind: "PAID_METERED",
          shopifyPlanHandle: `usage-${suffix}`,
        },
      });
      const subscription = await db.subscription.create({
        data: { shopId: shop.id, planId: plan.id, status: "ACTIVE" },
      });
      const old = await db.billingPeriod.create({
        data: {
          shopId: shop.id,
          subscriptionId: subscription.id,
          planId: plan.id,
          planKindSnapshot: "PAID_METERED",
          periodStart: october,
          periodEnd: november,
          status: "CLOSED",
          closedAt: november,
          closeReason: "RENEWED_SAME_PLAN",
        },
      });
      const current = await db.billingPeriod.create({
        data: {
          shopId: shop.id,
          subscriptionId: subscription.id,
          planId: plan.id,
          planKindSnapshot: "PAID_METERED",
          periodStart: november,
          periodEnd: december,
          status: "OPEN",
        },
      });
      await db.subscription.update({
        where: { id: subscription.id },
        data: {
          billingPeriodId: current.id,
          currentPeriodStart: november,
          currentPeriodEnd: december,
        },
      });
      const add = (
        label: string,
        data: Partial<Prisma.UsageEventUncheckedCreateInput> = {},
      ) =>
        db.usageEvent.create({
          data: {
            shopId: shop.id,
            provider: "SHOPIFY",
            metric: "RECOVERY_CONVERSATION",
            quantity: 1,
            idempotencyKey: `${suffix}-${label}`,
            occurredAt: beforeClose,
            ...data,
          },
        });
      const failed = await add("original-purchased", {
        sourceType: "PURCHASED_RECOVERY_CREDITS",
      });
      const negative = await add("late-correction", {
        quantity: -1,
        correctionOfUsageEventId: failed.id,
        sourceType: "RECOVERY_UNDELIVERABLE_COMPENSATION",
        occurredAt: afterClose,
      });
      const retry = await add("retry-purchased", {
        sourceType: "PURCHASED_RECOVERY_CREDITS",
        occurredAt: afterClose,
      });
      // The paid writer uses a billing-period-prefixed committed reservation key.
      // A retry-linked or legacy debit must resolve via that reservation rather
      // than interpreting its sourceId as a CheckoutRecovery primary key.
      const recovery = await db.checkoutRecovery.create({
        data: {
          shopId: shop.id,
          checkoutToken: `ledger-link-${suffix}`,
          lastExternalActivityAt: beforeClose,
        },
      });
      const promotion = await add("old-promotion", {
        sourceType: "PROMOTIONAL_RECOVERY_CREDITS",
        occurredAt: october,
        sourceId: recovery.id,
      });
      const included = await add("old-included", {
        sourceType: "PAID_RECOVERY_CONVERSATION",
        billingPeriodId: old.id,
      });
      const unrelated = await db.checkoutRecovery.create({
        data: {
          shopId: shop.id,
          checkoutToken: `ledger-unrelated-${suffix}`,
          lastExternalActivityAt: beforeClose,
        },
      });
      const includedCorrection = await add("late-included-correction", {
        quantity: -1,
        correctionOfUsageEventId: included.id,
        billingPeriodId: old.id,
        sourceType: "RECOVERY_UNDELIVERABLE_COMPENSATION",
        occurredAt: afterClose,
        sourceId: unrelated.id,
      });
      const paidCounter = await db.billingPeriodEntitlementCounter.create({
        data: {
          shopId: shop.id,
          billingPeriodId: old.id,
          counter: "INCLUDED_RECOVERY_CREDITS",
          grantedQuantity: 10,
          committedQuantity: 1,
        },
      });
      const paidKey = createRecoveryIdempotencyKey(shop.id, recovery.id);
      await db.usageReservation.create({
        data: {
          shopId: shop.id,
          billingPeriodEntitlementCounterId: paidCounter.id,
          quantity: 1,
          status: "COMMITTED",
          sourceKey: `paid-included:${old.id}:${paidKey}`,
          committedUsageEventId: included.id,
        },
      });
      const legacyIncluded = await add("old-legacy-included", {
        sourceType: "PAID_RECOVERY_CONVERSATION",
        billingPeriodId: old.id,
      });
      const legacyCorrection = await add("late-legacy-correction", {
        quantity: -1,
        correctionOfUsageEventId: legacyIncluded.id,
        sourceType: "RECOVERY_UNDELIVERABLE_COMPENSATION",
        occurredAt: afterClose,
      });
      const nextBoundary = await add("next-period-start", {
        sourceType: "PROMOTIONAL_RECOVERY_CREDITS",
        occurredAt: november,
      });
      const unlinkedFree = await add("free", {
        sourceType: "FREE_RECOVERY_RESERVATION",
      });
      const unrelatedMetric = await add("physical", {
        metric: "OUTBOUND_AUTOMATED_MESSAGE",
        billingPeriodId: old.id,
      });
      const foreignProvider = await add("foreign-provider", {
        provider: "WOOCOMMERCE",
        billingPeriodId: old.id,
      });
      const foreignTenant = await add("foreign-shop", {
        shopId: foreign.id,
        sourceType: "PURCHASED_RECOVERY_CREDITS",
      });

      const foreignCorrection = await add("foreign-parent", {
        quantity: -1,
        correctionOfUsageEventId: foreignTenant.id,
        sourceType: "PURCHASED_RECOVERY_CREDITS",
        occurredAt: afterClose,
      });
      const chainedCorrection = await add("correction-of-correction", {
        quantity: -1,
        correctionOfUsageEventId: negative.id,
        billingPeriodId: old.id,
      });

      const past = await readUsageHistory(
        shop.id,
        new URLSearchParams({ bill: "past", billId: old.id }),
        db,
      );
      expect(past.usagePagination).toMatchObject({
        billId: old.id,
        total: 7,
        totalQuantity: 1,
      });
      expect(new Set(past.usageEvents.map((row) => row.id))).toEqual(
        new Set([
          failed.id,
          negative.id,
          promotion.id,
          included.id,
          includedCorrection.id,
          legacyIncluded.id,
          legacyCorrection.id,
        ]),
      );
      expect(
        past.usageEvents
          .filter((row) => row.quantity < 0)
          .map((row) => row.id)
          .sort(),
      ).toEqual(
        [negative.id, includedCorrection.id, legacyCorrection.id].sort(),
      );
      for (const id of [included.id, includedCorrection.id, promotion.id]) {
        expect(
          past.usageEvents.find((row) => row.id === id)?.sourceRecovery
            ?.recoveryId,
        ).toBe(recovery.id);
      }
      expect(
        past.usageEvents.find((row) => row.id === failed.id)?.sourceRecovery,
      ).toBeNull();
      expect(
        (
          await readUsageSources(
            foreign.id,
            [included.id, includedCorrection.id],
            db,
          )
        ).size,
      ).toBe(0);
      expect(
        (
          await readUsageSources(
            shop.id,
            [foreignCorrection.id, chainedCorrection.id, foreignProvider.id],
            db,
          )
        ).size,
      ).toBe(0);
      const present = await readUsageHistory(
        shop.id,
        new URLSearchParams(),
        db,
      );
      expect(present.usagePagination).toMatchObject({
        billId: current.id,
        total: 2,
        totalQuantity: 2,
      });
      expect(new Set(present.usageEvents.map((row) => row.id))).toEqual(
        new Set([retry.id, nextBoundary.id]),
      );
      for (const excluded of [
        unlinkedFree,
        unrelatedMetric,
        foreignProvider,
        foreignTenant,
        foreignCorrection,
        chainedCorrection,
      ]) {
        expect(
          [...past.usageEvents, ...present.usageEvents].some(
            (row) => row.id === excluded.id,
          ),
        ).toBe(false);
      }
      // Real purchase/award allocations for unified source filtering, after
      // the legacy-history checks intentionally exercising incomplete evidence.
      const purchasedCounter = await db.shopEntitlementCounter.create({
        data: {
          shopId: shop.id,
          counter: "PURCHASED_RECOVERY_CREDITS",
          grantedQuantity: 3,
          committedQuantity: 1,
        },
      });
      const pack = await add("purchase-pack", {
        metric: "RECOVERY_CREDIT_PACK_PURCHASE",
        billingPeriodId: old.id,
        sourceType: "RECOVERY_CREDIT_PURCHASE",
        shopifyReportState: "REPORTED",
      });
      const purchase = await db.recoveryCreditPurchase.create({
        data: {
          id: randomUUID(),
          shopId: shop.id,
          planId: plan.id,
          billingPeriodId: old.id,
          provider: "SHOPIFY",
          status: "ACTIVE",
          creditsGranted: 3,
          currentAmount: 2,
          shopifyPlanHandleSnapshot: plan.shopifyPlanHandle,
          shopifyEventHandleSnapshot: `pack-${suffix}`,
          providerSubscriptionIdSnapshot: `subscription-${suffix}`,
          usageEventId: pack.id,
          providerUsageQuantityBeforeSnapshot: 0,
          providerUsageQuantityAfterSnapshot: 1,
          providerUsageCostBeforeSnapshot: "0.00",
          providerUsageCostAfterSnapshot: "5.00",
          providerUsageCostCurrencyBeforeSnapshot: "USD",
          providerUsageCostCurrencyAfterSnapshot: "USD",
          providerValuationConfirmedAt: beforeClose,
          providerPriceSnapshot: {
            kind: "FIXED",
            amount: "5.00",
            currency: "USD",
          },
          providerPurchaseAmount: "5.00",
          providerPurchaseCurrency: "USD",
          activatedAt: beforeClose,
        },
      });
      await db.usageReservation.create({
        data: {
          shopId: shop.id,
          counterId: purchasedCounter.id,
          purchasedCreditPurchaseId: purchase.id,
          sourceKey: `ledger-purchase-original-${suffix}`,
          quantity: 1,
          status: "COMMITTED",
          committedUsageEventId: failed.id,
          compensationUsageEventId: negative.id,
          compensationReason: "WHATSAPP_DELIVERY_FAILED",
          compensationDisposition: "RESTORED_SPENDABLE",
          compensatedAt: afterClose,
        },
      });
      await db.usageReservation.create({
        data: {
          shopId: shop.id,
          counterId: purchasedCounter.id,
          purchasedCreditPurchaseId: purchase.id,
          sourceKey: `ledger-purchase-retry-${suffix}`,
          quantity: 1,
          status: "COMMITTED",
          committedUsageEventId: retry.id,
        },
      });
      const admin = await db.platformAdmin.create({
        data: { email: `ledger-${suffix}@example.test` },
      });
      const campaign = await db.promotionCampaign.create({
        data: {
          name: `Ledger ${suffix}`,
          scope: "GLOBAL",
          quantity: 2,
          startsAt: october,
          expiresAt: november,
          status: "ACTIVE",
          createdByPlatformAdminId: admin.id,
        },
      });
      const grant = await db.promotionalCreditGrant.create({
        data: {
          shopId: shop.id,
          campaignId: campaign.id,
          quantity: 2,
          committedQuantity: 1,
        },
      });
      await db.usageReservation.create({
        data: {
          shopId: shop.id,
          promotionalCreditGrantId: grant.id,
          quantity: 1,
          status: "COMMITTED",
          sourceKey: `ledger-promotion-${suffix}`,
          committedUsageEventId: promotion.id,
        },
      });

      const all = await readUsageHistory(
        shop.id,
        new URLSearchParams("bill=all&pageSize=25"),
        db,
      );
      expect(all.usageView).toBe("all");
      expect(all.usagePagination).toMatchObject({
        billId: null,
        total: 10,
        totalQuantity: 4,
      });
      expect(
        all.usageEvents.find((row) => row.id === included.id)?.chargedAgainst,
      ).toBe("INCLUDED_PLAN_ALLOWANCE");
      expect(
        all.usageEvents.find((row) => row.id === includedCorrection.id)
          ?.chargedAgainst,
      ).toBe("INCLUDED_PLAN_ALLOWANCE");
      expect(
        all.usageEvents.find((row) => row.id === failed.id)?.chargedAgainst,
      ).toBe("PURCHASED_TOP_UP");
      expect(
        all.usageEvents.find((row) => row.id === unlinkedFree.id)
          ?.chargedAgainst,
      ).toBe("UNATTRIBUTED");
      for (const excluded of [
        pack,
        unrelatedMetric,
        foreignProvider,
        foreignTenant,
        foreignCorrection,
        chainedCorrection,
      ])
        expect(all.usageEvents.some((row) => row.id === excluded.id)).toBe(
          false,
        );
      const onlyIncluded = await readUsageHistory(
        shop.id,
        new URLSearchParams("bill=all&chargeSource=INCLUDED_PLAN_ALLOWANCE"),
        db,
      );
      expect(onlyIncluded.usagePagination).toMatchObject({
        total: 2,
        totalQuantity: 0,
      });
      expect(new Set(onlyIncluded.usageEvents.map((row) => row.id))).toEqual(
        new Set([included.id, includedCorrection.id]),
      );
      const purchased = await readUsageHistory(
        shop.id,
        new URLSearchParams("bill=all&chargeSource=PURCHASED_TOP_UP"),
        db,
      );
      expect(purchased.usagePagination).toMatchObject({
        total: 3,
        totalQuantity: 1,
      });
      expect(new Set(purchased.usageEvents.map((row) => row.id))).toEqual(
        new Set([failed.id, negative.id, retry.id]),
      );
      const restoredPeriod = await readUsageHistory(
        shop.id,
        new URLSearchParams(
          `bill=past&billId=${old.id}&chargeSource=PURCHASED_TOP_UP`,
        ),
        db,
      );
      expect(restoredPeriod.usagePagination).toMatchObject({
        total: 2,
        totalQuantity: 0,
      });
      const promotional = await readUsageHistory(
        shop.id,
        new URLSearchParams("bill=all&chargeSource=PROMOTIONAL_CREDITS"),
        db,
      );
      expect(promotional.usagePagination).toMatchObject({
        total: 1,
        totalQuantity: 1,
      });
      expect(promotional.usageEvents[0]?.id).toBe(promotion.id);

      const missing = await readUsageHistory(
        foreign.id,
        new URLSearchParams({ billId: old.id }),
        db,
      );
      expect(missing.state).toBe("unavailable");
      expect(missing.usageEvents).toEqual([]);
    });

    it("counts completed checkouts and recovered revenue once irrespective of physical outreach history", async () => {
      const db = fixture.database;
      const suffix = randomUUID();
      const shop = await db.shop.create({
        data: { domain: `${suffix}.myshopify.com`, platform: "SHOPIFY" },
      });
      const recovery = await db.checkoutRecovery.create({
        data: {
          shopId: shop.id,
          checkoutToken: suffix,
          status: "COMPLETED",
          currency: "GBP",
          totalPrice: "19.95",
          detectedAt: beforeClose,
          lastExternalActivityAt: beforeClose,
          completedAt: afterClose,
        },
      });
      const query = normalizeRecoveryQuery(
        new URLSearchParams({ from: "2026-10-01", to: "2026-10-31" }),
        { timeZone: "UTC" },
        december,
      );
      const before = await readRecoveryCohortSummary(shop.id, query, db);
      // Persist real historical outreach evidence, not a WAITING_FOR_RESPONSE
      // attempt without its required sent message or an orphan retry identifier.
      const originalAt = november;
      const failedAt = new Date(originalAt.getTime() + 60_000);
      const retryAt = new Date(failedAt.getTime() + 30 * 60_000);
      const deliveredAt = new Date(retryAt.getTime() + 1_000);
      const conversation = await db.conversation.create({
        data: {
          checkoutRecoveryId: recovery.id,
          type: "RECOVERY",
          outcome: "RECOVERED",
        },
      });
      const sender = {
        dispatchProviderAccountId: "1234567890123",
        dispatchProviderPhoneNumberId: "1234567890124",
      };
      const failedMessage = await db.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          direction: "OUTBOUND",
          senderType: "AUTOMATION",
          status: "FAILED",
          content: "Original outreach",
          providerMessageId: `wamid.${randomUUID()}`,
          sentAt: originalAt,
          failedAt,
          providerFailureCode: "131016",
          ...sender,
        },
      });
      const original = await db.recoveryOutreachAttempt.create({
        data: {
          checkoutRecoveryId: recovery.id,
          recipient: "447700900001",
          sequence: 1,
          trigger: "INITIAL",
          status: "FAILED",
          configuredOfferMode: "NONE",
          sentAt: originalAt,
          outboundMessageId: failedMessage.id,
        },
      });
      const counter = await db.shopEntitlementCounter.create({
        data: {
          shopId: shop.id,
          counter: "LIFETIME_FREE_RECOVERY_CREDITS",
          grantedQuantity: 2,
          committedQuantity: 1,
        },
      });
      const recordDebit = async (
        attemptId: string,
        sentAt: Date,
        compensatedAt?: Date,
      ) => {
        const reservationId = randomUUID();
        const sourceKey = createRecoveryIdempotencyKey(
          shop.id,
          `recovery-outreach:${attemptId}`,
        );
        const debit = await db.usageEvent.create({
          data: {
            shopId: shop.id,
            provider: "SHOPIFY",
            metric: "RECOVERY_CONVERSATION",
            quantity: 1,
            sourceType: "FREE_RECOVERY_RESERVATION",
            sourceId: reservationId,
            idempotencyKey: createRecoveryIdempotencyKey(shop.id, sourceKey),
            occurredAt: sentAt,
          },
        });
        const correction = compensatedAt
          ? await db.usageEvent.create({
              data: {
                shopId: shop.id,
                provider: "SHOPIFY",
                metric: "RECOVERY_CONVERSATION",
                quantity: -1,
                sourceType: "RECOVERY_UNDELIVERABLE_COMPENSATION",
                sourceId: reservationId,
                idempotencyKey: `arch028-undelivered:${reservationId}`,
                correctionOfUsageEventId: debit.id,
                occurredAt: compensatedAt,
              },
            })
          : null;
        return db.usageReservation.create({
          data: {
            id: reservationId,
            shopId: shop.id,
            counterId: counter.id,
            sourceKey,
            quantity: 1,
            status: "COMMITTED",
            committedUsageEventId: debit.id,
            ...(correction && compensatedAt
              ? {
                  compensationUsageEventId: correction.id,
                  compensationReason: "WHATSAPP_DELIVERY_FAILED",
                  compensationDisposition: "RESTORED_SPENDABLE",
                  compensatedAt,
                }
              : {}),
          },
        });
      };
      const reservation = await recordDebit(original.id, originalAt, failedAt);
      const intent = await db.recoveryOutreachRetryIntent.create({
        data: {
          failedAttemptId: original.id,
          failedMessageId: failedMessage.id,
          fundingReservationId: reservation.id,
          providerFailureCode: "131016",
          policy: "AFTER_COOLDOWN",
          notBeforeAt: retryAt,
          expectedGeneration: recovery.generation,
          expectedLastExternalActivityAt: recovery.lastExternalActivityAt,
        },
      });
      const retryId = `retry_${intent.id}`;
      const retryMessage = await db.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          direction: "OUTBOUND",
          senderType: "AUTOMATION",
          status: "DELIVERED",
          content: "Retry outreach",
          providerMessageId: `wamid.${randomUUID()}`,
          sentAt: retryAt,
          deliveredAt,
          ...sender,
          providerDispatchKey: `recovery-retry-${createHash("sha256").update(retryId).digest("hex")}`,
          providerDispatchAdmittedAt: retryAt,
          providerDispatchControlRevision: conversation.controlRevision,
        },
      });
      await db.recoveryOutreachAttempt.create({
        data: {
          id: retryId,
          checkoutRecoveryId: recovery.id,
          recipient: original.recipient,
          sequence: 3,
          trigger: "INITIAL",
          status: "WAITING_FOR_RESPONSE",
          configuredOfferMode: "NONE",
          sentAt: retryAt,
          outboundMessageId: retryMessage.id,
        },
      });
      const retryReservation = await recordDebit(retryId, retryAt);
      const ids = [
        reservation.committedUsageEventId!,
        reservation.compensationUsageEventId!,
        retryReservation.committedUsageEventId!,
      ];
      const all = await readUsageHistory(
        shop.id,
        new URLSearchParams("bill=all&chargeSource=LIFETIME_FREE_CREDITS"),
        db,
      );
      expect(all.usagePagination).toMatchObject({ total: 3, totalQuantity: 1 });
      expect(new Set(all.usageEvents.map((row) => row.id))).toEqual(
        new Set(ids),
      );
      expect(
        all.usageEvents.every(
          (row) => row.chargedAgainst === "LIFETIME_FREE_CREDITS",
        ),
      ).toBe(true);
      const links = await readUsageSources(shop.id, ids, db);
      expect(links.size).toBe(3);
      for (const id of ids) expect(links.get(id)?.recoveryId).toBe(recovery.id);
      expect(
        await db.recoveryOutreachAttempt.count({
          where: { checkoutRecoveryId: recovery.id },
        }),
      ).toBe(2);
      const after = await readRecoveryCohortSummary(shop.id, query, db);
      expect(after).toEqual(before);
      expect(after).toMatchObject({
        started: 1,
        recovered: 1,
        recoveryRate: 1,
        recoveredValues: [{ currency: "GBP", count: 1 }],
        unknownValueCount: 0,
      });
      expect(after.recoveredValues).toHaveLength(1);
      expect(
        new Prisma.Decimal(after.recoveredValues[0]!.totalPrice).equals(
          "19.95",
        ),
      ).toBe(true);
    });
  },
);
