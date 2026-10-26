/** ARCH-043 Shopify-owned, server-only contracts. Never serialize returned secrets. */
export type ShopifyConfigurationKey = "merchant.knowledge.r2" | "shopify.oauth" | "shopify.partner" | "messaging.sender";
export type ShopifyConfigurationErrorCode =
  | "INVALID_ENVIRONMENT" | "DATABASE_UNAVAILABLE" | "MISSING" | "DISABLED"
  | "INVALID_ROW" | "INVALID_ENVELOPE" | "UNSEAL_FAILED" | "INVALID_VALUE";

export class ShopifyPlatformConfigurationError extends Error {
  constructor(readonly key: ShopifyConfigurationKey, readonly code: ShopifyConfigurationErrorCode) {
    super(`Shopify platform configuration ${key}: ${code}`);
    this.name = "ShopifyPlatformConfigurationError";
  }
}

export function configurationFailure(key: ShopifyConfigurationKey, code: ShopifyConfigurationErrorCode): never {
  throw new ShopifyPlatformConfigurationError(key, code);
}

export type MerchantKnowledgeR2Configuration = Readonly<{
  version: number;
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  maxUploadBytes: number;
  maxXlsxUncompressedBytes: number;
}>;

export type ShopifyOAuthCredentials = Readonly<{ version: number; apiKey: string; apiSecret: string }>;
export type ShopifyPartnerCredentials = Readonly<{
  version: number;
  accessToken: string;
  organizationId: string;
  appId: string;
  apiVersion?: string;
}>;

export interface ShopifyPlatformConfigurationService {
  requireMerchantKnowledgeR2Configuration(): Promise<MerchantKnowledgeR2Configuration>;
  requireShopifyOAuthCredentials(): Promise<ShopifyOAuthCredentials>;
  requireShopifyPartnerCredentials(): Promise<ShopifyPartnerCredentials>;
}
