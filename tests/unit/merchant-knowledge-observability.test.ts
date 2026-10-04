import { afterEach, expect, it, vi } from "vitest";
import { recordMerchantKnowledgeUploadFailure } from "../../app/services/merchant-knowledge/merchant-knowledge-observability.server";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  vi.restoreAllMocks();
});

it("emits PII-safe Merchant Knowledge upload failures through the shared structured logger", () => {
  process.env.NODE_ENV = "test";
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  recordMerchantKnowledgeUploadFailure({
    stage: "storage_put",
    shopId: "shop-1",
    assetId: "asset-1",
    purposeKey: "PRODUCT_INFORMATION",
    dataFormatKey: "XLSX",
    sizeBytes: 4096,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    statusCode: 403,
    errorCode: "STORAGE_HTTP_403",
    error: new Error("must-not-leak-signed-url-or-provider-message"),
  });

  const record = errorSpy.mock.calls
    .flat()
    .map((line) => {
      try {
        return JSON.parse(String(line));
      } catch {
        return null;
      }
    })
    .find((candidate) => candidate?.event === "merchant_knowledge.upload.failed");

  expect(record).toMatchObject({
    level: "error",
    event: "merchant_knowledge.upload.failed",
    "service.namespace": "moda-interact",
    "service.name": "moda-interact",
    data: {
      stage: "storage_put",
      shopId: "shop-1",
      assetId: "asset-1",
      purposeKey: "PRODUCT_INFORMATION",
      dataFormatKey: "XLSX",
      sizeBytes: 4096,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      statusCode: 403,
      errorCode: "STORAGE_HTTP_403",
      errorType: "Error",
    },
  });
  const raw = JSON.stringify(record);
  expect(raw).not.toContain("uploadUrl");
  expect(raw).not.toContain("originalFileName");
  expect(raw).not.toContain("sourceName");
  expect(raw).not.toContain("must-not-leak-signed-url-or-provider-message");
});
