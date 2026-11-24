import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const extension = "../../../extensions/moda-whatsapp-consent/";
const read = path => readFileSync(new URL(`${extension}${path}`, import.meta.url), "utf8");

describe("WhatsApp consent theme extension performance", () => {
  it("loads the drawer's shared consent controller without blocking the parser", () => {
    const liquid = read("blocks/cart-drawer-consent.liquid");
    expect(liquid).toContain('<script src="{{ \'cart-consent.js\' | asset_url }}" defer></script>');
    expect(liquid).not.toContain("| script_tag");
    expect(liquid).toContain('"javascript": "cart-drawer-consent.js"');
    expect(read("blocks/cart-consent.liquid")).toContain('"javascript": "cart-consent.js"');
  });

  it("keeps the shared cart consent asset within Shopify's 10,000-byte limit", () => {
    const asset = readFileSync(new URL(`${extension}assets/cart-consent.js`, import.meta.url));
    expect(asset.byteLength).toBeLessThanOrEqual(10_000);
  });
});
