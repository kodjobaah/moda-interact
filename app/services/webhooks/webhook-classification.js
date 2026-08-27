/**
 * Pure classification of an authenticated webhook topic into the handling
 * lane the ingress service should take. This has no side effects and no
 * knowledge of transport (Redis/BullMQ/Prisma).
 *
 * @param {string} topic
 * @returns {{ kind: "checkout" | "order" | "ignored" | "unknown" }}
 */
export function classifyTopic(topic) {
  switch (topic) {
    case "CHECKOUTS_CREATE":
    case "CHECKOUTS_UPDATE":
      return { kind: "checkout" };

    case "ORDERS_CREATE":
      return { kind: "order" };

    case "CARTS_CREATE":
    case "CARTS_UPDATE":
      return { kind: "ignored" };

    default:
      return { kind: "unknown" };
  }
}
