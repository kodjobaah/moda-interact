import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { RecoveryCreditPurchaseStatus, SubscriptionProjectionStatus } from "@prisma/client";
import { useLoaderData, useRouteError } from "react-router";
import { boundary, type AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { getMerchantRequestContext } from "@/services/shop/merchant-request-context.server";
import {
  createShopifyBillingProviderError,
} from "@/services/billing/providers/shopify-billing-diagnostics.server";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import { recoveryCreditPurchaseManagementService } from "@/services/billing/recovery-credit-purchase-management.service";
import { merchantUiContext, createMerchantI18n } from "@/utils/merchant-i18n";
import RecoveryCreditPurchaseManager from "@/components/dashboard/RecoveryCreditPurchaseManager";
import Breadcrumbs from "@/components/dashboard/Breadcrumbs";
import {
  canAccessMerchantSurface,
  getMerchantDeniedRedirect,
  resolveMerchantExperienceState,
} from "@/services/shop/merchant-route-access-policy";


type AdminGraphQLError = { message?: string; extensions?: { code?: string }; code?: string };
type ShopifyShopPlanResponse = {
  data?: { shop?: { plan?: { partnerDevelopment?: boolean | null } | null } | null };
  errors?: AdminGraphQLError[];
};

async function resolveShopifyPartnerDevelopment(admin: AdminApiContext): Promise<boolean> {
  const operation = "verify_refund_development_store";
  let response: Response;
  try {
    response = await admin.graphql(
      `#graphql
        query ModaInteractRefundShopPlan {
          shop { plan { partnerDevelopment } }
        }
      `,
    );
  } catch (error) {
    const sdk = error as {
      body?: { errors?: { graphQLErrors?: AdminGraphQLError[] } };
      response?: { status?: number; headers?: Headers };
      headers?: Record<string, string>;
    } | null;
    throw createShopifyBillingProviderError({
      operation, failureKind: "GRAPHQL", origin: "sdk_exception",
      message: error instanceof Error ? error.message : String(error), cause: error,
      httpStatus: sdk?.response?.status,
      providerRequestId: sdk?.response?.headers?.get?.("x-request-id") ?? sdk?.headers?.["x-request-id"],
      providerErrors: Array.isArray(sdk?.body?.errors?.graphQLErrors) ? sdk.body.errors.graphQLErrors.filter(entry => entry && typeof entry === "object").map(entry => ({
        message: entry.message, code: entry.extensions?.code ?? entry.code,
      })) : undefined,
    });
  }
  let result: ShopifyShopPlanResponse;
  try {
    result = await response.json() as ShopifyShopPlanResponse;
  } catch (error) {
    throw createShopifyBillingProviderError({
      operation, failureKind: response.ok ? "MALFORMED_RESPONSE" : "HTTP",
      origin: response.ok ? "internal" : "provider_response",
      message: error instanceof Error ? error.message : String(error), cause: error,
      httpStatus: response.status, providerRequestId: response.headers.get("x-request-id"),
    });
  }
  const errors = Array.isArray(result?.errors)
    ? result.errors.filter(entry => entry && typeof entry === "object") : [];
  const malformedErrors = result?.errors !== undefined &&
    (!Array.isArray(result.errors) || errors.length !== result.errors.length);
  if (!response.ok || errors.length) {
    throw createShopifyBillingProviderError({
      operation, failureKind: response.ok ? "GRAPHQL" : "HTTP", origin: "provider_response",
      message: errors[0]?.message || response.statusText || "Shopify Admin verification failed.",
      httpStatus: response.status, providerRequestId: response.headers.get("x-request-id"),
      providerErrors: errors.map(entry => ({
        message: entry.message, code: entry.extensions?.code ?? entry.code,
      })),
    });
  }
  const value = result?.data?.shop?.plan?.partnerDevelopment;
  if (typeof value !== "boolean" || malformedErrors) {
    throw createShopifyBillingProviderError({
      operation, failureKind: "MALFORMED_RESPONSE", origin: "internal",
      message: "Unable to verify whether the authenticated Shopify shop is a partner development store.",
    });
  }
  return value;
}

const PURCHASE_HISTORY_FILTERS = [
  "ACTIVE",
  "WITHDRAWN",
  "COMPLETED",
  "REFUNDED",
  "ALL",
] as const;

const PURCHASE_HISTORY_PAGE_SIZES = [5, 10, 20] as const;
const DEFAULT_PURCHASE_HISTORY_PAGE_SIZE = 5;

function resolvePurchaseHistoryPageSize(value: string | null): number {
  const parsed = Number(value);
  return PURCHASE_HISTORY_PAGE_SIZES.includes(
    parsed as (typeof PURCHASE_HISTORY_PAGE_SIZES)[number],
  )
    ? parsed
    : DEFAULT_PURCHASE_HISTORY_PAGE_SIZE;
}

type PurchaseHistoryFilter = (typeof PURCHASE_HISTORY_FILTERS)[number];

const FILTER_TO_STATUS: Record<
  PurchaseHistoryFilter,
  RecoveryCreditPurchaseStatus | undefined
> = {
  ACTIVE: RecoveryCreditPurchaseStatus.ACTIVE,
  WITHDRAWN: RecoveryCreditPurchaseStatus.WITHDRAWN,
  COMPLETED: RecoveryCreditPurchaseStatus.COMPLETED,
  REFUNDED: RecoveryCreditPurchaseStatus.REFUNDED,
  ALL: undefined,
};

function resolvePurchaseHistoryFilter(
  value: string | null,
): PurchaseHistoryFilter {
  return PURCHASE_HISTORY_FILTERS.includes(value as PurchaseHistoryFilter)
    ? (value as PurchaseHistoryFilter)
    : "ACTIVE";
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const merchant = await getMerchantRequestContext({ request, context });
  const { shop, authentication: { admin, session } } = merchant;
  assertActiveShop(shop, {
    route: "/app/billing/recovery-credit-purchases",
    capability: "read-billing",
    redirectTo: "/app/merchant-support",
  });
  const scalarSubscription = await merchant.readSubscription();
  const subscription = scalarSubscription &&
    (scalarSubscription.status === SubscriptionProjectionStatus.ACTIVE ||
      scalarSubscription.status === SubscriptionProjectionStatus.TRIALING) ? scalarSubscription : null;
  const merchantExperienceState = resolveMerchantExperienceState({
    shop,
    subscription,
  });
  if (
    !canAccessMerchantSurface(
      merchantExperienceState,
      "BILLING_PURCHASE_HISTORY",
    )
  )
    throw new Response(null, {
      status: 302,
      headers: {
        Location: getMerchantDeniedRedirect(
          merchantExperienceState,
          "BILLING_PURCHASE_HISTORY",
        ),
      },
    });
  const shopifyPartnerDevelopment = await resolveShopifyPartnerDevelopment(admin);
  const url = new URL(request.url);
  const filter = resolvePurchaseHistoryFilter(url.searchParams.get("filter"));
  return {
    merchantUi: merchantUiContext(shop, session),
    filter,
    page: await recoveryCreditPurchaseManagementService.listPurchaseHistory({
      shopId: shop.id,
      shopifyShopId: shop.shopifyShopId ?? "",
      shopifyPartnerDevelopment,
      page: Number(url.searchParams.get("page") ?? "1"),
      pageSize: resolvePurchaseHistoryPageSize(url.searchParams.get("pageSize")),
      status: FILTER_TO_STATUS[filter],
    }),
  };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const merchant = await getMerchantRequestContext({ request, context });
  const { shop, authentication: { admin, session } } = merchant;
  assertActiveShop(shop, {
    route: "/app/billing/recovery-credit-purchases",
    capability: "manage-billing",
    redirectTo: "/app/merchant-support",
  });
  const scalarSubscription = await merchant.readSubscription();
  const subscription = scalarSubscription &&
    (scalarSubscription.status === SubscriptionProjectionStatus.ACTIVE ||
      scalarSubscription.status === SubscriptionProjectionStatus.TRIALING) ? scalarSubscription : null;
  const merchantExperienceState = resolveMerchantExperienceState({
    shop,
    subscription,
  });
  if (
    !canAccessMerchantSurface(
      merchantExperienceState,
      "BILLING_PURCHASE_HISTORY",
    )
  )
    throw new Response(null, {
      status: 302,
      headers: {
        Location: getMerchantDeniedRedirect(
          merchantExperienceState,
          "BILLING_PURCHASE_HISTORY",
        ),
      },
    });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  if (intent === "reactivate") {
    const purchaseId = String(formData.get("purchaseId") ?? "").trim();
    if (!purchaseId)
      return Response.json(
        { error: "purchaseId is required." },
        { status: 400 },
      );
    return Response.json(
      await recoveryCreditPurchaseManagementService.reactivateRefund({
        shopId: shop.id,
        purchaseId,
      }),
    );
  }
  const requestId = String(formData.get("requestId") ?? "").trim();
  const purchaseIds = [...new Set(formData
    .getAll("purchaseId")
    .map(String)
    .map((id) => id.trim())
    .filter(Boolean))];
  if (
    intent !== "request_refund" ||
    !requestId ||
    purchaseIds.length < 1 ||
    purchaseIds.length > 20
  ) {
    return Response.json(
      { error: "A bounded refund request is required." },
      { status: 400 },
    );
  }
  const shopifyPartnerDevelopment =
    await resolveShopifyPartnerDevelopment(admin);
  return Response.json(
    await recoveryCreditPurchaseManagementService.requestRefundBatch({
      shopId: shop.id,
      shopifyShopId: shop.shopifyShopId ?? "",
      shopifyPartnerDevelopment,
      purchaseIds,
      requestId,
      shopifyUserId:
        session.onlineAccessInfo?.associated_user?.id?.toString() ?? null,
    }),
  );
}

export default function RecoveryCreditPurchasesRoute() {
  const data = useLoaderData<typeof loader>();
  const i18n = createMerchantI18n(data.merchantUi);
  return (
    <s-page heading={i18n.t("billingPurchases.title")}>
      <Breadcrumbs
        items={[
          {
            label: i18n.t("billingCommerce.page.title"),
            href: "/app/billing/options",
          },
        ]}
        current={i18n.t("billingPurchases.title")}
        merchantUi={data.merchantUi}
      />
      <RecoveryCreditPurchaseManager
        merchantUi={data.merchantUi}
        page={data.page}
        filter={data.filter}
      />
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
