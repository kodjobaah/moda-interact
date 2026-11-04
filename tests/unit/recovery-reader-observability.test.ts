import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouterContextProvider, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
const output = vi.hoisted(() => ({ records: [] as unknown[], broken: false }));
const ports = vi.hoisted(() => ({ owner: vi.fn(), messages: vi.fn(), related: vi.fn(), templates: vi.fn(),
  overview: vi.fn(), list: vi.fn(), exists: vi.fn(), history: vi.fn(), command: vi.fn() }));
vi.mock("@modainteract/moda-interact-shared/logging", async original => {
  const actual = await original<typeof import("@modainteract/moda-interact-shared/logging")>();
  return { ...actual, createLogger: (options: Parameters<typeof actual.createLogger>[0]) => actual.createLogger({ ...options,
    sink: record => { if (output.broken) throw new Error("sink failure"); output.records.push(JSON.parse(JSON.stringify(record))); } }) };
});
vi.mock("../../app/db.server", () => ({default: {checkoutRecovery: {findFirst: ports.exists}}}));
vi.mock("../../app/routes/app/recoveries/access.server", () => ({requireRecoveryHistory: ports.history}));
vi.mock("../../app/services/recoveries/recovery-detail.server", () => ({
  createRecoveryDetailReader: ports.owner, readRecoveryMessages: ports.messages, readRelatedRecoveries: ports.related,
}));
vi.mock("../../app/services/recoveries/recovery-follow-up-catalogue.server", () => ({readCurrentFollowUpTemplates: ports.templates}));
vi.mock("../../app/services/recoveries/recovery-readers.server", () => ({readRecoveryOverview: ports.overview, readRecoveryPage: ports.list}));
vi.mock("../../app/services/recoveries/recovery-human-commands.server", () => ({
  RecoveryCommandError: class extends Error {
    constructor(public code: string, public status = 409, public currentControl?: unknown, cause?: unknown) { super(code, {cause}); }
  }, changeRecoveryControl: ports.command, admitRecoveryHumanSend: ports.command, readRecoveryCommandStatus: ports.command,
}));
import { loadRecoveryDetail, loadRecoverySection } from "../../app/routes/app/recovery-detail/loader.server";
import { loadRecoveryList } from "../../app/routes/app/recoveries/loader.server";
import { loadOverviewPerformance } from "../../app/routes/app/home/overview.server";
import { recoveryControlAction, recoverySendAction, recoveryCommandStatusLoader } from "../../app/routes/app/recovery-detail/command-http.server";
const ui = {locale: "en", timeZone: "UTC", fallbackLocale: "en"};
const failure = (code = "P2010") => Object.assign(new Error("original recovery marker email=private@example.test redis://private-host", {
  cause: new Error("original cause access_token=private-token"),
}), {code});
function args(body?: unknown) {
  return {context: new RouterContextProvider(), params: {recoveryId: "owned-recovery", commandId: "command-1"},
    request: new Request("https://app.test/app/recoveries/owned-recovery", body === undefined ? undefined : {
      method: "POST", headers: {"content-type": "application/json", origin: "https://app.test"}, body: JSON.stringify(body),
    })} as unknown as LoaderFunctionArgs & ActionFunctionArgs;
}
function evidence(broken: boolean, code = "P2010") {
  expect(output.records).toHaveLength(broken ? 0 : 1);
  if (broken) return;
  const json = JSON.stringify(output.records);
  for (const marker of ["original recovery marker", "original cause", code]) expect(json).toContain(marker);
  for (const secret of ["private@example.test", "private-token", "private-host"]) expect(json).not.toContain(secret);
}
beforeEach(() => {
  vi.clearAllMocks(); output.records.length = 0; output.broken = false;
  vi.stubEnv("SHOPIFY_APP_URL", "https://app.test");
  ports.history.mockResolvedValue({shopId: "shop-1", merchantUi: ui, embed: {shop: "fixture.test"}, merchant: {shop: {id: "shop-1"}}});
  ports.owner.mockResolvedValue({detail: {conversation: null}, readMessages: ports.messages, readRelated: ports.related});
  ports.messages.mockResolvedValue({items: []}); ports.related.mockResolvedValue({items: []});
  ports.templates.mockResolvedValue([]); ports.list.mockResolvedValue({items: []}); ports.exists.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());
describe.each([false, true])("actual recovery Shared output, broken sink=%s", broken => {
  beforeEach(() => { output.broken = broken; });
  it.each(["owner", "messages", "related", "templates"] as const)("preserves %s fallback and source evidence", async stage => {
    if (stage === "templates") ports.owner.mockResolvedValue({detail: {conversation: {languageTag: "en", followUp: {eligible: true, used: false}}}, readMessages: ports.messages, readRelated: ports.related});
    ports[stage].mockRejectedValueOnce(failure());
    const reply = await loadRecoveryDetail(args());
    expect(reply.init?.status ?? 200).toBe(stage === "owner" ? 503 : 200);
    if (stage === "messages" || stage === "related") expect(reply.data[stage].state).toBe("error");
    if (stage === "templates") expect(reply.data.templates).toEqual([]);
    expect(JSON.stringify(reply.data)).not.toContain("original recovery marker"); evidence(broken);
    if (!broken && stage === "owner") process.stdout.write(`RECOVERY_DIAGNOSTIC ${JSON.stringify(output.records[0])}\n`);
  });
  it.each(["messages", "related"] as const)("logs standalone %s failure and preserves 503", async stage => {
    ports[stage].mockRejectedValueOnce(failure());
    const a = args(); const reply = await loadRecoverySection(a, stage);
    expect(reply.init?.status).toBe(503); expect(ports.history).toHaveBeenCalledWith(a.request, a.context); evidence(broken);
  });
  it.each(["list", "exists", "overview"] as const)("logs %s read failures without inventing totals", async stage => {
    ports[stage].mockRejectedValueOnce(failure());
    const reply = stage === "overview" ? await loadOverviewPerformance("shop-1", new URL("https://app.test"), ui, {shop: "fixture.test"}) : await loadRecoveryList(args());
    expect(reply.state).toBe("error"); if ("overview" in reply) expect(reply.overview).toBeNull(); evidence(broken);
  });
  it.each(["P2002", "P2034", "P2010"])("records command failure %s and preserves classification", async code => {
    ports.command.mockRejectedValueOnce(failure(code));
    const reply = await recoverySendAction(args({kind: "HUMAN_TEXT", textBody: "Private body", idempotencyKey: "key-12345678", expectedControlRevision: 1}));
    expect(reply.init?.status).toBe(code === "P2010" ? 503 : 409); evidence(broken, code);
    if (!broken) expect(JSON.stringify(output.records)).toContain(code === "P2010" ? '"level":"error"' : '"level":"warn"');
  });
  it.each(["control", "status"])("records %s database failures", async kind => {
    ports.command.mockRejectedValueOnce(failure());
    const reply = kind === "control" ? await recoveryControlAction(args({targetMode: "HUMAN", expectedControlRevision: 1})) : await recoveryCommandStatusLoader(args());
    expect(reply.init?.status).toBe(503); evidence(broken);
  });
  it("retains the actual invalid URL cause without logging its input", async () => {
    vi.stubEnv("SHOPIFY_APP_URL", "private configuration invalid");
    const reply = await recoveryControlAction(args({targetMode: "HUMAN", expectedControlRevision: 1}));
    expect(reply.init?.status).toBe(503); expect(output.records).toHaveLength(broken ? 0 : 1);
    const json = JSON.stringify(output.records); expect(json).not.toContain("private configuration invalid");
    if (!broken) { expect(json).toContain("Invalid URL"); expect(json).toContain('"origin":"internal"'); }
  });
  it("leaves invalid input and context denial as ordinary control flow", async () => {
    expect((await recoveryControlAction(args({invalid: true}))).init?.status).toBe(400);
    const denial = new Response(null, {status: 302}); ports.history.mockRejectedValueOnce(denial);
    await expect(loadRecoveryDetail(args())).rejects.toBe(denial); expect(output.records).toHaveLength(0);
  });
  it.each(["messages_page", "messages_edge", "related_page", "related_edge"])("retains actual %s database failure at the section boundary", async stage => {
    const actual = await vi.importActual<typeof import("../../app/services/recoveries/recovery-detail.server")>("../../app/services/recoveries/recovery-detail.server");
    const kind = stage.startsWith("messages") ? "messages" : "related";
    const error = failure(); const date = new Date("2026-11-01T00:00:00Z");
    const query = vi.fn().mockResolvedValueOnce([{id: "owned-recovery", conversationId: "conversation-1", customerId: "customer-1"}]);
    if (stage.endsWith("edge")) query.mockResolvedValueOnce(kind === "messages" ? [{id: "message-1", createdAt: date}] : [{id: "related-1", detectedAt: date}]);
    query.mockRejectedValueOnce(error);
    ports[kind].mockImplementationOnce(input => kind === "messages" ? actual.readRecoveryMessages(input, {$queryRaw: query}) : actual.readRelatedRecoveries(input, {$queryRaw: query}));
    const reply = await loadRecoverySection(args(), kind);
    expect(reply.init?.status).toBe(503); evidence(broken);
    expect(query).toHaveBeenCalledTimes(stage.endsWith("edge") ? 3 : 2);
    expect(error.cause).toBeInstanceOf(Error);
  });
  it("preserves the actual sender-configuration database failure through the typed configuration boundary", async () => {
    const catalogue = await vi.importActual<typeof import("../../app/services/recoveries/recovery-follow-up-catalogue.server")>("../../app/services/recoveries/recovery-follow-up-catalogue.server");
    const source = failure(); const config = {platformConfiguration: {findUnique: vi.fn().mockRejectedValue(source)}};
    ports.owner.mockResolvedValue({detail: {conversation: {languageTag: "en", followUp: {eligible: true, used: false}}}, readMessages: ports.messages, readRelated: ports.related});
    let caught: unknown;
    ports.templates.mockImplementationOnce(async () => {
      try { return await catalogue.readCurrentFollowUpTemplates("shop-1", "en", config as never, {id: "shop-1", status: "ACTIVE", platform: "SHOPIFY", defaultLanguageTag: "en"}); }
      catch (error) { caught = error; throw error; }
    });
    const reply = await loadRecoveryDetail(args());
    expect(reply.init?.status ?? 200).toBe(200); expect(reply.data.templates).toEqual([]);
    expect(caught).toMatchObject({code: "DATABASE_UNAVAILABLE", cause: source});
    expect((caught as Error).cause).toBe(source); evidence(broken);
  });
});
