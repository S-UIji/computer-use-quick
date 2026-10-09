import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import type { PageHandle } from "../../src/session/browser.js";

const missing = "Failed to load resource: the server responded with a status of 404 (Not Found)";
const icon = "https://example.test/assets/favicon.ico?v=17";

async function setup() {
  // CDP event order is controlled here; integration tests use an actual browser.
  const cdp = Object.assign(new EventEmitter(), { send: async () => ({}) });
  const collector = await DiagnosticsCollector.attach({ cdp } as unknown as PageHandle);
  const request = (id = "icon", url = icon, type = "Other", initiator = "other", method = "GET") =>
    cdp.emit("Network.requestWillBeSent", { requestId: id, request: { url, method }, type, initiator: { type: initiator } });
  const response = (id = "icon", url = icon, status = 404, type = "Other") =>
    cdp.emit("Network.responseReceived", { requestId: id, type, response: { url, status } });
  const log = (entry: Record<string, unknown> = {}) => cdp.emit("Log.entryAdded", {
    entry: { source: "network", level: "error", text: missing, url: icon, networkRequestId: "icon", ...entry }
  });
  return { cdp, collector, request, response, log };
}

describe("confirmed favicon 404 diagnostics", () => {
  it.each([
    "https://example.test/favicon.ico", icon,
    "https://example.test/icons/favicon.png?version=3",
    "https://example.test/icons/favicon.svg",
    "https://example.test/icons/favicon-32x32.png"
  ])("omits browser favicon 404 in both channels: %s", async url => {
    const { collector, request, response, log } = await setup();
    request("icon", url); response("icon", url); log({ url });
    expect(collector.failedRequests()).toEqual([]);
    expect(collector.consoleErrors()).toEqual([]);
  });

  it("removes an early matching Log entry only after its actual response confirms 404", async () => {
    const { cdp, collector, request, response, log } = await setup();
    request(); log();
    cdp.emit("Runtime.consoleAPICalled", { type: "error", args: [{ value: missing }] });
    expect(collector.consoleErrors()).toEqual([missing, missing]);
    response();
    expect(collector.consoleErrors()).toEqual([missing]);
    expect(collector.failedRequests()).toEqual([]);
  });

  it("keeps Log after loadingFinished attributable to its confirmed response", async () => {
    const { cdp, collector, request, response, log } = await setup();
    request(); response();
    cdp.emit("Network.loadingFinished", { requestId: "icon" });
    log();
    expect(collector.consoleErrors()).toEqual([]);
  });

  it.each([
    { source: "javascript" }, { source: undefined }, { url: undefined },
    { networkRequestId: undefined }, { networkRequestId: "unrelated" },
    { url: "https://example.test/api/favicon.ico" },
    { text: "favicon.ico returned 404 in application code" },
    { text: "Failed to load resource: the server responded with a status of 500 (Internal Server Error)" },
    { text: "Failed to load resource: net::ERR_ABORTED" }
  ])("preserves Log entries without matching network 404 evidence: %j", async entry => {
    const { collector, request, response, log } = await setup();
    request(); response(); log(entry);
    expect(collector.consoleErrors()).toEqual([entry.text ?? missing]);
  });

  it.each([
    ["Fetch", "script", "GET"], ["XHR", "script", "GET"],
    ["Document", "other", "GET"], ["Image", "parser", "GET"],
    ["Other", "script", "GET"], ["Other", "other", "POST"],
    [undefined, "other", "GET"], ["Other", undefined, "GET"]
  ])("preserves ambiguous/application requests (%s / %s / %s)", async (type, initiator, method) => {
    const { cdp, collector, response, log } = await setup();
    cdp.emit("Network.requestWillBeSent", { requestId: "icon", request: { url: icon, method }, type, initiator: { type: initiator } });
    response(); log();
    expect(collector.failedRequests()).toEqual([`404 ${icon}`]);
    expect(collector.consoleErrors()).toEqual([missing]);
  });

  it.each([
    "https://example.test/api/favicon", "https://example.test/favicon.ico/api",
    "https://example.test/favicon.ico.json", "https://example.test/not-favicon.ico",
    "https://example.test/icons/app.png", "https://example.test/%66avicon.ico",
    "file:///favicon.ico", "not-a-url"
  ])("preserves non-confirmed favicon URL %s", async url => {
    const { collector, request, response, log } = await setup();
    request("icon", url); response("icon", url); log({ url });
    expect(collector.failedRequests()).toEqual([`404 ${url}`]);
    expect(collector.consoleErrors()).toEqual([missing]);
  });

  it("preserves runtime console.error and assert regardless of favicon text", async () => {
    const { cdp, collector, request, response } = await setup();
    request(); response();
    for (const type of ["error", "assert"]) cdp.emit("Runtime.consoleAPICalled", { type, args: [{ value: "favicon.ico 404" }] });
    expect(collector.consoleErrors()).toEqual(["favicon.ico 404", "favicon.ico 404"]);
  });

  it.each([403, 500])("preserves favicon HTTP %s", async status => {
    const { collector, request, response, log } = await setup();
    request(); response("icon", icon, status); log();
    expect(collector.failedRequests()).toEqual([`${status} ${icon}`]);
    expect(collector.consoleErrors()).toEqual([missing]);
  });

  it("preserves failed/cancelled favicon requests and subsequent logs", async () => {
    const { cdp, collector, request, response, log } = await setup();
    request(); response();
    cdp.emit("Network.loadingFailed", { requestId: "icon", errorText: "net::ERR_ABORTED", canceled: true });
    log({ text: "Failed to load resource: net::ERR_ABORTED" });
    expect(collector.failedRequests()).toEqual(["FAILED net::ERR_ABORTED (req icon)"]);
    expect(collector.consoleErrors()).toEqual(["Failed to load resource: net::ERR_ABORTED"]);
  });

  it("preserves 404 when request or matching response metadata is unavailable", async () => {
    const { collector, request, response, log } = await setup();
    response(); log();
    expect(collector.failedRequests()).toEqual([`404 ${icon}`]);
    expect(collector.consoleErrors()).toEqual([missing]);
    collector.clear(); request(); log();
    expect(collector.consoleErrors()).toEqual([missing]);
    response("icon", "https://example.test/api/missing");
    expect(collector.failedRequests()).toEqual(["404 https://example.test/api/missing"]);
    expect(collector.consoleErrors()).toEqual([missing]);
  });

  it("does not reuse favicon evidence across redirected or reused request IDs", async () => {
    const { collector, request, response, log } = await setup();
    request(); response(); log();
    const api = "https://example.test/api/missing";
    request("icon", api, "Fetch", "script"); response("icon", api, 404, "Fetch"); log({ url: api });
    expect(collector.failedRequests()).toEqual([`404 ${api}`]);
    expect(collector.consoleErrors()).toEqual([missing]);
    collector.clear(); request(); response();
    request(); log();
    expect(collector.consoleErrors()).toEqual([missing]);
    response("icon", icon, 500);
    expect(collector.failedRequests()).toEqual([`500 ${icon}`]);
    expect(collector.consoleErrors()).toEqual([missing]);
  });

  it("does not associate a stale pre-redirect Log with the new request", async () => {
    const { collector, request, response, log } = await setup();
    request(); log(); request(); response();
    expect(collector.consoleErrors()).toEqual([missing]);
  });

  it("clear discards confirmation so later same-ID errors remain visible", async () => {
    const { collector, request, response, log } = await setup();
    request(); response(); collector.clear(); log();
    expect(collector.consoleErrors()).toEqual([missing]);
    response();
    expect(collector.failedRequests()).toEqual([`404 ${icon}`]);
  });

  it("expires and bounds request evidence instead of retaining old suppression forever", async () => {
    const { collector, request, response, log } = await setup();
    request(); response();
    for (let i = 0; i < 512; i++) request(`later-${i}`, `https://example.test/${i}/favicon.ico`);
    log();
    expect(collector.consoleErrors()).toEqual([missing]);
    collector.clear();
    vi.useFakeTimers();
    try {
      request(); response(); vi.advanceTimersByTime(120_000); log();
      expect(collector.consoleErrors()).toEqual([missing]);
    } finally { vi.useRealTimers(); }
  });

  it("keeps the newest 20 console and failed-request entries", async () => {
    const { cdp, collector, response } = await setup();
    for (let i = 0; i < 30; i++) {
      cdp.emit("Runtime.consoleAPICalled", { type: "error", args: [{ value: `err${i}` }] });
      response(`api-${i}`, `https://example.test/api/${i}`, 404, "Fetch");
    }
    expect(collector.consoleErrors()).toEqual(Array.from({ length: 20 }, (_, i) => `err${i + 10}`));
    expect(collector.failedRequests()).toEqual(Array.from({ length: 20 }, (_, i) => `404 https://example.test/api/${i + 10}`));
  });
});
