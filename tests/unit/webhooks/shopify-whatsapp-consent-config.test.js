import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Static declaration checks; installation grants and live deployment need smoke evidence. */
describe("ARCH-045 Shopify consent subscription declaration", () => {
  const namedAppToml = readFileSync(new URL("../../../shopify.app.moda-interact.toml", import.meta.url), "utf8");

  it("adds WhatsApp consent to the existing /webhooks subscription on API 2026-07", () => {
    expect(namedAppToml).toMatch(/\[webhooks\]\s*api_version\s*=\s*"2026-07"/);
    expect(namedAppToml).toMatch(/uri\s*=\s*"\/webhooks"\s*topics\s*=\s*\[[^\]]*"customers_whats_app_marketing_consent\/update"/s);
    expect(namedAppToml).toContain('"orders/create"');
    expect(namedAppToml).toContain('"checkouts/update"');
  });

  it("requests read_customers, not a Shopify customer mutation scope", () => {
    expect(namedAppToml).toMatch(/scopes\s*=\s*"[^"\n]*read_customers[^"\n]*"/);
    expect(namedAppToml).not.toContain("write_customers");
  });
});
