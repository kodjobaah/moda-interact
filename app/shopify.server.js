import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  LogSeverity,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { createDefaultShopifyPlatformConfigurationService } from "./services/platform-configuration/composition.server";

// React Router's Node ESM server import waits for top-level await before any
// route module can receive the synchronous Shopify authentication exports.
// A missing, revoked or undecryptable OAuth record rejects module evaluation
// and fails closed before the HTTP server can accept authenticated requests.
const oauth = await createDefaultShopifyPlatformConfigurationService()
  .requireShopifyOAuthCredentials();

const shopify = shopifyApp({
  apiKey: oauth.apiKey,
  apiSecretKey: oauth.apiSecret,
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  logger: {
    level: LogSeverity.Debug,
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
// Stable, non-secret Shopify application identity for tenant-scoped dedupe keys.
export const apiKey = oauth.apiKey;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
