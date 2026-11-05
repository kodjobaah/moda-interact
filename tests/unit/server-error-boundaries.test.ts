import React from "react";
import type {EntryContext} from "react-router";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
const output = vi.hoisted(() => ({records: [] as Array<{event: string; data: Record<string, unknown>}>, broken: false}));
const renderer = vi.hoisted(() => ({render: vi.fn(), abort: vi.fn(), callbacks: {} as Record<string, (...args: unknown[]) => void>}));
vi.mock("@modainteract/moda-interact-shared/logging", async original => {
  const real = await original<typeof import("@modainteract/moda-interact-shared/logging")>();
  return {...real, createLogger: (options: Parameters<typeof real.createLogger>[0]) => real.createLogger({...options, sink: record => {
    if (output.broken) throw new Error("sink failed"); output.records.push(JSON.parse(JSON.stringify(record)));
  }})};
});
vi.mock("../../app/shopify.server", () => ({addDocumentResponseHeaders: vi.fn()}));
vi.mock("react-dom/server", () => ({renderToPipeableStream: renderer.render}));
vi.mock("isbot", () => ({isbot: (agent: string) => agent === "bot"}));
import handleRequest, {handleError, streamTimeout} from "../../app/entry.server";
import {logBillingBoundaryFailure} from "../../app/services/billing/providers/shopify-billing-diagnostics.server";
const failure = () => Object.assign(new Error("original framework marker email=private@example.test redis://private-host", {cause: new Error("original framework cause access_token=private-token")}), {code: "P2034"});
beforeEach(() => {
  vi.stubGlobal("React", React); vi.useFakeTimers(); vi.clearAllMocks(); output.records.length = 0; output.broken = false;
  renderer.render.mockImplementation((_element, callbacks) => {
    renderer.callbacks = callbacks;
    return {abort: renderer.abort, pipe: (body: {end(value: string): void}) => body.end("server fixture")};
  });
});
afterEach(() => {vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();});
describe.each([false, true])("framework/SSR real Shared records, broken sink=%s", broken => {
  beforeEach(() => {output.broken = broken;});
  it("records uncaught loader/action source and cause without URL/header/query disclosure", () => {
    const error = failure(); const cause = error.cause;
    const request = new Request("https://app.test/app?private-query-sentinel=1", {method: "POST", headers: {authorization: "Bearer header-sentinel"}});
    expect(() => handleError(error, {request})).not.toThrow(); expect(error.cause).toBe(cause);
    expect(output.records).toHaveLength(broken ? 0 : 1);
    const json = JSON.stringify(output.records);
    if (!broken) for (const marker of ["original framework marker", "original framework cause", "P2034", "POST"]) expect(json).toContain(marker);
    for (const secret of ["private@example.test", "private-host", "private-token", "private-query-sentinel", "header-sentinel"]) expect(json).not.toContain(secret);
  });
  it("records shell failures and rejects with exactly the original exception", async () => {
    const error = failure(); const promise = handleRequest(new Request("https://app.test"), 201, new Headers(), {} as EntryContext);
    const rejection = expect(promise).rejects.toBe(error); renderer.callbacks.onShellError(error); await rejection;
    expect(output.records).toHaveLength(broken ? 0 : 1); expect(renderer.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(streamTimeout + 1000); expect(renderer.abort).toHaveBeenCalledTimes(1);
  });
  it("preserves streamed 500 render failure and original body/abort behavior", async () => {
    const promise = handleRequest(new Request("https://app.test"), 202, new Headers(), {} as EntryContext);
    renderer.callbacks.onError(failure()); renderer.callbacks.onShellReady();
    const response = await promise; expect(response.status).toBe(500); expect(await response.text()).toBe("server fixture");
    expect(response.headers.get("content-type")).toBe("text/html"); expect(output.records).toHaveLength(broken ? 0 : 1);
  });
  it("keeps successful browser/bot statuses and ready callback selection", async () => {
    for (const agent of ["browser", "bot"]) {
      const promise = handleRequest(new Request("https://app.test", {headers: {"user-agent": agent}}), 201, new Headers(), {} as EntryContext);
      renderer.callbacks[agent === "bot" ? "onAllReady" : "onShellReady"]();
      expect((await promise).status).toBe(201);
    }
    expect(output.records).toHaveLength(0);
  });
});
it.each([302, 400, 403, 404, 422])("keeps expected Response %s out of operational diagnostics", status => {
  handleError(new Response("private-body-sentinel", {status}), {request: new Request("https://app.test")});
  expect(output.records).toHaveLength(0);
});
it("does not repeat full evidence already emitted by a domain owner", () => {
  const error = failure(); logBillingBoundaryFailure({event: "owned.failure", operation: "owned", stage: "owned", error});
  handleError(error, {request: new Request("https://app.test")}); expect(output.records).toHaveLength(1);
  expect(output.records[0].event).toBe("owned.failure");
});
