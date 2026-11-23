import type { Prisma } from "@prisma/client";

/** Match only exact TieredPrice handles attached to the observed Shopify subscription. */
export async function mapShopifyUsageEventHandles(
  transaction: Prisma.TransactionClient,
  planHandle: string,
  providerUsageEventHandles: readonly string[],
): Promise<{ mappedHandles: string[]; unmappedHandles: string[] }> {
  const providerHandles = [...new Set(providerUsageEventHandles)].sort();
  if (providerHandles.length === 0) {
    return { mappedHandles: [], unmappedHandles: [] };
  }

  const catalogue = await transaction.merchantPricingPlan.findUnique({
    where: { shopifyPlanHandle: planHandle },
    select: { usageEvents: { select: { eventHandle: true } } },
  });
  const catalogueHandles = new Set(catalogue?.usageEvents.map((event) => event.eventHandle) ?? []);
  return {
    mappedHandles: providerHandles.filter((handle) => catalogueHandles.has(handle)),
    unmappedHandles: providerHandles.filter((handle) => !catalogueHandles.has(handle)),
  };
}
