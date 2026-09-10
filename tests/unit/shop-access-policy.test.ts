import { describe, expect, it } from "vitest";

import {
  assertActiveShop,
  assertSupportShop,
} from "../../app/services/shop/shop-access-policy";

describe("shop access policy", () => {
  it("allows active shops", () => {
    expect(() => assertActiveShop({ status: "ACTIVE" }, { route: "/app", redirectTo: "/app/merchant-support" })).not.toThrow();
  });

  it.each(["SUSPENDED", "UNINSTALLED"] as const)(
    "rejects %s shops with a forbidden response",
    (status) => {
      try {
        assertActiveShop({ status }, { route: "/app/usage", redirectTo: "/app/merchant-support" });
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect(error.headers.get("Location")).toBe("/app/merchant-support");
      }
    },
  );

  it("allows suspended shops to contact support", () => {
    expect(() => assertSupportShop({ status: "SUSPENDED" }, { route: "/app/merchant-support", redirectTo: "/auth/login" })).not.toThrow();
  });

  it("rejects uninstalled shops from support", () => {
    try {
      assertSupportShop({ status: "UNINSTALLED" }, { route: "/app/merchant-support", redirectTo: "/auth/login" });
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect(error.headers.get("Location")).toBe("/auth/login");
    }
  });
});
