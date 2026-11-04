import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { knowledgeFailureRetryable } from "./merchant-knowledge-error.server";
import { recordMerchantKnowledgeFailure } from "./merchant-knowledge-observability.server";
import type { MerchantKnowledgeR2Config } from "./r2-config.server";

export interface MerchantKnowledgeR2ObjectMetadata {
  contentLength: number | undefined;
  contentType: string | undefined;
}

export interface MerchantKnowledgeR2Client {
  signPut(input: { bucket: string; key: string; contentType: string; ifNoneMatch: "*"; expiresIn: number }): Promise<string>;
  headObject(input: { bucket: string; key: string }): Promise<MerchantKnowledgeR2ObjectMetadata>;
}

export function createMerchantKnowledgeR2Client(config: MerchantKnowledgeR2Config, shopId: string): MerchantKnowledgeR2Client {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  function failed(operation: string, key: string, error: unknown): never {
    const source = error as {code?: string; name?: string; $metadata?: {httpStatusCode?: number; requestId?: string}};
    const metadata = source?.$metadata;
    recordMerchantKnowledgeFailure({shopId, operation, error,
      ...(error instanceof SyntaxError ? {diagnosticError: new SyntaxError("R2 response parsing failed."), redactionApplied: true} : {}),
      origin: error instanceof SyntaxError ? "internal" : metadata?.httpStatusCode ? "provider_response" : knowledgeFailureRetryable(error) ? "transport" : "sdk_exception",
      sensitiveValues: [config.accessKeyId, config.secretAccessKey, config.bucket, config.endpoint, key],
      providerMetadata: {provider: "r2", ...(metadata?.httpStatusCode ? {httpStatus: metadata.httpStatusCode} : {}),
        ...(metadata?.requestId && /^[A-Za-z0-9_.:-]{1,128}$/.test(metadata.requestId) ? {providerRequestId: metadata.requestId} : {}),
        ...(source?.code && /^[A-Za-z0-9_]{1,64}$/.test(source.code) ? {providerCode: source.code} : {})},
    });
    throw error;
  }
  return {
    async signPut({ bucket, key, contentType, ifNoneMatch, expiresIn }) {
      try { return await getSignedUrl(client, new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        IfNoneMatch: ifNoneMatch,
      }), { expiresIn }); } catch (error) { return failed("r2_sign_put", key, error); }
    },
    async headObject({ bucket, key }) {
      try { const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { contentLength: result.ContentLength, contentType: result.ContentType };
      } catch (error) { return failed("r2_head", key, error); }
    },
  };
}