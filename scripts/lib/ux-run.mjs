import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import puppeteer from "puppeteer-core";

export async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + " timed out")), ms);
    })]);
  } finally { clearTimeout(timer); }
}
export function mcpEnvironment(inherited, browserURL) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith("CUQ_")));
  Object.assign(env, { CUQ_BROWSER_URL: browserURL, CUQ_LAUNCH: "off", CUQ_WATCH: "auto" });
  return env;
}
export async function verifyEndpoint(browserURL, wsEndpoint) {
  const version = await fetch(browserURL + "/json/version", { signal: AbortSignal.timeout(3000) });
  if (!version.ok) throw new Error("Owned browser endpoint unavailable");
  const info = await version.json();
  if (info.webSocketDebuggerUrl !== wsEndpoint) throw new Error("Browser endpoint identity mismatch");
}
export async function scenario(report, name, fn) {
  const start = Date.now();
  try { await fn(); report.push({ name, ok: true, ms: Date.now() - start }); }
  catch (error) { report.push({ name, ok: false, ms: Date.now() - start, error: String(error.stack ?? error) }); }
  return report.at(-1);
}
export async function createUxRun({ outputRoot, handler }) {
  mkdirSync(outputRoot, { recursive: true });
  const out = mkdtempSync(join(resolve(outputRoot), "run-"));
  const work = join(out, "work"); mkdirSync(work);
  const sut = http.createServer(handler);
  try { await new Promise((resolve, reject) => { sut.once("error", reject); sut.listen(0, "127.0.0.1", resolve); }); }
  catch (error) { sut.close(); throw error; }
  const baseUrl = "http://127.0.0.1:" + sut.address().port;
  let browser, profile, browserURL, restartPort, closed = false;
  const cleanups = [];
  let closePromise, launchPromise;
  const profiles = new Set();
  const run = {
    out, work, baseUrl,
    get browser() { return browser; },
    get profile() { return profile; },
    get browserURL() { return browserURL; },
    addCleanup(fn) { if (closed) throw new Error("Run is closing"); cleanups.push(fn); },
    launchBrowser(options) {
      if (closed || browser || launchPromise) return Promise.reject(new Error("Run is closed or already owns a browser"));
      launchPromise = run.launchOwnedBrowser(options).finally(() => { launchPromise = undefined; });
      return launchPromise;
    },
    async launchOwnedBrowser({ executablePath, headless = false, reconnect = false }) {
      profile = mkdtempSync(join(tmpdir(), "cuq-ux-profile-")); profiles.add(profile);
      try {
        browser = await puppeteer.launch({
          executablePath, userDataDir: profile, headless,
          defaultViewport: null, timeout: 20_000,
          handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
          args: ["--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=" + (reconnect ? restartPort : 0),
            "--no-first-run", "--no-default-browser-check", "--window-size=1280,860"]
        });
        const endpoint = new URL(browser.wsEndpoint());
        if (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost") throw new Error("Non-loopback browser endpoint");
        browserURL = "http://127.0.0.1:" + endpoint.port;
        await verifyEndpoint(browserURL, browser.wsEndpoint());
        restartPort = Number(endpoint.port);
        if (closed) throw new Error("Run closed during browser launch");
        return browser;
      } catch (error) {
        // Puppeteer owns and reaps a failed launch; a returned browser is ours to close.
        if (browser) await run.stopBrowser();
        else { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); profiles.delete(profile); }
        throw error;
      }
    },
    async stopBrowser() {
      if (!browser) return;
      const owned = browser, child = owned.process();
      await bounded(owned.close(), 10_000, "Owned Chrome close");
      if (child && child.exitCode === null && child.signalCode === null) {
        await bounded(once(child, "exit"), 5000, "Owned Chrome exit");
      }
      browser = undefined;
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      profiles.delete(profile);
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
      const errors = [];
      if (launchPromise) {
        try { await launchPromise; } catch { /* launch owns its failure cleanup */ }
      }
      for (const cleanup of cleanups.splice(0).reverse()) {
        try { await bounded(Promise.resolve().then(cleanup), 5000, "MCP cleanup"); }
        catch (error) { errors.push(error); }
      }
      try { await run.stopBrowser(); } catch (error) { errors.push(error); }
      try {
        sut.closeAllConnections();
        await bounded(new Promise((resolve, reject) => sut.close(error => error ? reject(error) : resolve())), 3000, "SUT close");
      } catch (error) { errors.push(error); }
      // Never remove an active browser's profile after failed stop.
      if (!browser) for (const p of profiles) {
        try { rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
        catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, errors.map(e => e.message).join("; "));
      })();
      return closePromise;
    }
  };
  return run;
}

export async function waitProcessExit(pid, timeoutMs = 3000) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error("No owned MCP process identity");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Owned MCP child still alive after close: " + pid);
}

export function finishRun(code) {
  process.exitCode = code;
  // The failure report has already been written. Do not let an unreleased
  // owned child/socket turn a reported failure into an indefinitely hung job.
  if (code) setTimeout(() => process.exit(code), 250).unref();
}
