import type { Shop } from "@prisma/client";
import { redirect } from "react-router";

export type ShopAccessStatus = Pick<Shop, "status">;

export type ShopAccessContext = {
  route: string;
  capability?: string;
  redirectTo: string;
};

export function assertActiveShop(
  shop: ShopAccessStatus,
  context: ShopAccessContext,
): void {
  if (shop.status === "ACTIVE") {
    return;
  }

  throw redirect(context.redirectTo);
}

export function assertSupportShop(
  shop: ShopAccessStatus,
  context: ShopAccessContext,
): void {
  if (shop.status !== "UNINSTALLED") {
    return;
  }

  throw redirect(context.redirectTo);
}
