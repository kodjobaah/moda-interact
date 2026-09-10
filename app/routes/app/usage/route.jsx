import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import Breadcrumbs from "@/components/dashboard/Breadcrumbs";
import UsageEvents from "@/components/dashboard/UsageEvents";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { authenticate } from "@/shopify.server";
import db from "@/db.server";
import { createMerchantI18n, merchantUiContext } from "@/utils/merchant-i18n";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const requestedPageSize = Number(url.searchParams.get("pageSize"));
  const pageSize = [10, 25, 50, 100].includes(requestedPageSize) ? requestedPageSize : 10;
  const requestedPage = Number(url.searchParams.get("page"));
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const usageView = url.searchParams.get("bill") === "past" ? "past" : "current";
  const requestedBillId = url.searchParams.get("billId");
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/usage", redirectTo: "/app/merchant-support" });
  const settings = await db.shopSettings.findUnique({ where: { shopId: shop.id } });

  if (!settings?.onboardingCompleted) {
    return { settings: null, merchantUi: merchantUiContext(null, session), usageEvents: [], usagePagination: { page: 1, pageSize, total: 0, totalQuantity: 0 }, billingPeriods: [], usageView };
  }

  const usageWhere = { shopId: shop.id, reportedAt: usageView === "past" ? { not: null } : null };
  const billingPeriods = await db.billingPeriod.findMany({ where: { shopId: shop.id }, include: { usageEvents: { select: { metric: true, quantity: true } } }, orderBy: { periodStart: "desc" } });
  const selectedPeriod = billingPeriods.find((period) => period.id === requestedBillId) ?? billingPeriods.find((period) => usageView === "past" ? period.status === "CLOSED" : period.status === "OPEN");
  const selectedUsageWhere = selectedPeriod ? { shopId: shop.id, billingPeriodId: selectedPeriod.id } : usageWhere;
  const recoveries = await db.checkoutRecovery.findMany({ where: { shopId: shop.id }, include: { customer: { select: { firstName: true, lastName: true, email: true } }, conversation: { include: { messages: { select: { id: true } } } } } });
  const recoveryBySourceId = new Map();
  for (const recovery of recoveries) {
    const conversation = recovery.conversation;
    const customerName = [recovery.customer?.firstName, recovery.customer?.lastName].filter(Boolean).join(" ") || recovery.customer?.email || "Guest";
    recoveryBySourceId.set(recovery.id, { recoveryId: recovery.id, customerName });
    if (conversation) {
      recoveryBySourceId.set(conversation.id, { recoveryId: recovery.id, customerName });
      for (const message of conversation.messages) recoveryBySourceId.set(message.id, { recoveryId: recovery.id, customerName });
    }
  }

  const [usageEvents, usageCount, usageAggregate] = await Promise.all([
    db.usageEvent.findMany({ where: selectedUsageWhere, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
    db.usageEvent.count({ where: selectedUsageWhere }),
    db.usageEvent.aggregate({ where: selectedUsageWhere, _sum: { quantity: true } }),
  ]);

  return {
    settings,
    merchantUi: merchantUiContext(settings, session),
    usageEvents: usageEvents.map((event) => ({ id: event.id, metric: event.metric, quantity: Number(event.quantity), idempotencyKey: event.idempotencyKey, sourceType: event.sourceType, sourceId: event.sourceId, sourceRecovery: event.sourceId ? recoveryBySourceId.get(event.sourceId) ?? null : null, occurredAt: event.occurredAt.toISOString() })),
    usagePagination: { page, pageSize, total: usageCount, totalQuantity: Number(usageAggregate._sum.quantity ?? 0), view: usageView, billId: selectedPeriod?.id ?? null, periodStart: selectedPeriod?.periodStart.toISOString() ?? null, periodEnd: selectedPeriod?.periodEnd.toISOString() ?? null },
    billingPeriods: billingPeriods.map((period) => ({ id: period.id, periodStart: period.periodStart.toISOString(), periodEnd: period.periodEnd.toISOString(), status: period.status, totalQuantity: period.usageEvents.reduce((total, event) => total + Number(event.quantity), 0), eventCount: period.usageEvents.length })),
    usageView,
  };
};

export default function UsagePage() {
  const { settings, merchantUi, usageEvents, usagePagination, usageView, billingPeriods } = useLoaderData();
  const dashboardUrl = `/app?view=detail&bill=${usageView}${usagePagination.billId ? `&billId=${usagePagination.billId}` : ""}`;

  if (!settings) return null;

  const i18n = createMerchantI18n(merchantUi);
  const periodLabel = usagePagination.periodStart && usagePagination.periodEnd
    ? `${i18n.formatDate(usagePagination.periodStart)} - ${i18n.formatDate(usagePagination.periodEnd)}`
    : i18n.t("dashboard.billingPeriod");

  return (
    
    <s-page heading={i18n.t("usage.billable")}>
      <Breadcrumbs current={i18n.t("usage.billable")} parent={periodLabel} parentHref={dashboardUrl} merchantUi={merchantUi} />
      <UsageEvents usageEvents={usageEvents} usagePagination={usagePagination} usageView={usageView} billingPeriods={billingPeriods} merchantUi={merchantUi} />
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);