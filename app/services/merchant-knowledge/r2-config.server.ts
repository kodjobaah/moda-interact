import type { MerchantKnowledgeR2Configuration } from "../platform-configuration/contracts.server";

/** The six fields in a single immutable SHOPIFY-001 operation snapshot. */
export type MerchantKnowledgeR2Config = Readonly<Pick<
  MerchantKnowledgeR2Configuration,
  "endpoint" | "bucket" | "accessKeyId" | "secretAccessKey" |
  "maxUploadBytes" | "maxXlsxUncompressedBytes"
> & { region: "auto" }>;

/** The SHOPIFY-001 reader has already enforced the complete, sealed R2 contract. */
export function r2ClientConfigFromSnapshot(
  snapshot: MerchantKnowledgeR2Configuration,
): MerchantKnowledgeR2Config {
  return Object.freeze({
    endpoint: snapshot.endpoint,
    bucket: snapshot.bucket,
    accessKeyId: snapshot.accessKeyId,
    secretAccessKey: snapshot.secretAccessKey,
    maxUploadBytes: snapshot.maxUploadBytes,
    maxXlsxUncompressedBytes: snapshot.maxXlsxUncompressedBytes,
    region: "auto" as const,
  });
}
