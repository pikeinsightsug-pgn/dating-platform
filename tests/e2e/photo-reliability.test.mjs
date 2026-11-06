// Profile photo changes must always finish: saved and shown, or a clear message with the button
// reset. Covers browsers without crypto.randomUUID and a request that never answers.
// Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile, PNG, confirmCrop } from "./harness.mjs";

// 80x60 JPEG stored sideways (EXIF orientation 6) with a red block at its stored top-left.
const SIDEWAYS_JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAA8AFADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDxqiu3/wCFG/Ej/on3in/wS3P/AMRR/wAKN+JH/RPvFP8A4Jbn/wCIr5Tkl2P7p/tDB/8AP6P/AIEv8z6l/wCCan/NRv8AuG/+3VfblfH3/BPnwN4k8F/8J7/wkPh/VdC+0/YPI/tOykt/N2/ad23eo3Y3LnHTI9a+wa+gwqaoxT/rU/lDjipCrxBiZ05Jp8mq1XwRCiiius+FCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA//9k=";

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

  await t.test("a very large phone photo is opened small (no low-memory crash) and the right way up", async () => {
    const page = await env.newPage({ mobile: true });
    await page.goto(env.base + "account.html");
    const result = await page.evaluate(async sideways => {
      const asked = [];
      const Real = window.ImageDecoder;
      window.ImageDecoder = class extends Real { constructor(init) { asked.push(init.desiredWidth + "x" + init.desiredHeight); super(init); } };
      // A 27 MP camera photo with an empty type, as Android file pickers often give.
      // Grainy like a real photo, so the file is several MB (small files are uploaded unchanged).
      const canvas = new OffscreenCanvas(6000, 4500), ctx = canvas.getContext("2d");
      const grain = new ImageData(500, 500);
      for (let i = 0; i < grain.data.length; i++) grain.data[i] = (i & 3) === 3 ? 255 : Math.random() * 255;
      for (let y = 0; y < 4500; y += 500) for (let x = 0; x < 6000; x += 500) ctx.putImageData(grain, x, y);
      const big = new File([await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })], "IMG_2001.jpg", { type: "" });
      const opened = await window.FYP.decodeImage(big);
      const prepared = await createImageBitmap((await window.FYP.preparePhoto(big)).blob);
      // Stored 80x60 with EXIF "rotate 90°" and a red block at the stored top-left: upright it is
      // 60x80 with the block at the top-right.
      const turned = await window.FYP.decodeImage(new File([Uint8Array.from(atob(sideways), c => c.charCodeAt(0))], "side.jpg", { type: "image/jpeg" }));
      const c = new OffscreenCanvas(turned.width, turned.height); const x = c.getContext("2d"); x.drawImage(turned, 0, 0);
      const red = (px, py) => x.getImageData(px, py, 1, 1).data[1] < 80;
      return { asked: asked.length, opened: opened.width + "x" + opened.height, prepared: prepared.width + "x" + prepared.height,
        turned: turned.width + "x" + turned.height, topRight: red(turned.width - 3, 3), topLeft: red(3, 3) };
    }, SIDEWAYS_JPEG);
    assert.ok(result.asked >= 2, "photos are read at a reduced size by the image decoder");
    assert.equal(result.opened, "2400x1800", "a big photo is never held at full size");
    assert.equal(result.prepared, "1600x1200", "the uploaded copy keeps the usual size");
    assert.deepEqual([result.turned, result.topRight, result.topLeft], ["60x80", true, false], "a sideways-stored photo stays upright");
  });
});

