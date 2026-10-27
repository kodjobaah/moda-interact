import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const configurations = [
  {
    filename: "shopify.app.toml",
    priorScopes: ["write_products", "write_metaobjects", "write_metaobject_definitions"],
  },
  {
    filename: "shopify.app.moda-interact.toml",
    priorScopes: [
      "read_customers", "read_discounts", "read_locales",
      "read_markets", "read_orders", "read_products",
    ],
  },
] as const;

function config(filename: string): string {
  return readFileSync(new URL(`../../../${filename}`, import.meta.url), "utf8");
}

function requiredScopes(toml: string): string[] {
  const section = toml.split("[access_scopes]")[1]?.split(/^\s*\[/m)[0];
  const value = section?.match(/^\s*scopes\s*=\s*"([^"]+)"/m)?.[1];
  if (!value) throw new Error("Missing required Shopify access scopes declaration");
  return value.split(",").map((scope) => scope.trim());
}

describe("ARCH-049 Shopify brand-read app configuration", () => {
  it.each(configurations)("preserves existing scopes and adds read_brand once in $filename", ({ filename, priorScopes }) => {
    const scopes = requiredScopes(config(filename));
    expect(scopes).toEqual(expect.arrayContaining([...priorScopes]));
    expect(scopes.filter((scope) => scope === "read_brand")).toHaveLength(1);
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it.each(configurations)("registers an app/scopes_update webhook in $filename", ({ filename }) => {
    const toml = config(filename);
    const registered = toml.match(/\[\[webhooks\.subscriptions\]\]\s*uri\s*=\s*"\/webhooks\/app\/scopes_update"\s*topics\s*=\s*\[\s*"app\/scopes_update"\s*\]/g);
    expect(registered).toHaveLength(1);
  });
});
