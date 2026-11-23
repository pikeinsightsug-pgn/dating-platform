// Small photos: a new profile photo gets a small copy, Discover cards use it, and the owner
// console makes small copies for older photos. Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile, ALL, SUPABASE, PNG, confirmCrop } from "./harness.mjs";
import { TEST_SERVICE_KEY } from "./gateway.mjs";
import { loadAdminFunction } from "./edge-runtime.mjs";

const FILES = [...ALL, "supabase/smart_discovery.sql", "supabase/question_of_the_day.sql", "supabase/likes_and_matches.sql",
  "supabase/safety_protection.sql", "supabase/photo_thumbnails.sql"];
const OWNER = "owner@test.invalid";

test("small photos", async (t) => {
  const env = await setup("e2e_thumbs", FILES);
  t.after(() => env.close());
  env.gateway.options.adminFunction = await loadAdminFunction({
    SUPABASE_URL: env.gateway.url, SUPABASE_ANON_KEY: "anon-test", SUPABASE_SERVICE_ROLE_KEY: TEST_SERVICE_KEY, ADMIN_EMAIL: OWNER
  });
  await env.sql("insert into auth.users (email, email_confirmed_at) values ($1, now())", [OWNER]);
  env.gateway.passwords.set(OWNER, "Owner-pass-123");
  await env.member("ruth@test.invalid", profile("Ruth"), { approved: true });
  await env.member("amy@test.invalid", profile("Amy"), { approved: true });
  await env.member("sam@test.invalid", profile("Sam", { gender: "Man", location: "Botswana" }), { approved: true });
  const thumbs = async () => (await env.sql("select name from storage.objects where name like '%/thumb\\_%' order by name")).rows.map(r => r.name);
  const photoOf = async name => (await env.sql("select profile_photo_url from public.members where first_name = $1", [name])).rows[0].profile_photo_url;
  const thumbOf = path => path.replace(/\/([^/]*?)(\.[^./]*)?$/, "/thumb_$1.jpg");

  async function uploadPhoto(email) {
    const page = await env.newPage({ mobile: true });
    await env.login(page, email);
    await page.waitForURL(/discover\.html$/);
    await page.goto(env.base + "dashboard.html");
    await page.waitForSelector("#profile-panel:not(.hidden)");
    await page.setInputFiles("#photo-file", { name: "me.png", mimeType: "image/png", buffer: PNG });
    await confirmCrop(page);
    await page.click("#upload-photo");
    await page.waitForFunction(() => /has been saved/.test(document.getElementById("photo-status").textContent));
    return page;
  }

  // A new photo gets its small copy straight away.
  const ruthPage = await uploadPhoto("ruth@test.invalid");
  const ruthPhoto = await photoOf("Ruth");
  for (let i = 0; i < 50 && !(await thumbs()).includes(thumbOf(ruthPhoto)); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok((await thumbs()).includes(thumbOf(ruthPhoto)), "the small copy is saved next to the photo");
  await ruthPage.close();

  // Amy's photo is "old": its small copy does not exist yet.
  const amyPage = await uploadPhoto("amy@test.invalid");
  await amyPage.close();
  const amyPhoto = await photoOf("Amy");
  await new Promise(r => setTimeout(r, 500));
  await env.sql("delete from storage.objects where name = $1", [thumbOf(amyPhoto)]);

  // Sam's Discover cards: Ruth's card uses the small copy, Amy's falls back to the full photo.
  const sam = await env.newPage();
  await env.login(sam, "sam@test.invalid");
  await sam.waitForURL(/discover\.html$/);
  await sam.waitForSelector("#profiles .card img.photo");
  const srcs = await sam.$$eval("#profiles .card img.photo", imgs => imgs.map(i => i.getAttribute("src")));
  assert.ok(srcs.some(s => s.includes(encodeURI(thumbOf(ruthPhoto)).split("/").pop())), "Ruth's card shows her small photo");
  assert.ok(srcs.some(s => s.includes(amyPhoto.split("/").pop())), "Amy's card falls back to her full photo");

  // The owner makes the missing small copies in one click.
  const owner = await env.newPage();
  await owner.goto(env.base + "admin/");
  await owner.fill("#project", SUPABASE); await owner.fill("#anon", "sb_publishable_test");
  await owner.fill("#email", OWNER); await owner.fill("#password", "Owner-pass-123");
  await owner.click("#signin");
  await owner.waitForFunction(() => /Loaded \d+ profiles/.test(document.getElementById("status").textContent));
  await owner.click("#make-thumbs");
  await owner.waitForFunction(() => /Done: made 1 small photos/.test(document.getElementById("thumbs-status").textContent));
  assert.ok((await thumbs()).includes(thumbOf(amyPhoto)), "the owner console made Amy's small copy");
  await owner.click("#make-thumbs");
  await owner.waitForFunction(() => /already have a small copy/.test(document.getElementById("thumbs-status").textContent));
});
