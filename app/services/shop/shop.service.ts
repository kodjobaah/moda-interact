import { GraphqlQueryError, HttpRequestError, HttpResponseError } from "@shopify/shopify-api";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { z } from "zod";
import { resolveDeploymentEnvironmentName } from "../otel/otel.runtime";
import type {
  AdminApiContext,
} from "@shopify/shopify-app-react-router/server";

import type {
  Prisma,
  PrismaClient,
  Shop,
  Subscription,
  ShopSettings,
} from "@prisma/client";
import {
  canonicaliseLanguageTag,
  normalizeCountryCode,
  normalizeTimeZone,
} from "@modainteract/moda-interact-shared/internationalization";

import prisma from "../../db.server";
import {
  lockShopLifecycleRow,
  markDiscountCatalogueUnavailable,
} from "../discounts/shopify-discount-lifecycle.service";
import { recordShopifyLifecycleFailure } from "../webhooks/shopify-webhook-observability.server";


export interface ResolveShopifyShopInput {
  admin: AdminApiContext;
  domain: string;
}

export type ReinstallSchedule = {
  shopId: string;
  subscriptionId: string;
  reinstallPendingAt: Date;
  expectedNextReconcileAt: Date;
};

export type ReinstallAdmissionResult =
  | { kind: "SCHEDULED"; schedule: ReinstallSchedule }
  | { kind: "AUTHENTICATION_REQUIRED" }
  | { kind: "NO_CHANGE" };


const profileSchema = z.object({
  data: z.object({
    shop: z.object({
      shopifyShopId: z.string().regex(/^gid:\/\/shopify\/Shop\/[1-9][0-9]*$/),
      myshopifyDomain: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i),
      ianaTimezone: z.string().nullish(),
      shopAddress: z.object({countryCodeV2: z.string().nullish()}).nullish(),
    }),
    shopLocales: z.array(z.object({
      locale: z.string().nullish(), primary: z.boolean().nullish(), published: z.boolean().nullish(),
    })).nullish(),
  }),
});
const providerErrorsSchema = z.object({
  errors: z.array(z.object({
    message: z.string(),
    extensions: z.object({code: z.string().optional()}).optional(),
  })).min(1),
});
const merchantLogger = createLogger({
  serviceName: "moda-interact", environment: resolveDeploymentEnvironmentName(),
});

