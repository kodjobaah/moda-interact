import { describe, expect, it } from "vitest";
import { shopifyBrandReadGrant } from "../../../app/services/shopify-brand/shopify-brand-read-scope";

describe("Shopify brand read permission observation", () => {
  it.each([
    ["read_products,read_brand", "GRANTED"],
    ["read_products, read_brand ", "GRANTED"],
    [["read_products", "read_brand"], "GRANTED"],
    ["read_products,read_brand_extra", "MISSING"],
    ["read_products,read_branding", "MISSING"],
    ["read_products", "MISSING"],
    ["", "MISSING"],
    [null, "MISSING"],
    [undefined, "MISSING"],
  ] as const)("reports %j as %s", (scopes, expected) => {
    expect(shopifyBrandReadGrant(scopes)).toBe(expected);
  });
});
