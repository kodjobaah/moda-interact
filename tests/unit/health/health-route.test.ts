import { afterEach, describe, expect, it } from "vitest";

const { loader } = await import("../../../app/routes/health");

afterEach(() => {
  delete process.env.REDIS_URL;
  delete process.env.DATABASE_URL;
});

describe("GET /health", () => {
  it("returns 200 with a stable ok body", async () => {
    const response = await loader();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("never depends on Redis or PostgreSQL (process liveness only)", async () => {
    delete process.env.REDIS_URL;
    delete process.env.DATABASE_URL;

    const response = await loader();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("disables proxy caching of the liveness response", async () => {
    const response = await loader();

    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
