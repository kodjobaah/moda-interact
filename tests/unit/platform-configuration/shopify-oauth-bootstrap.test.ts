import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  construct: vi.fn(),
}));

vi.mock("@shopify/shopify-app-react-router/adapters/node", () => ({}));
vi.mock("@shopify/shopify-app-react-router/server", () => ({
  ApiVersion: { July26: "2026-07" },
  AppDistribution: { AppStore: "app-store" },
  LogSeverity: { Debug: 0 },
  shopifyApp: mocks.construct,
}));
vi.mock("@shopify/shopify-app-session-storage-prisma", () => ({
  PrismaSessionStorage: class PrismaSessionStorage { constructor(database: unknown) { void database; } },
}));
vi.mock("../../../app/db.server", () => ({ default: {} }));
vi.mock("../../../app/services/platform-configuration/composition.server", () => ({
  createDefaultShopifyPlatformConfigurationService: () => ({
    requireShopifyOAuthCredentials: mocks.read,
  }),
}));

const client = Object.freeze({
  authenticate: { webhook: vi.fn(), admin: vi.fn() },
  unauthenticated: {}, login: vi.fn(), registerWebhooks: vi.fn(),
  sessionStorage: {}, addDocumentResponseHeaders: vi.fn(),
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.construct.mockReturnValue(client);
});
afterEach(() => vi.unstubAllEnvs());

describe("ARCH-043 Shopify OAuth boot gating", () => {
  it("does not construct or export an active SDK until the sealed credential read resolves", async () => {
    let release!: (credentials: { version: number; apiKey: string; apiSecret: string }) => void;
    mocks.read.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    vi.stubEnv("SHOPIFY_API_KEY", "stale-environment-key");
    vi.stubEnv("SHOPIFY_API_SECRET", "stale-environment-secret");
    const loading = import("../../../app/shopify.server.js");
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
    expect(mocks.construct).not.toHaveBeenCalled();
    release({ version: 2, apiKey: "database-public-key", apiSecret: "database-private-secret" });
    const runtime = await loading;
    expect(mocks.construct).toHaveBeenCalledOnce();
    expect(mocks.construct.mock.calls[0]?.[0]).toMatchObject({
      apiKey: "database-public-key", apiSecretKey: "database-private-secret",
    });
    expect(runtime.apiKey).toBe("database-public-key");
    expect(runtime.authenticate).toBe(client.authenticate);
    expect(runtime.sessionStorage).toBe(client.sessionStorage);
  });

  it("fails module initialization closed when credentials are absent or revoked", async () => {
    mocks.read.mockRejectedValue(new Error("MISSING"));
    await expect(import("../../../app/shopify.server.js")).rejects.toThrow("MISSING");
    expect(mocks.construct).not.toHaveBeenCalled();
  });

  it("constructs a new SDK with the rotated revision after process/module restart", async () => {
    mocks.read.mockResolvedValue({ version: 3, apiKey: "rotated-key", apiSecret: "rotated-secret" });
    const runtime = await import("../../../app/shopify.server.js");
    expect(runtime.apiKey).toBe("rotated-key");
    expect(mocks.construct).toHaveBeenCalledOnce();
    expect(mocks.construct.mock.calls[0]?.[0]).toMatchObject({
      apiKey: "rotated-key", apiSecretKey: "rotated-secret",
    });
  });
});
