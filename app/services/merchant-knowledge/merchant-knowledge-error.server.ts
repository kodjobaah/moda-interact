export class MerchantKnowledgeError extends Error {
  readonly retryable?: boolean;
  constructor(readonly code: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(code, options); this.name = "MerchantKnowledgeError"; this.retryable = options?.retryable;
  }
}
/** Only positive evidence of availability/transport failures is retryable. */
export function knowledgeFailureRetryable(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const value = current as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
    const status = value.$metadata?.httpStatusCode;
    if (status !== undefined) return status === 429 || status >= 500;
    if (["P1001", "P1002", "P1008", "P1017", "P2024", "P2034", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(value.code ?? "") ||
      ["TimeoutError", "RequestTimeout", "NetworkingError"].includes(value.name ?? "")) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
