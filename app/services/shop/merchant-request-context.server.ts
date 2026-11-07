import {
  createContext,
  RouterContextProvider,
  type MiddlewareFunction,
} from "react-router";
import type { Shop, Subscription, ShopSettings } from "@prisma/client";

import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { shopService, recordMerchantResolutionFailure } from "./shop.service";

type Authentication = Awaited<ReturnType<typeof authenticate.admin>>;
export type MerchantRequestContext = {
  authentication: Authentication;
  shop: Shop;
  readSubscription(): Promise<Subscription | null>;
  readSettings(): Promise<ShopSettings | null>;
};

const authenticationKey = createContext<Promise<Authentication> | null>(null);
const merchantKey = createContext<Promise<MerchantRequestContext> | null>(null);

function authenticateRequest(request: Request, context: Readonly<RouterContextProvider>) {
  let promise = context.get(authenticationKey);
  if (!promise) {
    promise = authenticate.admin(request);
    context.set(authenticationKey, promise);
  }
  return promise;
}

async function resolveContext(
  request: Request,
  context: Readonly<RouterContextProvider>,
  refresh: boolean,
): Promise<MerchantRequestContext> {
  const authentication = await authenticateRequest(request, context);
  const { admin, session } = authentication;
  let snapshot: ReturnType<typeof shopService.resolveShopifyMerchantSnapshot> | undefined;
  const repair = () => snapshot ??= shopService.resolveShopifyMerchantSnapshot({
    admin, sessionShop: session.shop,
  });
  const seed = refresh ? await repair() : undefined;
  const shop = seed?.shop ?? await shopService.getByDomain(session.shop) ?? (await repair()).shop;
  let subscription = seed ? Promise.resolve(seed.subscription) : undefined;
  let settings = seed ? Promise.resolve(seed.settings) : undefined;
  // A repair triggered by a missing Shop also seeds subsequent lazy reads.
  if (snapshot && !seed) {
    const repaired = await snapshot;
    subscription = Promise.resolve(repaired.subscription);
    settings = Promise.resolve(repaired.settings);
  }

  return {
    authentication,
    shop,
    readSubscription() {
      return subscription ??= snapshot ? snapshot.then(row => row.subscription) : prisma.subscription.findUnique({ where: { shopId: shop.id } })
        .catch(error => {
          recordMerchantResolutionFailure("read_subscription", "database", error, {shopId: shop.id});
          throw error;
        }).then(async row => row ?? (await repair()).subscription);
    },
    readSettings() {
      return settings ??= snapshot ? snapshot.then(row => row.settings) : prisma.shopSettings.findUnique({ where: { shopId: shop.id } })
        .catch(error => {
          recordMerchantResolutionFailure("read_settings", "database", error, {shopId: shop.id});
          throw error;
        }).then(async row => row ?? (await repair()).settings);
    },
  };
}

export function getMerchantRequestContext({
  request,
  context,
}: { request: Request; context: Readonly<RouterContextProvider> }): Promise<MerchantRequestContext> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return resolveContext(request, context, false);
  }
  let promise = context.get(merchantKey);
  if (!promise) {
    promise = resolveContext(request, context, false);
    context.set(merchantKey, promise);
  }
  return promise;
}

export const merchantPageContextMiddleware: MiddlewareFunction = async (
  { request, context }, next,
) => {
  if (request.method === "GET" || request.method === "HEAD") {
    // Install before awaiting: matched loaders share both success and rejection.
    const promise = resolveContext(request, context, true);
    context.set(merchantKey, promise);
    await promise;
  }
  return next();
};
