import IORedis from "ioredis";

export function createRedisConnection() {
  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is not configured");
  }

  return new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });
}