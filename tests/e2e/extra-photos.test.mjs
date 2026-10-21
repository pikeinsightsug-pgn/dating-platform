// Members add up to 6 extra photos; approved members swipe through them in Discover; pending
// members, visitors and the owner's test accounts cannot see them; the owner can remove one.
// Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile, SUPABASE, PNG, confirmCrop } from "./harness.mjs";
import { TEST_SERVICE_KEY } from "./gateway.mjs";
import { loadAdminFunction } from "./edge-runtime.mjs";

const OWNER = "owner@test.invalid";

test("extra profile photos", async (t) => {
  const env = await setup("e2e_extra_photos");
  t.after(() => env.close());
  env.gateway.options.adminFunction = await loadAdminFunction({
    SUPABASE_URL: env.gateway.url, SUPABASE_ANON_KEY: "anon-test", SUPABASE_SERVICE_ROLE_KEY: TEST_SERVICE_KEY, ADMIN_EMAIL: OWNER
  });
  await env.sql("insert into auth.users (email, email_confirmed_at) values ($1, now())", [OWNER]);
  env.gateway.passwords.set(OWNER, "Owner-pass-123");
  await env.member("alp@test.invalid", profile("Alp", { age: 40, gender: "Man", location: "Botswana" }), { approved: true });
  await env.sql("update public.members set is_test_account = true");
  await env.member("amina@test.invalid", profile("Amina", { age: 29, gender: "Woman", location: "Uganda" }), { approved: true });
  await env.member("kabo@test.invalid", profile("Kabo", { age: 34, gender: "Man", location: "Botswana", city: "Gaborone" }), { approved: true });
  await env.member("pendo@test.invalid", profile("Pendo", { age: 30, gender: "Man" }), { approved: false });
  const ids = async () => Object.fromEntries((await env.sql("select first_name, id from public.members")).rows.map(r => [r.first_name, r.id]));
  const extraRows = async () => (await env.sql("select count(*)::int n from public.member_photos mp join public.members m on m.id = mp.member_id where m.first_name = 'Amina'")).rows[0].n;
  const loaded = img => img.evaluate(i => new Promise(r => i.complete ? r(i.naturalWidth > 0) : (i.onload = () => r(i.naturalWidth > 0), i.onerror = () => r(false))));

  const amina = await env.newPage({ mobile: true });
  await env.login(amina, "amina@test.invalid");
  await amina.waitForURL(/discover\.html$/);
  await amina.goto(env.base + "dashboard.html");
  await amina.waitForSelector("#extra-photos:not(.hidden)");

  await t.test("a member adds a profile photo and two extra photos, and they stay after reload", async () => {
    await amina.setInputFiles("#photo-file", { name: "main.png", mimeType: "image/png", buffer: PNG });
    await confirmCrop(amina);
    await amina.click("#upload-photo");
    await amina.waitForFunction(() => /has been saved/.test(document.getElementById("photo-status").textContent));
    for (const name of ["beach.png", "family.png"]) {
      await amina.setInputFiles("#extra-file", { name, mimeType: "image/png", buffer: PNG });
      await confirmCrop(amina);
      await amina.waitForFunction(() => /has been added/.test(document.getElementById("extra-status").textContent));
    }
    await amina.reload();
    await amina.waitForFunction(() => document.querySelectorAll("#extra-grid img").length === 2);
    for (const img of await amina.locator("#extra-grid img").all()) assert.ok(await loaded(img), "each extra photo shows");
    assert.equal(await extraRows(), 2);
  });

  await t.test("an approved member swipes through all three photos in Discover", async () => {
    const kabo = await env.newPage();
    await env.login(kabo, "kabo@test.invalid");
    await kabo.waitForURL(/discover\.html$/);
    await kabo.getByRole("button", { name: "View profile of Amina" }).click();
    await kabo.waitForFunction(() => document.getElementById("photo-count").textContent === "1 / 3");
    assert.equal(await kabo.locator("#dialog-thumbs button").count(), 3);
    await kabo.click("#photo-next");
    assert.equal(await kabo.textContent("#photo-count"), "2 / 3");
    assert.ok(await loaded(kabo.locator("#dialog-photo img")), "the extra photo shows");
    await kabo.locator("#dialog-thumbs button").nth(2).click();
    assert.equal(await kabo.textContent("#photo-count"), "3 / 3");
    assert.equal(await kabo.isVisible("#photo-next"), false, "no next arrow on the last photo");
    await kabo.click("#photo-prev");
    assert.equal(await kabo.textContent("#photo-count"), "2 / 3");
  });

  await t.test("pending members, visitors and test accounts cannot see the extra photos", async () => {
    const { Amina } = await ids();
    const paths = (await env.sql("select storage_path from public.member_photos")).rows.map(r => r.storage_path);
    const peek = async page => page.evaluate(async ({ id, paths }) => {
      const db = window.FYP.createClient();
      const list = await db.rpc("get_member_photos", { p_member_id: id });
      const signed = await db.storage.from("profile-photos").createSignedUrls(paths, 60);
      return { listed: (list.data || []).length, files: (signed.data || []).filter(s => s.signedUrl).length };
    }, { id: Amina, paths });
    const alp = await env.newPage();
    await env.login(alp, "alp@test.invalid"); await alp.waitForURL(/discover\.html$/);
    assert.deepEqual(await peek(alp), { listed: 0, files: 2 }, "a test account is not given the list (it could only open files it already knew the private address of)");
    const pendo = await env.newPage();
    await env.login(pendo, "pendo@test.invalid"); await pendo.waitForURL(/dashboard\.html$/);
    assert.deepEqual(await peek(pendo), { listed: 0, files: 0 }, "a pending member sees nothing");
    const visitor = await env.newPage();
    await visitor.goto(env.base + "login.html");
    assert.deepEqual(await peek(visitor), { listed: 0, files: 0 }, "a visitor sees nothing");
  });

  await t.test("the member removes an extra photo; at 6 photos the add button is hidden", async () => {
    await amina.getByRole("button", { name: "Remove extra photo 1" }).click();
    await amina.waitForFunction(() => /removed/.test(document.getElementById("extra-status").textContent));
    await amina.waitForFunction(() => document.querySelectorAll("#extra-grid img").length === 1);
    assert.equal(await extraRows(), 1);
    assert.equal((await env.sql("select count(*)::int n from storage.objects o join public.members m on (storage.foldername(o.name))[1] = m.user_id::text where m.first_name = 'Amina'")).rows[0].n, 2,
      "the removed file is deleted; the profile photo and the other extra photo remain");

    const { Amina } = await ids();
    const owner = (await env.sql("select user_id from public.members where id = $1", [Amina])).rows[0].user_id;
    for (let i = 0; i < 5; i++) {
      const path = `${owner}/${crypto.randomUUID()}.jpg`;
      await env.sql("insert into storage.objects (bucket_id, name, owner) values ('profile-photos', $1, $2)", [path, owner]);
      await env.sql("insert into public.member_photos (member_id, storage_path) values ($1, $2)", [Amina, path]);
    }
    await amina.reload();
    await amina.waitForFunction(() => document.querySelectorAll("#extra-grid figure").length === 6);
    assert.equal(await amina.isVisible("#extra-add"), false);
    assert.match(await amina.textContent("#extra-status"), /6 extra photos/);
  });

  await t.test("the owner removes an extra photo from the approval console", async () => {
    const page = await env.newPage();
    await page.goto(env.base + "admin/");
    await page.fill("#project", SUPABASE); await page.fill("#anon", "sb_publishable_test");
    await page.fill("#email", OWNER); await page.fill("#password", "Owner-pass-123");
    await page.click("#signin");
    await page.waitForFunction(() => /Loaded \d+ profiles/.test(document.getElementById("status").textContent));
    const card = page.locator("#members article.member").filter({ has: page.locator("h3", { hasText: "Amina" }) });
    assert.equal(await card.getByRole("button", { name: "Remove photo" }).count(), 6);
    await card.getByRole("button", { name: "Remove photo" }).first().click();
    await page.waitForFunction(() => /Photo removed/.test(document.getElementById("status").textContent));
    assert.equal(await extraRows(), 5);
    assert.equal((await env.sql("select approved from public.members where first_name = 'Amina'")).rows[0].approved, true, "approval is untouched");
    assert.match(await page.textContent("#function-version"), /up to date/);
  });
});
