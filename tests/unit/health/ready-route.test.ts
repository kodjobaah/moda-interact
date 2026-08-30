import { beforeEach, describe, expect, it, vi } from "vitest";

const checkReadinessMock = vi.fn();
vi.mock("../../../app/services/health/health-check.server", () => ({
  checkReadiness: checkReadinessMock,
}));

const { loader } = await import("../../../app/routes/ready");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /ready", () => {
  it("returns 200 when every required dependency is ready", async () => {
    checkReadinessMock.mockResolvedValue({
      status: "ready",
      checks: { redis: true, postgres: true },
    });

    const response = await loader();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      checks: { redis: true, postgres: true },
    });
  });

  it("returns 503 when a required dependency is unavailable", async () => {
    checkReadinessMock.mockResolvedValue({
      status: "not_ready",
      checks: { redis: false, postgres: true },
    });

    const response = await loader();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "not_ready",
      checks: { redis: false, postgres: true },
    });
  });

  it("returns 503 when every required dependency is unavailable", async () => {
    checkReadinessMock.mockResolvedValue({
      status: "not_ready",
      checks: { redis: false, postgres: false },
    });

    const response = await loader();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "not_ready",
      checks: { redis: false, postgres: false },
    });
  });

  it("exposes only check names and booleans, never sensitive details", async () => {
    checkReadinessMock.mockResolvedValue({
      status: "not_ready",
      checks: { redis: false, postgres: false },
    });

    const response = await loader();
    const body = await response.json();

    expect(body).toEqual({
      status: "not_ready",
      checks: { redis: false, postgres: false },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /(password|secret|token|api[_-]?key|redis:\/\/|postgres(ql)?:\/\/)/i,
    );
  });
});