// Only profile-boundary error text is extracted; never emit GraphQL data or bodies.
function safeProfileErrorText(text: string): string {
  return text
    .replace(/(?:https?|postgres(?:ql)?|redis):\/\/[^\s"'<>]+/gi, "[REDACTED]")
    .replace(/(?:Bearer\s+|(?:token|access[_-]?token|authorization|cookie|password|email|phone|address|name|card)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]")
    .replace(/\+?\d[\d ()-]{8,}\d/g, "[REDACTED]");
}

export function recordMerchantResolutionFailure(
  operation: string, origin: "database" | "transport" | "sdk_exception" | "internal" | "provider_response",
  error: unknown,
  source?: {retrying?: boolean; shopId?: string; httpStatus?: number; providerRequestId?: string; providerError?: unknown; redactionApplied?: boolean; truncated?: boolean},
): void {
  const original = error instanceof Error ? error : new Error(String(error));
  const causes: Error[] = [];
  let cause = original.cause;
  for (let index = 0; index < 4 && cause instanceof Error; index++) {
    causes.push(cause);
    cause = cause.cause;
  }
  const texts = [original, ...causes];
  const redactionApplied = source?.redactionApplied || texts.some(item => safeProfileErrorText(item.message) !== item.message);
  const safeError = (item: Error) => ({
    name: safeProfileErrorText(item.name), message: safeProfileErrorText(item.message).slice(0, 2048),
  });
  const fields = {
    operation, origin,
    ...(source?.shopId ? {shopId: source.shopId} : {}),
    ...(origin === "provider_response" || origin === "transport" || origin === "sdk_exception" ? {provider: "shopify"} : {}),
    error: safeError(original),
    causeChain: causes.map(safeError),
    ...(origin === "database" && "code" in original && typeof original.code === "string" ? {databaseCode: safeProfileErrorText(original.code)} : {}),
    ...(source?.httpStatus !== undefined ? {httpStatus: source.httpStatus} : {}),
    ...(source?.providerRequestId ? {providerRequestId: safeProfileErrorText(source.providerRequestId)} : {}),
    ...(source?.providerError ? {providerError: source.providerError} : {}),
    redactionApplied,
    truncated: source?.truncated || texts.some(item => item.message.length > 2048),
  };
  if (source?.retrying) merchantLogger.warn("shopify.merchant.bootstrap.retry", fields);
  else merchantLogger.error("shopify.merchant.resolve.failed", fields);
}

class MerchantProfileFailure extends Error {
  constructor(cause: unknown) { super("Merchant profile resolution failed", {cause}); }
}

export class ShopService {
  constructor(private readonly database: PrismaClient = prisma) {}

  private async hasUsableOfflineSession(
    transaction: Prisma.TransactionClient,
    shopDomain: string,
    now: Date,
  ): Promise<boolean> {
    const session = await transaction.session.findFirst({
      where: { shop: shopDomain, isOnline: false },
      select: { accessToken: true, expires: true, refreshToken: true },
      orderBy: { expires: "desc" },
    });
    if (!session?.accessToken?.trim()) return false;
    return session.expires === null || session.expires > now || Boolean(session.refreshToken?.trim());
  }

  async resolveShopifyShop(input: ResolveShopifyShopInput): Promise<Shop> {
    return (await this.resolveShopifyMerchantSnapshot(input)).shop;
  }

  async resolveShopifyMerchantSnapshot(input: ResolveShopifyShopInput): Promise<{shop: Shop; subscription: Subscription; settings: ShopSettings}> {
    try {
      return await this.resolveMerchantSnapshot(input);
    } catch (error) {
      // Profile/parse failures are owned at their source below; DB work starts only afterwards.
      if (!(error instanceof MerchantProfileFailure) && !(error instanceof Response)) {
        recordMerchantResolutionFailure("resolve_local_snapshot", "database", error);
      }
      throw error instanceof MerchantProfileFailure ? error.cause : error;
    }
  }

  private async resolveMerchantSnapshot({
    admin,
    domain,
  }: ResolveShopifyShopInput): Promise<{shop: Shop; subscription: Subscription; settings: ShopSettings}> {
    let origin: "transport" | "internal" | "provider_response" = "transport";
    let response: Response | undefined;
    let result: z.infer<typeof profileSchema>;
    try {
      response = await admin.graphql(
      `#graphql
        query ResolveModaInteractShop {
          shop {
            shopifyShopId: id
            myshopifyDomain
            ianaTimezone
            shopAddress {
              countryCodeV2
            }
          }
          shopLocales {
            locale
            primary
            published
          }
        }
      `,
    );

      origin = "internal";
      const body: unknown = await response.json();
      const providerErrors = providerErrorsSchema.safeParse(body);
      if (providerErrors.success) {
        origin = "provider_response";
        const messages = providerErrors.data.errors.map(entry => ({
          message: safeProfileErrorText(entry.message).slice(0, 2048),
          ...(entry.extensions?.code ? {code: safeProfileErrorText(entry.extensions.code)} : {}),
        }));
        const error = new Error(providerErrors.data.errors.map(entry => entry.message).join("; "));
        recordMerchantResolutionFailure("observe_profile", origin, error, {
          httpStatus: response.status,
          providerRequestId: response.headers.get("x-request-id") ?? undefined,
          providerError: messages,
        });
        throw new MerchantProfileFailure(error);
      }
      if (body && typeof body === "object" && "errors" in body &&
        (!Array.isArray(body.errors) || body.errors.length > 0)) {
        throw new Error("Malformed Shopify GraphQL error response");
      }
      const parsed = profileSchema.safeParse(body);
      if (!parsed.success) throw new Error("Malformed Shopify merchant profile identity");
      result = parsed.data;
      if (normalizeShopDomain(result.data.shop.myshopifyDomain) !== normalizeShopDomain(domain)) {
        throw new Error("Shop domain mismatch in authenticated merchant profile");
      }
    } catch (error) {
      if (error instanceof MerchantProfileFailure) throw error;
      if (error instanceof Response) throw error;
      if (error instanceof HttpResponseError) {
        const upstreamMessage = typeof error.response.body?.errors === "string" ? error.response.body.errors : undefined;
        const requestId = error.response.headers?.["x-request-id"];
        recordMerchantResolutionFailure("observe_profile", "provider_response", error, {
          httpStatus: error.response.code,
          ...(typeof requestId === "string" ? {providerRequestId: requestId} : {}),
          ...(upstreamMessage ? {
            providerError: {message: safeProfileErrorText(upstreamMessage).slice(0, 2048)},
            redactionApplied: safeProfileErrorText(upstreamMessage) !== upstreamMessage,
            truncated: upstreamMessage.length > 2048,
          } : {}),
        });
        throw new MerchantProfileFailure(error);
      }
      if (error instanceof GraphqlQueryError) {
        const errors = providerErrorsSchema.safeParse({errors: error.body?.errors?.graphQLErrors});
        const requestId = error.headers?.["x-request-id"];
        recordMerchantResolutionFailure("observe_profile", "provider_response", error, {
          ...(typeof error.response.status === "number" ? {httpStatus: error.response.status} : {}),
          ...(typeof requestId === "string" ? {providerRequestId: requestId} : {}),
          ...(errors.success ? {
            redactionApplied: errors.data.errors.some(entry => safeProfileErrorText(entry.message) !== entry.message),
            truncated: errors.data.errors.some(entry => entry.message.length > 2048),
            providerError: errors.data.errors.map(entry => ({
            message: safeProfileErrorText(entry.message).slice(0, 2048),
            ...(entry.extensions?.code ? {code: safeProfileErrorText(entry.extensions.code)} : {}),
          }))} : {}),
        });
        throw new MerchantProfileFailure(error);
      }
      recordMerchantResolutionFailure("observe_profile",
        origin === "transport" && !(error instanceof HttpRequestError)
          ? "sdk_exception" : origin, error, response ? {
        httpStatus: response.status,
        providerRequestId: response.headers.get("x-request-id") ?? undefined,
      } : undefined);
      throw new MerchantProfileFailure(error);
    }
    const shopifyGraphqlShop = result.data.shop;
    const shopDomain = normalizeShopDomain(shopifyGraphqlShop.myshopifyDomain);
    const shopifyShopId = shopifyGraphqlShop.shopifyShopId;
    const primaryLocale =
      result.data?.shopLocales?.find(
        (shopLocale) => shopLocale.primary === true,
      )?.locale;
    const storeLocale = normalizeStoreLocale(primaryLocale);
    const defaultLanguageTag = normalizeOptional(
      primaryLocale,
      canonicaliseLanguageTag,
    );
    const defaultTimeZone = normalizeOptional(
      shopifyGraphqlShop.ianaTimezone,
      normalizeTimeZone,
    );
    const defaultCountryCode = normalizeOptional(
      shopifyGraphqlShop.shopAddress?.countryCodeV2,
      normalizeCountryCode,
    );
    const updateContext = {
      ...(storeLocale ? { storeLocale } : {}),
      ...(defaultLanguageTag ? { defaultLanguageTag } : {}),
      ...(defaultTimeZone ? { defaultTimeZone } : {}),
      ...(defaultCountryCode ? { defaultCountryCode } : {}),
    };
    const settingsUpdateContext = {
      ...(defaultLanguageTag ? { defaultLanguageTag } : {}),
      ...(defaultTimeZone ? { defaultTimeZone } : {}),
      ...(defaultCountryCode ? { defaultCountryCode } : {}),
    };

    const existingShop = await prisma.shop.findUnique({
      where: { domain: shopDomain },
    });
    if (existingShop && (
      (existingShop.shopifyShopId && existingShop.shopifyShopId !== shopifyShopId) ||
      existingShop.platform !== "SHOPIFY"
    )) {
      const error = new Error("Authenticated merchant profile conflicts with local tenant identity");
      recordMerchantResolutionFailure("verify_local_identity", "internal", error);
      throw new MerchantProfileFailure(error);
    }
    const [existingSubscription, existingSettings] = existingShop
      ? await Promise.all([
          prisma.subscription.findUnique({
            where: { shopId: existingShop.id },
          }),
          prisma.shopSettings.findUnique({
            where: { shopId: existingShop.id },
          }),
        ])
      : [null, null];
    const shopNeedsRefresh = existingShop !== null && (
      existingShop.shopifyShopId !== shopifyShopId ||
      (storeLocale !== null && existingShop.storeLocale !== storeLocale) ||
      (defaultLanguageTag !== null && existingShop.defaultLanguageTag !== defaultLanguageTag) ||
      (defaultTimeZone !== null && existingShop.defaultTimeZone !== defaultTimeZone) ||
      (defaultCountryCode !== null && existingShop.defaultCountryCode !== defaultCountryCode)
    );
    const settingsNeedsRefresh = existingSettings !== null && (
      (defaultLanguageTag !== null && existingSettings.defaultLanguageTag !== defaultLanguageTag) ||
      (defaultTimeZone !== null && existingSettings.defaultTimeZone !== defaultTimeZone) ||
      (defaultCountryCode !== null && existingSettings.defaultCountryCode !== defaultCountryCode)
    );

    if (existingShop && existingSubscription && existingSettings) {
      if (!shopNeedsRefresh && !settingsNeedsRefresh) {
        return {shop: existingShop, subscription: existingSubscription, settings: existingSettings};
      }

      return prisma.$transaction(async (transaction) => {
        const shop = shopNeedsRefresh
          ? await transaction.shop.update({
              where: { id: existingShop.id },
              data: {
                shopifyShopId,
                ...updateContext,
              },
            })
          : existingShop;

        const settings = settingsNeedsRefresh
          ? await transaction.shopSettings.update({
            where: { shopId: existingShop.id },
            data: settingsUpdateContext,
          })
          : existingSettings;

        return {shop, subscription: existingSubscription, settings};
      });
    }

    const bootstrap = () => prisma.$transaction(async (transaction) => {
      const shop = await transaction.shop.upsert({
        where: { domain: shopDomain },
        create: {
          domain: shopDomain,
          shopifyShopId,
          status: "ACTIVE",
          storeLocale,
          defaultLanguageTag,
          defaultTimeZone,
          defaultCountryCode,
        },
        update: {
          shopifyShopId,
          ...updateContext,
        },
      });

      const subscription = existingSubscription ?? await transaction.subscription.upsert({
          where: { shopId: shop.id },
          create: {
            shopId: shop.id,
            status: "NO_CONTRACT",
            planId: null,
            observedShopifyPlanHandle: null,
            billingPeriodId: null,
            currentPeriodStart: null,
            currentPeriodEnd: null,
            trialEndsAt: null,
            cancelAtPeriodEnd: false,
            providerSubscriptionId: null,
            pendingShopifyPlanHandle: null,
            pendingPlanId: null,
            pendingEffectiveAt: null,
          },
          update: {},
        });

      const settings = !existingSettings
        ? await transaction.shopSettings.upsert({
          where: { shopId: shop.id },
          create: {
            shopId: shop.id,
            defaultLanguageTag,
            defaultTimeZone,
            defaultCountryCode,
          },
          update: settingsUpdateContext,
        })
        : settingsNeedsRefresh ? await transaction.shopSettings.update({
          where: { shopId: shop.id },
          data: settingsUpdateContext,
        }) : existingSettings;

      return {shop, subscription, settings};
    });
    try {
      return await bootstrap();
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "P2002") throw error;
      // Multiple unique indexes can race before ON CONFLICT(domain) resolves.
      // Retry once only after the committed winner proves the exact same tenant.
      const winner = await prisma.shop.findUnique({where: {domain: shopDomain}});
      if (!winner || winner.platform !== "SHOPIFY" || winner.shopifyShopId !== shopifyShopId) throw error;
      recordMerchantResolutionFailure("bootstrap_unique_race", "database", error, {shopId: winner.id, retrying: true});
      return bootstrap();
    }

  }


  async getById(
    shopId: string,
  ): Promise<Shop | null> {
    return prisma.shop.findUnique({
      where: {
        id: shopId,
      },
    });
  }


  async getByDomain(
    domain: string,
  ): Promise<Shop | null> {
    try {
      return await prisma.shop.findUnique({where: {domain: normalizeShopDomain(domain)}});
    } catch (error) {
      recordMerchantResolutionFailure("lookup_local_shop", "database", error);
      throw error;
    }
  }


  async beginReinstallReconciliation(
    shopId: string,
    now = new Date(),
  ): Promise<ReinstallAdmissionResult> {
    try {
      return await this.database.$transaction<ReinstallAdmissionResult>(async (transaction: Prisma.TransactionClient) => {
      await lockShopLifecycleRow(transaction, shopId);
      const shop = await transaction.shop.findUnique({
        where: { id: shopId },
        select: { domain: true, status: true, reinstallPendingAt: true },
      });
      if (!shop || shop.status !== "UNINSTALLED") return { kind: "NO_CHANGE" };
      if (!(await this.hasUsableOfflineSession(transaction, shop.domain, now))) {
        return { kind: "AUTHENTICATION_REQUIRED" };
      }

      const existingSubscription = await transaction.subscription.findUnique({
        where: { shopId },
        select: { id: true, nextReconcileAt: true },
      });

      if (shop.reinstallPendingAt) {
        if (!existingSubscription?.nextReconcileAt) return { kind: "NO_CHANGE" };

        return {
          kind: "SCHEDULED",
          schedule: {
            shopId,
            subscriptionId: existingSubscription.id,
            reinstallPendingAt: shop.reinstallPendingAt,
            expectedNextReconcileAt: existingSubscription.nextReconcileAt,
          },
        };
      }

      const reinstallPendingAt = now;
      const markerWrite = await transaction.shop.updateMany({
          where: {
            id: shopId,
            status: "UNINSTALLED",
            reinstallPendingAt: null,
          },
          data: { reinstallPendingAt },
      });

      if (markerWrite.count !== 1) {
        const durableShop = await transaction.shop.findUnique({
          where: { id: shopId },
          select: { status: true, reinstallPendingAt: true },
        });
        const durableSubscription = await transaction.subscription.findUnique({
          where: { shopId },
          select: { id: true, nextReconcileAt: true },
        });

        if (
          durableShop?.status !== "UNINSTALLED" ||
          !durableShop.reinstallPendingAt ||
          !durableSubscription?.nextReconcileAt
        ) {
          return { kind: "NO_CHANGE" };
        }

        return {
          kind: "SCHEDULED",
          schedule: {
            shopId,
            subscriptionId: durableSubscription.id,
            reinstallPendingAt: durableShop.reinstallPendingAt,
            expectedNextReconcileAt: durableSubscription.nextReconcileAt,
          },
        };
      }

      const subscription = await transaction.subscription.upsert({
        where: { shopId },
        update: { nextReconcileAt: now },
        create: {
          shopId,
          status: "NO_CONTRACT",
          planId: null,
          observedShopifyPlanHandle: null,
          nextReconcileAt: now,
        },
        select: { id: true, nextReconcileAt: true },
      });

      if (!subscription.nextReconcileAt) {
        throw new Error("Reinstall reconciliation schedule was not persisted.");
      }

      return {
        kind: "SCHEDULED",
        schedule: {
          shopId,
          subscriptionId: subscription.id,
          reinstallPendingAt,
          expectedNextReconcileAt: subscription.nextReconcileAt,
        },
      };
      });
    } catch (error) {
      recordShopifyLifecycleFailure({
        operation: "begin_reinstall_reconciliation",
        stage: "transaction",
        origin: "database",
        shopId,
        error,
      });
      throw error;
    }
  }

  async retryReinstallReconciliation(
    shopId: string,
    now = new Date(),
  ): Promise<ReinstallAdmissionResult> {
    try {
      return await this.database.$transaction<ReinstallAdmissionResult>(async (transaction: Prisma.TransactionClient) => {
      await lockShopLifecycleRow(transaction, shopId);
      const shop = await transaction.shop.findUnique({
        where: { id: shopId },
        select: { domain: true, status: true, reinstallPendingAt: true },
      });
      if (!shop || shop.status !== "UNINSTALLED" || !shop.reinstallPendingAt) {
        return { kind: "NO_CHANGE" };
      }
      if (!(await this.hasUsableOfflineSession(transaction, shop.domain, now))) {
        return { kind: "AUTHENTICATION_REQUIRED" };
      }

      const subscription = await transaction.subscription.findUnique({
        where: { shopId },
        select: { id: true, nextReconcileAt: true },
      });
      if (subscription?.nextReconcileAt) return { kind: "NO_CHANGE" };

      const markerWrite = await transaction.shop.updateMany({
        where: {
          id: shopId,
          status: "UNINSTALLED",
          reinstallPendingAt: shop.reinstallPendingAt,
        },
        data: { reinstallPendingAt: now },
      });
      if (markerWrite.count !== 1) return { kind: "NO_CHANGE" };

      const updatedSubscription = await transaction.subscription.upsert({
        where: { shopId },
        update: { nextReconcileAt: now },
        create: {
          shopId,
          status: "NO_CONTRACT",
          planId: null,
          observedShopifyPlanHandle: null,
          nextReconcileAt: now,
        },
        select: { id: true, nextReconcileAt: true },
      });

      if (!updatedSubscription.nextReconcileAt) {
        throw new Error("Reinstall retry schedule was not persisted.");
      }

      return {
        kind: "SCHEDULED",
        schedule: {
          shopId,
          subscriptionId: updatedSubscription.id,
          reinstallPendingAt: now,
          expectedNextReconcileAt: updatedSubscription.nextReconcileAt,
        },
      };
      });
    } catch (error) {
      recordShopifyLifecycleFailure({
        operation: "retry_reinstall_reconciliation",
        stage: "transaction",
        origin: "database",
        shopId,
        error,
      });
      throw error;
    }
  }

  async getReinstallSubscription(shopId: string) {
    return prisma.subscription.findUnique({
      where: { shopId },
      select: { nextReconcileAt: true },
    });
  }


  async markUninstalled(
    domain: string,
    uninstalledAt: Date,
  ): Promise<ShopifyUninstallResult> {
    const normalizedDomain = normalizeShopDomain(domain);

    return this.database.$transaction<ShopifyUninstallResult>(async (transaction: Prisma.TransactionClient) => {
      const shopIdentity = await transaction.shop.findUnique({
        where: { domain: normalizedDomain },
        select: { id: true },
      });

      if (!shopIdentity) {
        return { kind: "SHOP_NOT_FOUND" };
      }

      await lockShopLifecycleRow(transaction, shopIdentity.id);
      const shop = await transaction.shop.findUnique({
        where: { id: shopIdentity.id },
        select: { id: true, uninstalledAt: true },
      });
      if (!shop) return { kind: "SHOP_NOT_FOUND" };

      let firstUninstalledAt = shop.uninstalledAt;
      let deletedSessionCount: number | null = null;
      if (!firstUninstalledAt) {
        const transition = await transaction.shop.updateMany({
          where: {
            id: shop.id,
            uninstalledAt: null,
          },
          data: {
            status: "UNINSTALLED",
            uninstalledAt,
            reinstallPendingAt: null,
          },
        });

        if (transition.count === 1) {
          firstUninstalledAt = uninstalledAt;
          const deletion = await transaction.session.deleteMany({
            where: { shop: normalizedDomain },
          });
          deletedSessionCount = deletion.count;
        } else {
          const durableShop = await transaction.shop.findUnique({
            where: { id: shop.id },
            select: { uninstalledAt: true },
          });
          firstUninstalledAt = durableShop?.uninstalledAt ?? null;
          if (!firstUninstalledAt) {
            throw new Error("Uninstall transition lost its guarded update without a persisted timestamp.");
          }
        }
      }

      await markDiscountCatalogueUnavailable(
        transaction,
        shop.id,
        firstUninstalledAt,
      );

      return deletedSessionCount === null
        ? { kind: "ALREADY_UNINSTALLED", shopId: shop.id }
        : { kind: "UNINSTALLED", shopId: shop.id, deletedSessionCount };
    });
  }
}

export type ShopifyUninstallResult =
  | { kind: "SHOP_NOT_FOUND" }
  | { kind: "UNINSTALLED"; shopId: string; deletedSessionCount: number }
  | { kind: "ALREADY_UNINSTALLED"; shopId: string };


function normalizeShopDomain(
  domain: string,
): string {
  return domain
    .trim()
    .toLowerCase();
}


function normalizeOptional(
  value: string | null | undefined,
  normalize: (value: string) => string,
): string | null {
  if (!value) {
    return null;
  }

  try {
    return normalize(value);
  } catch {
    return null;
  }
}

function normalizeStoreLocale(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const locale = value.trim();
  if (!locale || locale.length > 128) return null;
  try {
    new Intl.Locale(locale);
    return locale;
  } catch {
    return null;
  }
}


export const shopService =
  new ShopService();