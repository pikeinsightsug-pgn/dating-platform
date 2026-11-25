// The "Turn on message alerts" card (assets/push-notifications.js). Alerts need https, so the
// page is served on a made-up https address, and OneSignal is replaced by a small stand-in that
// records what was asked. Nothing here talks to OneSignal or the database.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const repo = join(import.meta.dirname, "..", "..");
const ORIGIN = "https://pk-alerts.test";
const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<main><header>P.K CONNECT</header><p id="signed-in">Signed in</p><p id="rest">Discover</p></main>
<script src="/assets/push-notifications.js"></script>
<script>FYPPush.start({ id: "member-1", approved: ${"${APPROVED}"} });</script>`;
// Stand-in for OneSignal: window.__perm is the phone's answer so far, window.__answer what the
// phone will say when asked.
const FAKE_SDK = `(() => {
  const os = {
    init: async () => {}, login: async (id) => { window.__login = id; }, logout: async () => {},
    Notifications: {
      get permission() { return window.__perm === "granted"; },
      get permissionNative() { return window.__perm; },
      requestPermission: async () => { window.__asked = (window.__asked || 0) + 1; window.__perm = window.__answer; }
    },
    Slidedown: { promptPush: async () => { window.__slidedown = true; } }
  };
  const queued = window.OneSignalDeferred || [];
  window.OneSignalDeferred = { push: (f) => f(os) };
  queued.forEach((f) => f(os));
})();`;

async function open(browser, { perm = "default", answer = "granted", approved = true, hiddenUntil } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.route(ORIGIN + "/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/assets/push-notifications.js")
      return route.fulfill({ contentType: "text/javascript", body: await readFile(join(repo, path)) });
    if (path === "/sw.js") return route.fulfill({ contentType: "text/javascript", body: "" });
    return route.fulfill({ contentType: "text/html", body: PAGE.replace("${APPROVED}", String(approved)) });
  });
  await context.route("https://cdn.onesignal.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: FAKE_SDK }));
  await context.addInitScript(([p, a, h]) => {
    window.__perm = p; window.__answer = a;
    if (h) localStorage.setItem("fyp-alerts-card-hidden-until", String(h));
  }, [perm, answer, hiddenUntil || 0]);
  const page = await context.newPage();
  page.on("pageerror", (error) => { throw error; });
  await page.goto(ORIGIN + "/discover.html");
  return page;
}

test("message alerts card", async (t) => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  t.after(() => browser.close());

  await t.test("asks with a clear button instead of OneSignal's automatic pop-up", async () => {
    const page = await open(browser);
    await page.waitForSelector("#alerts-card");
    assert.match(await page.textContent("#alerts-card"), /Never miss a message/);
    assert.equal(await page.evaluate(() => window.__slidedown), undefined, "no automatic pop-up");
    assert.equal(await page.evaluate(() => window.__login), "member-1", "the member is still linked for alerts");
    assert.equal(await page.evaluate(() => document.getElementById("signed-in").nextElementSibling.id), "alerts-card", "shown at the top");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, "fits a phone screen");
    await page.click("#alerts-card .alerts-on");
    await page.waitForFunction(() => /Alerts are on/.test(document.getElementById("alerts-card")?.textContent || ""));
    assert.equal(await page.evaluate(() => window.__asked), 1);
    await page.waitForSelector("#alerts-card", { state: "detached", timeout: 6000 });
    await page.context().close();
  });

  await t.test("a member who says no on the phone gets the steps to unblock", async () => {
    const page = await open(browser, { answer: "denied" });
    await page.click("#alerts-card .alerts-on");
    await page.waitForFunction(() => /blocked/.test(document.getElementById("alerts-card").textContent));
    await page.click("#alerts-card button");
    assert.equal(await page.locator("#alerts-card").count(), 0);
    await page.reload();
    await page.waitForTimeout(500);
    assert.equal(await page.locator("#alerts-card").count(), 0, "OK hides it for a while");
    await page.context().close();
  });

  await t.test("members who blocked alerts earlier see how to unblock", async () => {
    const page = await open(browser, { perm: "denied" });
    await page.waitForSelector("#alerts-card");
    assert.match(await page.textContent("#alerts-card"), /Message alerts are blocked/);
    assert.equal(await page.locator("#alerts-card .alerts-on").count(), 0);
    await page.context().close();
  });

  await t.test("'Not now' hides it for 3 days", async () => {
    const page = await open(browser);
    await page.click("#alerts-card .alerts-later");
    const until = Number(await page.evaluate(() => localStorage.getItem("fyp-alerts-card-hidden-until")));
    assert.ok(Math.abs(until - Date.now() - 3 * 864e5) < 60e3);
    await page.reload(); await page.waitForTimeout(500);
    assert.equal(await page.locator("#alerts-card").count(), 0);
    await page.context().close();
  });

  await t.test("nothing for members with alerts on, or members not yet approved", async () => {
    for (const options of [{ perm: "granted" }, { approved: false }]) {
      const page = await open(browser, options);
      await page.waitForTimeout(500);
      assert.equal(await page.locator("#alerts-card").count(), 0, JSON.stringify(options));
      await page.context().close();
    }
  });
});
