import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import Redis from "ioredis";
const execute = promisify(execFile);
const docker = (args: string[]) => execute("docker", args, {timeout: 30_000, maxBuffer: 1024 * 1024});

/** Never consumes REDIS_URL/TEST_REDIS_URL. Owns one loopback-only Docker Redis and its clients. */
export async function startShopifyWebhookRedis() {
  const name = `moda-shopify-webhook-${randomUUID()}`;
  let started = false;
  const clients: Redis[] = [];
  const cleanups: Array<() => Promise<unknown>> = [];
  let control: Redis | undefined;
  async function cleanup() {
    try { await control?.call("CLIENT", "UNPAUSE"); } catch { /* Container may already be unavailable. */ }
    const cleanupResults = await Promise.allSettled(cleanups.reverse().map(async close => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.resolve().then(close), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Owned Redis resource cleanup deadline exceeded")), 7000);
      })]); } finally {clearTimeout(timer);}
    }));
    clients.forEach(client => client.disconnect());
    if (started) { await docker(["stop", "--time", "1", name]); started = false; }
    const failed = cleanupResults.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::6379", "redis:7.4.2-alpine"]);
    started = true;
    const {stdout} = await docker(["inspect", "--format", '{{(index (index .NetworkSettings.Ports "6379/tcp") 0).HostPort}}', name]);
    const port = Number(stdout.trim()); if (!Number.isInteger(port) || port <= 0) throw new Error("No isolated Redis loopback port");
    const url = `redis://127.0.0.1:${port}`;
    const createClient = () => {
      const client = new Redis(url, {lazyConnect: true, connectTimeout: 5000, commandTimeout: 5000,
        maxRetriesPerRequest: 1, retryStrategy: attempt => attempt <= 20 ? 50 : null});
      client.on("error", () => {}); clients.push(client); return client;
    };
    control = createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([control.connect().then(() => control!.ping()), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Isolated Redis readiness deadline exceeded")), 7000);
    })]); } finally { clearTimeout(timer); }
    const version = (await control.info("server")).match(/^redis_version:(.+)$/m)?.[1].trim();
    process.stdout.write(`SHOPIFY_WEBHOOK_REDIS ${JSON.stringify({image: "redis:7.4.2-alpine", version, loopback: true})}\n`);
    return {url, control, createClient, cleanup, track: (close: () => Promise<unknown>) => cleanups.push(close)};
  } catch (error) { await cleanup(); throw error; }
}
export type ShopifyWebhookRedis = Awaited<ReturnType<typeof startShopifyWebhookRedis>>;
