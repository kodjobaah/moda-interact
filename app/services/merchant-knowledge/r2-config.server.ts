export interface MerchantKnowledgeR2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  maxUploadBytes: number;
  region: "auto";
}

export class MerchantKnowledgeR2ConfigurationError extends Error {
  constructor() {
    super("MERCHANT_KNOWLEDGE_R2_CONFIGURATION_INVALID");
    this.name = "MerchantKnowledgeR2ConfigurationError";
  }
}

export function loadMerchantKnowledgeR2Config(
  environment: NodeJS.ProcessEnv = process.env,
): MerchantKnowledgeR2Config {
  const endpointValue = environment.MERCHANT_KNOWLEDGE_R2_ENDPOINT?.trim();
  const bucket = environment.MERCHANT_KNOWLEDGE_R2_BUCKET?.trim();
  const accessKeyId = environment.MERCHANT_KNOWLEDGE_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = environment.MERCHANT_KNOWLEDGE_R2_SECRET_ACCESS_KEY?.trim();
  const maxUploadBytesValue = environment.MERCHANT_KNOWLEDGE_MAX_UPLOAD_BYTES?.trim();

  if (!endpointValue || !bucket || !accessKeyId || !secretAccessKey || !maxUploadBytesValue) {
    throw new MerchantKnowledgeR2ConfigurationError();
  }

  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new MerchantKnowledgeR2ConfigurationError();
  }

  if (
    endpoint.protocol !== "https:" ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password ||
    !/^\d+$/.test(maxUploadBytesValue)
  ) {
    throw new MerchantKnowledgeR2ConfigurationError();
  }

  const maxUploadBytes = Number(maxUploadBytesValue);
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) {
    throw new MerchantKnowledgeR2ConfigurationError();
  }

  return {
    endpoint: endpoint.toString(),
    bucket,
    accessKeyId,
    secretAccessKey,
    maxUploadBytes,
    region: "auto",
  };
}