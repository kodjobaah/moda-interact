import { describe, expect, it } from "vitest";
import { projectRecoveryBasket } from "../../app/services/recoveries/recovery-basket";

const saved = { productId: "product", variantId: "variant", title: "Product", variantTitle: "Blue / Large",
  sku: null, quantity: 2, price: "12.34" };

describe("ARCH-040 Shopify saved checkout basket", () => {
  it("uses the exact persisted line-item fields and separately labels the saved total", () => {
    const projected = projectRecoveryBasket([saved], "GBP", "124.99");
    expect(projected).toEqual({
      items: [{ title: "Product", variant: "Blue / Large", quantity: 2,
        unitPrice: "12.34", imageUrl: null }],
      currency: "GBP", recoveryTotal: "124.99", unavailableReason: null,
    });
    expect(JSON.stringify(projected)).not.toContain("productId");
    expect(JSON.stringify(projected)).not.toContain("sku");
  });
  it("does not manufacture unit prices from total or infer missing quantities", () => {
    const projected = projectRecoveryBasket([{ title: "A", quantity: null, price: null }], "GBP", "200.00");
    expect(projected.items[0]).toEqual({ title: "A", variant: null, quantity: null, unitPrice: null, imageUrl: null });
    expect(projected.unavailableReason).toBe("partial");
  });
  it("distinguishes malformed, absent, empty and partially invalid snapshots", () => {
    expect(projectRecoveryBasket(null, null, null).unavailableReason).toBe("missing");
    expect(projectRecoveryBasket({ unexpected: "object" }, "GBP", "1.00").unavailableReason).toBe("invalid");
    expect(projectRecoveryBasket([], "GBP", null).unavailableReason).toBeNull();
    expect(projectRecoveryBasket([null, saved], "GBP", null).unavailableReason).toBe("partial");
  });
  it("never accepts credential-bearing or unsafe image URLs", () => {
    expect(projectRecoveryBasket([{ ...saved, imageUrl: "https://user:pass@host.example/file" }], "GBP", null).items[0].imageUrl).toBeNull();
    expect(projectRecoveryBasket([{ ...saved, imageUrl: "javascript:alert(1)" }], "GBP", null).items[0].imageUrl).toBeNull();
  });
  it("does not perform binary floating-point line-total multiplication", () => {
    expect(projectRecoveryBasket([{ ...saved, quantity: 3, price: "0.10" }], "GBP", "0.30").items[0].unitPrice).toBe("0.10");
  });
});
