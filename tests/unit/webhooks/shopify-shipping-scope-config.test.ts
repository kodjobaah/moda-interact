import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const configurations = [
  {
    filename: "shopify.app.moda-interact.toml",
    clientId: "c323c5bd8585d875719db7570b91460e",
    applicationUrl: "https://app-test.modainteract.com",
    redirectUrl: "https://app-test.modainteract.com",
    webhookApiVersion: "2026-07",
    priorScopes: [
      "read_customers", "read_discounts", "read_locales", "read_markets",
      "read_orders", "read_products", "read_brand",
    ],
  },
  {
    filename: "shopify.app.toml",
    clientId: "ca78b7deba6ed1da8a15997bbe905242",
    applicationUrl: "https://moda-interact.onrender.com",
    redirectUrl: "https://moda-interact.onrender.com/auth/callback",
    webhookApiVersion: "2026-10",
    priorScopes: [
      "write_products", "write_metaobjects", "write_metaobject_definitions", "read_brand",
    ],
  },
] as const;

function source(filename: string): string {
  return readFileSync(new URL(`../../../${filename}`, import.meta.url), "utf8");
}

function section(toml: string, name: string): string {
  const value = toml.split(`[${name}]`)[1]?.split(/^\s*\[/m)[0];
  if (!value) throw new Error(`Missing Shopify configuration section ${name}`);
  return value;
}

function requiredScopes(toml: string): string[] {
  const declaration = section(toml, "access_scopes").match(/^scopes\s*=\s*"([^"]+)"/m)?.[1];
  if (!declaration) throw new Error("Missing required Shopify scopes");
  return declaration.split(",").map((scope) => scope.trim());
}

describe("Shopify shipping-policy read permission", () => {
  it.each(configurations)("appends the required scope once in $filename", ({ filename, priorScopes }) => {
    const toml = source(filename);
    const scopes = requiredScopes(toml);
    expect(scopes).toEqual([...priorScopes, "read_legal_policies"]);
    expect(scopes.filter((scope) => scope === "read_legal_policies")).toHaveLength(1);
    expect(new Set(scopes).size).toBe(scopes.length);
    expect(section(toml, "access_scopes")).not.toMatch(/optional_scopes\s*=\s*\[[^\]]*"read_legal_policies"/);
  });

  it.each(configurations)("preserves app identity and webhook version in $filename", ({
    filename, clientId, applicationUrl, redirectUrl, webhookApiVersion,
  }) => {
    const toml = source(filename);
    expect(toml).toContain(`client_id = "${clientId}"`);
    expect(toml).toContain(`application_url = "${applicationUrl}"`);
    expect(toml).toContain("embedded = true");
    expect(section(toml, "auth")).toContain(`redirect_urls = [ "${redirectUrl}" ]`);
    expect(section(toml, "webhooks")).toContain(`api_version = "${webhookApiVersion}"`);
  });

  it.each(configurations)("keeps the existing authenticated scope-update subscription in $filename", ({ filename }) => {
    const subscriptions = source(filename).split("[[webhooks.subscriptions]]").slice(1);
    const scopeUpdates = subscriptions.filter((subscription) =>
      /topics\s*=\s*\[\s*"app\/scopes_update"\s*\]/.test(subscription));
    expect(scopeUpdates).toHaveLength(1);
    expect(scopeUpdates[0]).toContain('uri = "/webhooks/app/scopes_update"');
  });

  it("retains the two independent app identities", () => {
    expect(configurations[0].clientId).not.toBe(configurations[1].clientId);
    expect(configurations[0].webhookApiVersion).not.toBe(configurations[1].webhookApiVersion);
    expect(source("shopify.app.moda-interact.toml")).toContain("use_legacy_install_flow = false");
    expect(source("shopify.app.toml")).toContain("include_config_on_deploy = true");
  });
});
