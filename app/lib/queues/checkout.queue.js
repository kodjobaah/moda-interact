import { Queue } from "bullmq";
import { createRedisConnection } from "../redis.server";

const connection = createRedisConnection();

export function getCheckoutQueue() {
  if (checkoutQueue) {
    return checkoutQueue;
  }

  checkoutQueue = new Queue(
    "checkout-events",
    {
      connection: createRedisConnection(),

      defaultJobOptions: {
        attempts: 3,

        backoff: {
          type: "exponential",
          delay: 1000,
        },

        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    },
  );

  return checkoutQueue;
}