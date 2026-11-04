import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { describe, expect, it, vi } from "vitest";

import {
  classifyBillingVerificationFailure,
  createShopifyBillingProviderError,
  logBillingBoundaryFailure,
  ShopifyBillingProviderError,
} from "../../../../app/services/billing/providers/shopify-billing-diagnostics.server";

describe("Shopify billing provider diagnostics", () => {
  it("emits bounded safe original evidence through the Shared JSON logger", () => {
    const records: string[] = [];
    const diagnosticLogger = createLogger({
      serviceName: "moda-interact",
      environment: "test",
      sink: (record) => records.push(JSON.stringify(record)),
    });
    const cause = new Error("request token=secret-token-123 failed for merchant@example.com");
    const error = createShopifyBillingProviderError({
      operation: "get_active_subscription",
      failureKind: "GRAPHQL",
      origin: "provider_response",
      message: "Partner marker token=secret-token-123 returned error",
      cause,
      httpStatus: 200,
      providerRequestId: "request-123",
      providerErrorExcerpt: "Partner marker password=secret-pass; email=merchant@example.com",
      providerErrors: Array.from({ length: 6 }, (_, index) => ({
        code: index === 0 ? "ACCESS_DENIED" : `CODE_${index}`,
        message: index === 0 ? "Partner marker token=secret-token-123" : `marker-${index}`,
        details: index === 0 ? "email=merchant@example.com" : undefined,
      })),
      sensitiveValues: ["secret-token-123"],
    }, diagnosticLogger);

    const output = records.join("\n");
    expect(error.sourceDiagnosticEmitted).toBe(true);
    expect(error.cause).toBe(cause);
    expect(output).toContain("Partner marker token=[REDACTED] returned error");
    expect(error.message).toBe("Partner marker token=[REDACTED] returned error");
    expect(output).toContain("ACCESS_DENIED");
    expect(output).toContain("request-123");
    expect(output).toContain("providerErrorExcerpt");
    expect(output).toContain('"redactionApplied":true');
    expect(output).toContain('"truncated":true');
    expect(output).not.toContain("secret-token-123");
    expect(output).not.toContain("merchant@example.com");
    expect(output).not.toContain("CODE_5");
  });

  it("retains failure behavior when the Shared sink throws", () => {
    const sink = vi.fn(() => {
      throw new Error("sink unavailable");
    });
    const diagnosticLogger = createLogger({
      serviceName: "moda-interact",
      environment: "test",
      sink,
    });

    const error = createShopifyBillingProviderError({
      operation: "get_active_subscription",
      failureKind: "TRANSPORT",
      origin: "transport",
      message: "socket marker",
    }, diagnosticLogger);

    expect(sink).toHaveBeenCalledTimes(1);
    expect(error.message).toBe("socket marker");
    expect(error.failureKind).toBe("TRANSPORT");
    expect(error.sourceDiagnosticEmitted).toBe(true);
  });

  it("classifies only typed provider responses and transports as Partner failures", () => {
    const occurredAt = new Date("2026-11-04T00:00:00.000Z");
    const providerError = new ShopifyBillingProviderError({
      operation: "get_active_subscription",
      failureKind: "MALFORMED_RESPONSE",
      origin: "provider_response",
      message: "Malformed field",
    });
    const configurationError = new ShopifyBillingProviderError({
      operation: "get_active_subscription",
      failureKind: "CONFIGURATION",
      origin: "database",
      message: "Credential read failed",
    });

    expect(classifyBillingVerificationFailure(providerError, occurredAt)).toEqual({
      code: "PARTNER_API_ERROR",
      occurredAt,
    });
    expect(classifyBillingVerificationFailure(configurationError, occurredAt)).toEqual({
      code: "SUBSCRIPTION_SYNC_FAILED",
      occurredAt,
    });
    expect(classifyBillingVerificationFailure(new Error("local projection failure"), occurredAt)).toEqual({
      code: "SUBSCRIPTION_SYNC_FAILED",
      occurredAt,
    });
  });

  it("logs sanitized local failures once with causes and Prisma codes", () => {
    const records: string[] = [];
    const diagnosticLogger = createLogger({
      serviceName: "moda-interact",
      environment: "test",
      sink: (record) => records.push(JSON.stringify(record)),
    });
    const cause = new Error("password=secret-pass for merchant@example.com");
    const error = Object.assign(new Error("write failed password=secret-pass", { cause }), { code: "P2025" });
    const input = {
      event: "billing.test.failed",
      operation: "test_write",
      stage: "transaction",
      shopId: "shop-1",
      error,
    };

    logBillingBoundaryFailure(input, diagnosticLogger);
    logBillingBoundaryFailure(input, diagnosticLogger);

    const output = records.join("\n");
    expect(records).toHaveLength(1);
    expect(output).toContain("P2025");
    expect(output).toContain("causeChain");
    expect(output).toContain('"redactionApplied":true');
    expect(output).not.toContain("secret-pass");
    expect(output).not.toContain("merchant@example.com");
  });
});