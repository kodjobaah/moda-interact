import { recordShopifyBootstrapFailure, recordShopifySdkDiagnostic } from "./services/observability/shopify-runtime-observability.server";
import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  LogSeverity,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { setAbstractFetchFunc } from "@shopify/shopify-api/runtime";
import { createDefaultShopifyPlatformConfigurationService } from "./services/platform-configuration/composition.server";
import { shopifyOfflineCoordination } from "./services/shopify-offline-coordination.server";
import { getShopifySessionBinding } from "./services/shopify-session-storage.server";

// React Router's Node ESM server import waits for top-level await before any
// route module can receive the synchronous Shopify authentication exports.
// A missing, revoked or undecryptable OAuth record rejects module evaluation
// and fails closed before the HTTP server can accept authenticated requests.
/** @type {import("./services/platform-configuration/contracts.server").ShopifyOAuthCredentials | undefined} */
let oauth = undefined;
/** @type {ReturnType<typeof shopifyApp>} */
let shopify;
/** @type {"oauth_configuration" | "sdk_construction"} */
let bootstrapStage = "oauth_configuration";
try {
  oauth = await createDefaultShopifyPlatformConfigurationService().requireShopifyOAuthCredentials();
  bootstrapStage = "sdk_construction";
  const credentials = oauth;
  setAbstractFetchFunc(shopifyOfflineCoordination.fetch);
  shopify = shopifyApp({
  apiKey: oauth.apiKey,
  apiSecretKey: oauth.apiSecret,
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: shopifyOfflineCoordination.sessionStorage,
  distribution: AppDistribution.AppStore,
  logger: {
    level: LogSeverity.Debug,
    httpRequests: false,
    log: (severity, message) => recordShopifySdkDiagnostic({
      severity,
      message,
      sensitiveValues: [credentials.apiKey, credentials.apiSecret],
      redactEntireMessage: Boolean(getShopifySessionBinding()),
    }),
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
  });
} catch (error) {
  recordShopifyBootstrapFailure({error, stage: bootstrapStage, sensitiveValues: oauth ? [oauth.apiKey, oauth.apiSecret] : []});
  throw error;
}

const coordinatedAuthenticate = Object.freeze({
  ...shopify.authenticate,
  admin: authenticateAdmin,
  webhook: authenticateWebhook,
});
const coordinatedUnauthenticated = Object.freeze({
  ...shopify.unauthenticated,
  admin: unauthenticatedAdmin,
});
const shopifyFacade = Object.freeze({
  ...shopify,
  authenticate: coordinatedAuthenticate,
  unauthenticated: coordinatedUnauthenticated,
  sessionStorage: shopifyOfflineCoordination.sessionStorage,
});

/** @param {Request} request */
function authenticateAdmin(request) {
  return shopifyOfflineCoordination.withAdminAuthentication(
    request,
    () => shopify.authenticate.admin(request),
  );
}
/** @param {Request} request */
function authenticateWebhook(request) {
  return shopifyOfflineCoordination.withWebhookAuthentication(
    request,
    () => shopify.authenticate.webhook(request),
  );
}
/** @param {string} integrationDomain */
function unauthenticatedAdmin(integrationDomain) {
  return shopifyOfflineCoordination.withUnauthenticatedAdmin(
    integrationDomain,
    () => shopify.unauthenticated.admin(integrationDomain),
  );
}

export default shopifyFacade;
export const apiVersion = ApiVersion.July26;
// Stable, non-secret Shopify application identity for tenant-scoped dedupe keys.
export const apiKey = oauth.apiKey;
export const addDocumentResponseHeaders = shopifyFacade.addDocumentResponseHeaders;
export const authenticate = shopifyFacade.authenticate;
export const unauthenticated = shopifyFacade.unauthenticated;
export const login = shopifyFacade.login;
export const registerWebhooks = shopifyFacade.registerWebhooks;
export const sessionStorage = shopifyFacade.sessionStorage;
