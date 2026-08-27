import {
  redirect,
  useSearchParams,
  useLoaderData,
} from "react-router";

import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";

import Dashboard from "@/components/dashboard/Dashboard";
import Onboarding from "@/components/onboarding/Onboarding";
import UsageOverview from "@/components/dashboard/UsageOverview";

import {
  shopService,
} from "@/services/shop/shop.service";

import {
  billingService,
} from "@/services/billing/billing.service";

import db from "../db.server";


export const loader = async ({ request }) => {
  const {
    admin,
    session,
  } = await authenticate.admin(request);
  const url = new URL(request.url);
  const usageView = url.searchParams.get("bill") === "past" ? "past" : "current";
  const requestedBillId = url.searchParams.get("billId");

  /*
   * Resolve Shopify's shop into our
   * internal tenant.
   */
  const shop =
    await shopService.resolveShopifyShop({
      admin,
      domain: session.shop,
    });

  console.log("Resolved shop:", shop);
  /*
   * ShopSettings is now related using shopId,
   * rather than the Shopify domain string.
   */
  const settings =
    await db.shopSettings.findUnique({
      where: {
        shopId: shop.id,
      },
    });

console.log("Resolved shop settings:", settings);
  /*
   * Let the merchant complete onboarding first.
   */
  if (!settings) {
    return {
      settings: null,
      subscription: null,
      recoveries: [],
      billingPeriods: [],
      usageSummary: { current: [], past: [] },

      stats: {
        abandonedCheckouts: 0,
        recoveredCheckouts: 0,
        recoveredRevenue: 0,
        messagesSent: 0,
      },
    };
  }


  /*
   * Read local billing state.
   *
   * We don't need to call Shopify here.
   */
  const subscription =
    await billingService.getSubscription(
      shop.id,
    );

  if (!subscription) {
    throw redirect("/app/billing");
  }

  const recoveries = await db.checkoutRecovery.findMany({ where: { shopId: shop.id }, include: { customer: { select: { id: true, firstName: true, lastName: true, email: true } }, conversations: { include: { messages: true } } }, orderBy: { detectedAt: "desc" } });
  const allUsageWhere = { shopId: shop.id };
  const billingPeriods = await db.billingPeriod.findMany({ where: { shopId: shop.id }, include: { usageEvents: { select: { metric: true, quantity: true } } }, orderBy: { periodStart: "desc" } });
  const selectedPeriod = billingPeriods.find((period) => period.id === requestedBillId) ?? billingPeriods.find((period) => usageView === "past" ? period.status === "PAID" : period.status === "OPEN");
  const recoveryUsageEvents = await db.usageEvent.findMany({ where: allUsageWhere, orderBy: { occurredAt: "desc" } });
  const [currentUsageEvents, paidUsageEvents] = await Promise.all([
    db.usageEvent.findMany({ where: { shopId: shop.id, reportedAt: null }, orderBy: { occurredAt: "desc" } }),
    db.usageEvent.findMany({ where: { shopId: shop.id, reportedAt: { not: null } }, orderBy: { occurredAt: "desc" } }),
  ]);
  const completedRecoveries = recoveries.filter((recovery) => recovery.status === "COMPLETED");
  const messagesSent = recoveries.reduce((total, recovery) => total + (recovery.conversations[0]?.messages.length ?? 0), 0);
  const recoveryBySourceId = new Map();
  for (const recovery of recoveries) {
    const conversation = recovery.conversations[0];
    const customerName = [recovery.customer?.firstName, recovery.customer?.lastName].filter(Boolean).join(" ") || recovery.customer?.email || "Guest";
    recoveryBySourceId.set(recovery.id, { recoveryId: recovery.id, customerName });
    if (conversation) {
      recoveryBySourceId.set(conversation.id, { recoveryId: recovery.id, customerName });
      for (const message of conversation.messages) {
        recoveryBySourceId.set(message.id, { recoveryId: recovery.id, customerName });
      }
    }
  }


  return {
    settings,

    subscription: {
      status: subscription.status,

      planHandle:
        subscription.planHandle,

      planName:
        subscription.plan?.name ??
        subscription.planHandle,
    },

    stats: {
      abandonedCheckouts: recoveries.length,
      recoveredCheckouts: completedRecoveries.length,
      recoveredRevenue: completedRecoveries.reduce((total, recovery) => total + Number(recovery.totalPrice ?? 0), 0),
      messagesSent,
    },
    recoveries: recoveries.map((recovery) => {
      const conversation = recovery.conversations[0];
      const messageIds = conversation?.messages.map((message) => message.id) ?? [];
      const recoveryActions = recoveryUsageEvents.filter((event) => event.sourceId === recovery.id || event.sourceId === conversation?.id || messageIds.includes(event.sourceId));
      return { id: recovery.id, status: recovery.status, totalPrice: Number(recovery.totalPrice ?? 0), currency: recovery.currency ?? "GBP", detectedAt: recovery.detectedAt.toISOString(), customer: { id: recovery.customer?.id, firstName: recovery.customer?.firstName, lastName: recovery.customer?.lastName, email: recovery.customer?.email }, messageCount: conversation?.messages.length ?? 0, conversations: conversation ? [{ id: conversation.id, type: conversation.type, summary: conversation.summary }] : [], messages: conversation?.messages.map((message) => ({ id: message.id, direction: message.direction, senderType: message.senderType, status: message.status, content: message.content, createdAt: message.createdAt.toISOString() })) ?? [], billableActions: recoveryActions.map((event) => ({ id: event.id, metric: event.metric, quantity: Number(event.quantity), idempotencyKey: event.idempotencyKey, occurredAt: event.occurredAt.toISOString() })) };
    }),
    billingPeriods: billingPeriods.map((period) => ({ id: period.id, periodStart: period.periodStart.toISOString(), periodEnd: period.periodEnd.toISOString(), status: period.status, totalQuantity: period.usageEvents.reduce((total, event) => total + Number(event.quantity), 0), eventCount: period.usageEvents.length })),
    usagePagination: { view: usageView, billId: selectedPeriod?.id ?? null, periodStart: selectedPeriod?.periodStart.toISOString() ?? null, periodEnd: selectedPeriod?.periodEnd.toISOString() ?? null },
    usageSummary: { current: currentUsageEvents.map((event) => ({ metric: event.metric, quantity: Number(event.quantity) })), past: paidUsageEvents.map((event) => ({ metric: event.metric, quantity: Number(event.quantity) })) },
  };
};


export default function Index() {
  const {
    settings,
    stats,
    recoveries,
    billingPeriods,
    usageSummary,
    usageView,
    usagePagination,
  } = useLoaderData();
  const [searchParams] = useSearchParams();

  if (!settings?.onboardingCompleted) {
    return <Onboarding />;
  }

  if (searchParams.get("view") !== "detail") {
    return <UsageOverview usageSummary={usageSummary} billingPeriods={billingPeriods} />;
  }

  return <Dashboard stats={stats} recoveries={recoveries} usageView={usageView} usagePagination={usagePagination} />;
}


export const headers = (/** @type {import("react-router").HeadersArgs} */ headersArgs) => {
  return boundary.headers(headersArgs);
};