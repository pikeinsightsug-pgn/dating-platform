// Profile photo changes must always finish: saved and shown, or a clear message with the button
// reset. Covers browsers without crypto.randomUUID and a request that never answers.
// Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile, PNG, confirmCrop } from "./harness.mjs";

test("profile photo changes never spin forever", async (t) => {
  const env = await setup("e2e_photo_reliability");
  t.after(() => env.close());
  await env.member("ruth@test.invalid", profile("Ruth"), { approved: true });
  await env.member("sam@test.invalid", profile("Sam", { gender: "Man", location: "Botswana" }), { approved: true });
  const savedPath = async () => (await env.sql("select profile_photo_url from public.members where first_name = 'Ruth'")).rows[0].profile_photo_url;
  const openProfile = async page => {
    await env.login(page, "ruth@test.invalid");
    await page.waitForURL(/discover\.html$/);
    await page.goto(env.base + "dashboard.html");
    await page.waitForSelector("#profile-panel:not(.hidden)");
  };
  const choosePhoto = async (page, name) => {
    await page.setInputFiles("#photo-file", { name, mimeType: "image/png", buffer: PNG });
    await confirmCrop(page);
  };

  await t.test("a browser without crypto.randomUUID (older Android, in-app browsers) saves the photo", async () => {
    const page = await env.newPage({ mobile: true });
    await page.addInitScript(() => { Object.defineProperty(window.crypto, "randomUUID", { value: undefined, configurable: true }); });
    await openProfile(page);
    assert.equal(await page.evaluate(() => typeof crypto.randomUUID), "undefined");
    await choosePhoto(page, "first.png");
    await page.click("#upload-photo");
    await page.waitForFunction(() => /has been saved/.test(document.getElementById("photo-status").textContent));
    const path = await savedPath();
    assert.match(path, /^[0-9a-f-]{36}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/, "stored in the member's own folder with a valid random name");
    await page.reload();
    await page.waitForSelector("#photo-preview:not(.hidden)");
  });

  await t.test("an upload that never answers stops with a clear message, then a retry replaces the photo", async () => {
    const before = await savedPath();
    const page = await env.newPage({ mobile: true });
    await page.addInitScript(() => { window.FYP_PHOTO_TIMEOUT_MS = 1500; });
    await openProfile(page);
    let hold = true;
    await page.route(/\/storage\/v1\/object\/profile-photos\//, route => {
      if (hold && route.request().method() === "POST") return; // never answered
      return route.fallback();
    });
    await choosePhoto(page, "second.png");
    await page.click("#upload-photo");
    assert.equal(await page.textContent("#upload-photo"), "Uploading…");
    await page.waitForFunction(() => /taking too long/.test(document.getElementById("photo-status").textContent), null, { timeout: 5000 });
    assert.equal(await page.textContent("#upload-photo"), "Upload photo", "the spinner stops");
    assert.equal(await page.getAttribute("#upload-photo", "aria-busy"), null);
    assert.equal(await page.isEnabled("#upload-photo"), true, "the member can retry");
    assert.equal(await savedPath(), before, "nothing half-saved");

    hold = false;
    await page.click("#upload-photo");
    await page.waitForFunction(() => /has been saved/.test(document.getElementById("photo-status").textContent));
    const after = await savedPath();
    assert.notEqual(after, before, "the photo was replaced");

    // The new photo persists after signing out and in, and another member still sees it.
    await page.click("#signout"); await page.waitForURL(/signedout=1/);
    await openProfile(page);
    await page.waitForSelector("#photo-preview:not(.hidden)");
    const sam = await env.newPage();
    await env.login(sam, "sam@test.invalid");
    await sam.waitForSelector("#profiles .card");
    const img = sam.locator("#profiles .card", { hasText: "Ruth" }).locator("img.photo");
    await img.waitFor();
    assert.ok(await img.evaluate(i => new Promise(r => i.complete ? r(i.naturalWidth > 0) : i.onload = () => r(i.naturalWidth > 0))));
  });
});
