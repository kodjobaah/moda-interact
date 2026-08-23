import { Queue } from "bullmq";
import { createRedisConnection } from "../redis.server";

const connection = createRedisConnection();

export const ordersQueue = new Queue("order-events", {
  connection,
  defaultJobOptions: {
    attempts: 3,

    backoff: {
      type: "exponential",
      delay: 1000,
    },

    removeOnComplete: {
      age: 60 * 60 * 24,
      count: 1000,
    },

    removeOnFail: {
      age: 60 * 60 * 24 * 7,
    },
  },
});