import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const configPath = new URL("../../../shopify.app.moda-interact.toml", import.meta.url);
const templatePath = new URL("../../../shopify.app.toml", import.meta.url);
const packagePath = new URL("../../../package.json", import.meta.url);

function subscriptions(source: string) {
  return source.split("[[webhooks.subscriptions]]").slice(1).map((section) => {
    const uri = section.match(/^\s*uri\s*=\s*"([^"]+)"/m)?.[1];
    const topics = [...section.matchAll(/"([a-z_]+(?:\/[a-z_]+)?)"/g)]
      .map((match) => match[1])
      .filter((value) => !value.startsWith("/"));
    return { uri, topics };
  });
}

describe("intended Shopify app configuration", () => {
  it("retains named app identity and maps the exact supported topics to their routes", async () => {
    const source = await readFile(configPath, "utf8");
    expect(source).toContain('client_id = "c323c5bd8585d875719db7570b91460e"');
    expect(source).toContain('application_url = "https://app-test.modainteract.com"');
    expect(source).toContain('api_version = "2026-07"');
    expect(source).toContain("read_customers");
    expect(source).toContain("read_discounts");
    expect(source).toContain("read_brand");
    expect(subscriptions(source)).toEqual([
      { uri: "/webhooks", topics: [
        "orders/create", "carts/create", "carts/update", "checkouts/create",
        "checkouts/update", "customers_whats_app_marketing_consent/update",
        "discounts/create", "discounts/update", "discounts/delete",
        "discounts/redeemcode_added", "discounts/redeemcode_removed",
      ] },
      { uri: "/webhooks/customers/data_request", topics: ["customers/data_request"] },
      { uri: "/webhooks/customers/redact", topics: ["customers/redact"] },
      { uri: "/webhooks/shop/redact", topics: ["shop/redact"] },
      { uri: "/webhooks/app/scopes_update", topics: ["app/scopes_update"] },
      { uri: "/webhooks/app/uninstalled", topics: ["app/uninstalled"] },
    ]);
  });

  it("keeps the template identity separate and selects moda-interact in app commands", async () => {
    const [named, template, packageSource] = await Promise.all([
      readFile(configPath, "utf8"), readFile(templatePath, "utf8"), readFile(packagePath, "utf8"),
    ]);
    expect(named).not.toContain('client_id = "ca78b7deba6ed1da8a15997bbe905242"');
    expect(template).toContain('client_id = "ca78b7deba6ed1da8a15997bbe905242"');
    expect(template).toContain("Separate template app configuration");
    const packageJson = JSON.parse(packageSource);
    expect(packageJson.scripts.dev).toContain("--config moda-interact");
    expect(packageJson.scripts.deploy).toContain("--config moda-interact");
    for (const path of ["../../../scripts/shopify.mjs", "../../../scripts/shopify-dev.mjs", "../../../scripts/shopify-dev-cloud.mjs"]) {
      const source = await readFile(new URL(path, import.meta.url), "utf8");
      expect(source).toContain('"--config"');
      expect(source).toContain('"moda-interact"');
    }
  });
});