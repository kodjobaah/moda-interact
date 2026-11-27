import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Static declaration checks; installation grants and live deployment need smoke evidence. */
describe("retired Shopify-native WhatsApp consent subscription", () => {
  const namedAppToml = readFileSync(
    new URL("../../../shopify.app.moda-interact.toml", import.meta.url),
    "utf8",
  );

  it("does not subscribe to the retired native consent webhook", () => {
    expect(namedAppToml).toMatch(/\[webhooks\]\s*api_version\s*=\s*"2026-07"/);
    expect(namedAppToml).not.toContain(
      '"customers_whats_app_marketing_consent/update"',
    );
    for (const topic of [
      '"orders/create"',
      '"checkouts/update"',
      '"carts/create"',
      '"carts/update"',
    ]) {
      expect(namedAppToml).toContain(topic);
    }
    for (const privacyTopic of [
      '"customers/data_request"',
      '"customers/redact"',
      '"shop/redact"',
    ]) {
      expect(namedAppToml).toContain(privacyTopic);
    }
  });

  it("requests read_customers, not a Shopify customer mutation scope", () => {
    expect(namedAppToml).toMatch(/scopes\s*=\s*"[^"\n]*read_customers[^"\n]*"/);
    expect(namedAppToml).not.toContain("write_customers");
  });
});
