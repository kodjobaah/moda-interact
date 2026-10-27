import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@modainteract/moda-interact-shared/logging", () => ({
  createLogger: vi.fn(() => sharedLogger),
}));

import {
  recordMerchantSupportReadFailure,
  recordMerchantSupportSendFailure,
  recordMerchantSupportTranslationDispatchFailure,
} from "../../app/services/merchant-support/merchant-support-observability.server";

describe("merchant Support shared observability", () => {
  beforeEach(() => vi.clearAllMocks());

  it("logs bounded Support read failures with validated tenant and the original error", () => {
    const error = new Error("Database unavailable");
    recordMerchantSupportReadFailure("shop-123", error);
    expect(sharedLogger.error).toHaveBeenCalledWith("merchant.support.recovery_action.read.failed", {
      shopId: "shop-123",
      operation: "read_support_messages",
      errorCategory: "database_read_failed",
      error,
    });
  });

  it("omits invalid shop identifiers and logs best-effort failures through Shared", () => {
    const error = new Error("Queue unavailable");
    recordMerchantSupportReadFailure("invalid shop/id", error);
    expect(sharedLogger.error).toHaveBeenCalledWith("merchant.support.recovery_action.read.failed", {
      operation: "read_support_messages",
      errorCategory: "database_read_failed",
      error,
    });

    recordMerchantSupportSendFailure("shop-123", error);
    expect(sharedLogger.error).toHaveBeenLastCalledWith("merchant.support.message.send.failed", {
      shopId: "shop-123",
      operation: "compose_message",
      errorCategory: "send_failed",
      error,
    });

    recordMerchantSupportTranslationDispatchFailure("translation-123", error);
    expect(sharedLogger.warn).toHaveBeenCalledWith("merchant.support.translation.dispatch.failed", {
      translationId: "translation-123",
      errorCategory: "queue_dispatch_failed",
      error,
    });
  });
});
