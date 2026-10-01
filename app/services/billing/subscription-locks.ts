import { Prisma } from "@prisma/client";

export async function lockInitialFreeActivationState(
  transaction: Prisma.TransactionClient,
  shopId: string,
): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "shopId"
    FROM "shopify"."ShopSettings"
    WHERE "shopId" = ${shopId}
    FOR UPDATE
  `);
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "billing"."Subscription"
    WHERE "shopId" = ${shopId}
    FOR UPDATE
  `);
}