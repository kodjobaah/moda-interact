import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { MerchantKnowledgeR2Config } from "./r2-config.server";

export interface MerchantKnowledgeR2ObjectMetadata {
  contentLength: number | undefined;
  contentType: string | undefined;
}

export interface MerchantKnowledgeR2Client {
  signPut(input: { bucket: string; key: string; contentType: string; ifNoneMatch: "*"; expiresIn: number }): Promise<string>;
  headObject(input: { bucket: string; key: string }): Promise<MerchantKnowledgeR2ObjectMetadata>;
}

export function createMerchantKnowledgeR2Client(config: MerchantKnowledgeR2Config): MerchantKnowledgeR2Client {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async signPut({ bucket, key, contentType, ifNoneMatch, expiresIn }) {
      return getSignedUrl(client, new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        IfNoneMatch: ifNoneMatch,
      }), { expiresIn });
    },
    async headObject({ bucket, key }) {
      const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { contentLength: result.ContentLength, contentType: result.ContentType };
    },
  };
}