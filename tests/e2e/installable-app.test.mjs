// P.K CONNECT can be installed as a phone app: the app settings and icons load, the helper
// installs, the "Install the app" banner appears only when the phone offers installation,
// pages still load fresh (logins work as before), and going offline shows a friendly page.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile } from "./harness.mjs";

test("installable app", async (t) => {
  const env = await setup("e2e_installable_app");
  t.after(() => env.close());
  await env.member("amina@test.invalid", profile("Amina"), { approved: true });

  const page = await env.newPage({ mobile: true });
  await page.goto(env.base);

  await t.test("app settings and icons are correct", async () => {
    const href = await page.getAttribute('link[rel="manifest"]', "href");
    const manifest = await page.evaluate(async url => (await fetch(url)).json(), href);
    assert.equal(manifest.short_name, "P.K CONNECT");
    assert.equal(manifest.display, "standalone");
    assert.match(manifest.start_url, /login\.html/);
    for (const icon of manifest.icons) {
      const size = await page.evaluate(src => new Promise(r => { const i = new Image(); i.onload = () => r(i.naturalWidth + "x" + i.naturalHeight); i.onerror = () => r("broken"); i.src = src; }), icon.src);
      assert.equal(size, icon.sizes, icon.src);
    }
  });

  await t.test("the helper installs and the banner stays hidden until installation is offered", async () => {
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration()));
    assert.equal(await page.isVisible("#install-app"), false, "hidden when the phone does not offer installation");
    await page.evaluate(() => { const e = new Event("beforeinstallprompt"); e.prompt = () => { window.__prompted = true; }; e.userChoice = Promise.resolve({ outcome: "accepted" }); window.dispatchEvent(e); });
    await page.waitForSelector("#install-app button:visible");
    await page.click("#install-app button");
    assert.equal(await page.evaluate(() => window.__prompted), true, "the phone's install question is shown");
    await page.waitForSelector("#install-app", { state: "hidden" });
  });

  await t.test("with the helper active, logging in still works as before", async () => {
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await env.login(page, "amina@test.invalid");
    await page.waitForURL(/discover\.html$/);
    await page.waitForFunction(() => /Showing|no other approved/i.test(document.getElementById("status").textContent));
    await page.goto(env.base + "login.html?source=app");
    await page.waitForURL(/discover\.html$/, { timeout: 15000 });
  });

  await t.test("offline shows a friendly page, and pages load normally again once back online", async () => {
    env.setSiteDown(true);
    await page.goto(env.base + "about.html").catch(() => {});
    await page.waitForFunction(() => /You are offline/.test(document.body.textContent));
    assert.equal(await page.$eval("a.retry", a => a.getAttribute("href")), "", "Try again reopens the same page");
    env.setSiteDown(false);
    await page.click("a.retry");
    await page.waitForFunction(() => /^About us/.test(document.title), null, { timeout: 15000 });
    await page.goto(env.base + "login.html");
    await page.waitForURL(/discover\.html$/, { timeout: 15000 });
  });
});
