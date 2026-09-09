import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(
  new URL("../../../app/routes.ts", import.meta.url),
  "utf8",
);

describe("explicit route configuration", () => {
  it("does not use filesystem-inferred flatRoutes", () => {
    expect(source).not.toContain("@react-router/fs-routes");
    expect(source).not.toContain("flatRoutes(");
  });

  it("keeps embedded UI pages under the app layout", () => {
    expect(source).toContain('route("app", "./routes/app/route.jsx", [');
    expect(source).toContain('route("billing", "./routes/app/billing/route.tsx"),');
    expect(source).toContain('route("merchant-support", "./routes/app/merchant-support/route.jsx"),');
  });

  it("keeps billing transitions standalone", () => {
    expect(source).toContain('route("app/billing/select", "./routes/app/billing/select/route.jsx"),');
    expect(source).toContain('route("app/billing/callback", "./routes/app/billing/callback/route.tsx"),');
  });

  it("keeps pending recoveries standalone", () => {
    expect(source).toContain('route("app/pending-recoveries", "./routes/app/pending-recoveries/route.jsx"),');
  });

  it("preserves Shopify webhook URLs exactly", () => {
    for (const pathname of [
      "webhooks",
      "webhooks/app/scopes_update",
      "webhooks/app/uninstalled",
      "webhooks/customers/data_request",
      "webhooks/customers/redact",
      "webhooks/shop/redact",
    ]) {
      expect(source).toContain('"' + pathname + '"');
    }
  });

  it("does not retain retired flat route modules", async () => {
    for (const relativePath of [
      "app/routes/app._index.jsx",
      "app/routes/app.billing.tsx",
      "app/routes/app.billing.callback.tsx",
      "app/routes/app.billing.select.jsx",
      "app/routes/app.merchant-support.jsx",
      "app/routes/app.pending-recoveries.jsx",
      "app/routes/app.usage.jsx",
    ]) {
      await expect(access(new URL(`../../../${relativePath}`, import.meta.url))).rejects.toThrow();
    }
  });
});
