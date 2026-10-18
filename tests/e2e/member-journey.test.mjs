// Browser journeys through the real pages and the real supabase-js library. Supabase is
// replaced by tests/e2e/gateway.mjs on a local Postgres with the checked-in migrations, so
// this proves the site and the SQL work together — not that the live project is configured.
//
// Needs a local Postgres superuser (PGHOST/PGPORT/PGUSER) and Playwright's Chromium.
// Synthetic accounts only.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile, ALL, PNG } from "./harness.mjs";

test("browser journeys on the full migration set", async (t) => {
  const env = await setup("e2e_full");
  t.after(() => env.close());

  await t.test("MANDATORY 1: a new member registers, confirms, logs out and back in without recreating the profile", async () => {
    const page = await env.newPage({ mobile: true });
    await env.fillRegistration(page, { name: "NewTester", email: "new-member@test.invalid", age: "27", location: "Botswana", city: "Gaborone" });
    await page.click("#register-form button[type=submit]");
    await page.waitForSelector("#success-view:not(.hidden)");
    assert.match(await page.textContent("#success-message"), /new-member@test\.invalid/);
    await page.click("#success-view a[href='login.html']");
    await page.waitForURL(/login\.html$/);

    // Logging in before confirming gives a clear message and a resend option.
    await page.fill("#login-email", "new-member@test.invalid");
    await page.fill("#login-password", "Test-pass-123");
    await page.click("#login-form button[type=submit]");
    await page.waitForFunction(() => /confirm your email/i.test(document.getElementById("status").textContent));
    assert.equal(await page.isVisible("#resend-confirmation"), true);

    await env.sql("update auth.users set email_confirmed_at = now() where email = 'new-member@test.invalid'");
    await page.click("#login-form button[type=submit]");
    await page.waitForURL(/dashboard\.html$/);
    await page.waitForSelector("#profile-panel:not(.hidden)");
    assert.equal(await page.inputValue("[name=city]"), "Gaborone");
    assert.match(await page.textContent("#approval-status"), /awaiting manual review/);

    await page.reload();
    await page.waitForSelector("#profile-panel:not(.hidden)");
    assert.equal(await page.inputValue("[name=first_name]"), "NewTester", "session and profile survive a refresh");

    await page.fill("[name=interests]", "Hiking, cooking");
    await page.click("#save-profile");
    await page.waitForFunction(() => /has been saved/.test(document.getElementById("status").textContent));

    await page.click("#signout");
    await page.waitForURL(/login\.html\?signedout=1$/);
    assert.equal(await page.isVisible("#signed-out"), true, "a clear logged-out confirmation");
    await env.login(page, "new-member@test.invalid");
    await page.waitForURL(/dashboard\.html$/);
    await page.waitForSelector("#profile-panel:not(.hidden)");
    assert.equal(await page.inputValue("[name=interests]"), "Hiking, cooking");
    const rows = await env.sql("select count(*)::int as n, bool_and(not approved) as pending from public.members m join auth.users u on u.id = m.user_id where u.email = 'new-member@test.invalid'");
    assert.deepEqual(rows.rows[0], { n: 1, pending: true }, "exactly one pending profile");
  });

  await t.test("a confirmed signup whose profile the trigger did not create is healed at login (no recovery screen)", async () => {
    const id = (await env.sql("insert into auth.users (email, raw_user_meta_data) values ('heal@test.invalid', $1) returning id", [profile("Healer")])).rows[0].id;
    // Simulate a project where the confirmation trigger was missing when this person confirmed.
    await env.sql("alter table auth.users disable trigger create_member_profile_after_auth_confirmation");
    await env.sql("update auth.users set email_confirmed_at = now() where id = $1", [id]);
    await env.sql("alter table auth.users enable trigger create_member_profile_after_auth_confirmation");
    env.gateway.passwords.set("heal@test.invalid", "Test-pass-123");
    const page = await env.newPage();
    await env.login(page, "heal@test.invalid");
    await page.waitForURL(/dashboard\.html$/);
    await page.waitForSelector("#profile-panel:not(.hidden)");
    assert.equal((await env.sql("select count(*)::int as n from public.members where user_id = $1", [id])).rows[0].n, 1);
  });

  await t.test("MANDATORY 7: the first approved member sees a helpful empty discovery message", async () => {
    await env.member("solo@test.invalid", profile("Solo"), { approved: true });
    const page = await env.newPage();
    await env.login(page, "solo@test.invalid");
    await page.waitForURL(/discover\.html$/);
    await page.waitForFunction(() => /no other approved member profiles yet/i.test(document.getElementById("status").textContent));
    assert.equal(await page.locator("#profiles .card").count(), 0);
  });

  await t.test("MANDATORY 2 + 3: existing approved members land on discovery and find each other, never themselves", async () => {
    await env.member("alpha@test.invalid", profile("Alpha", { location: "Uganda", age: 29 }), { approved: true });
    await env.member("bravo@test.invalid", profile("Bravo", { gender: "Man", location: "Botswana", city: "Maun", age: 41, relationship_goal: "Friendship" }), { approved: true });
    await env.member("pending@test.invalid", profile("Pending"));
    await env.sql("insert into public.members (first_name, age, gender, location, city, relationship_goal, bio, email, phone, approved) values ('LegacyOnly', 33, 'Woman', 'Uganda', 'Gulu', 'Marriage', 'legacy', 'legacy@test.invalid', '+256700000000', true)");

    const alpha = await env.newPage({ mobile: true });
    await env.login(alpha, "alpha@test.invalid");
    await alpha.waitForURL(/discover\.html$/);
    await alpha.waitForSelector("#profiles .card");
    const names = await alpha.locator("#profiles .card h2").allTextContents();
    assert.ok(names.includes("Bravo, 41"), "Alpha discovers Bravo");
    assert.ok(names.includes("Solo, 30"));
    assert.ok(!names.some(n => n.startsWith("Alpha")), "Alpha is not in their own list");
    assert.ok(!names.some(n => /Pending|LegacyOnly/.test(n)), "pending and account-less legacy rows are hidden");
    assert.doesNotMatch(await alpha.content(), /legacy@test\.invalid|\+256700000000/);
    const width = await alpha.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 390, "no horizontal scrolling on a phone-sized screen");

    await alpha.selectOption("#filters [name=country]", "Botswana");
    await alpha.click("#filters button[type=submit]");
    await alpha.waitForFunction(() => document.querySelectorAll("#profiles .card").length === 1);
    assert.deepEqual(await alpha.locator("#profiles .card h2").allTextContents(), ["Bravo, 41"]);
    await alpha.fill("#filters [name=min_age]", "50");
    await alpha.click("#filters button[type=submit]");
    await alpha.waitForFunction(() => /No approved members match these filters/.test(document.getElementById("status").textContent));

    const bravo = await env.newPage();
    await env.login(bravo, "bravo@test.invalid");
    await bravo.waitForURL(/discover\.html$/);
    await bravo.waitForSelector("#profiles .card");
    const bravoSees = await bravo.locator("#profiles .card h2").allTextContents();
    assert.ok(bravoSees.includes("Alpha, 29"), "Bravo discovers Alpha");
    assert.ok(!bravoSees.some(n => n.startsWith("Bravo")));
  });

  await t.test("profile details open, and two members can exchange private messages", async () => {
    const alpha = await env.newPage();
    await env.login(alpha, "alpha@test.invalid");
    await alpha.waitForSelector("#profiles .card");
    await alpha.locator("#profiles .card", { hasText: "Bravo" }).locator("button.open").click();
    await alpha.waitForSelector("#profile-dialog[open]");
    assert.match(await alpha.textContent("#dialog-text"), /Friendship/);
    await alpha.click("#dialog-message");
    await alpha.waitForURL(/messages\.html\?member=/);
    await alpha.waitForSelector("#compose:not(.hidden)");
    await alpha.fill("#body", "Hello Bravo, nice to meet you.");
    await alpha.click("#compose button[type=submit]");
    await alpha.waitForSelector(".bubble.mine");

    const bravo = await env.newPage({ mobile: true });
    await env.login(bravo, "bravo@test.invalid");
    await bravo.waitForURL(/discover\.html$/);
    await bravo.goto(env.base + "messages.html");
    await bravo.waitForSelector("#conversations button .badge");
    assert.equal(await bravo.textContent("#conversations button .badge"), "1");
    await bravo.click("#conversations button");
    await bravo.waitForSelector(".bubble.theirs");
    assert.match(await bravo.textContent(".bubble.theirs"), /Hello Bravo/);
    await bravo.fill("#body", "Hi Alpha!");
    await bravo.click("#compose button[type=submit]");
    await bravo.waitForFunction(() => document.querySelectorAll(".bubble").length === 2);

    // Alpha reads the reply after reopening the conversation (it comes from the database).
    await alpha.reload();
    await alpha.waitForSelector(".bubble.theirs");
    assert.match(await alpha.textContent(".bubble.theirs"), /Hi Alpha!/);
    const stored = await env.sql("select count(*)::int as n from public.member_messages");
    assert.equal(stored.rows[0].n, 2, "both messages are saved in the database");
    for (const page of [alpha, bravo]) {
      const local = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
      assert.doesNotMatch(local, /Hello Bravo|Hi Alpha/, "message text is not kept in browser storage");
    }
  });

  await t.test("MANDATORY 6: a non-participant cannot read the conversation, even by calling the API directly", async () => {
    const solo = await env.newPage();
    await env.login(solo, "solo@test.invalid");
    await solo.waitForURL(/discover\.html$/);
    const alphaId = (await env.sql("select m.id from public.members m join auth.users u on u.id = m.user_id where u.email = 'alpha@test.invalid'")).rows[0].id;
    const result = await solo.evaluate(async other => {
      const db = window.FYP.createClient();
      const convo = await db.rpc("get_conversation", { p_other_member_id: other });
      const table = await db.from("member_messages").select("body");
      const members = await db.from("members").select("first_name,user_id");
      const approve = await db.from("members").update({ approved: true }).eq("first_name", "Pending").select("id");
      return { convo: convo.data, table: table.data, tableError: table.error && table.error.code, members: members.data, approve: approve.error && approve.error.code };
    }, alphaId);
    assert.deepEqual(result.convo, []);
    assert.deepEqual(result.table, []);
    assert.deepEqual(result.members.map(m => m.first_name), ["Solo"], "only their own profile row is readable");
    assert.equal(result.approve, "42501", "members cannot approve anyone");
    await solo.goto(env.base + "messages.html");
    await solo.waitForFunction(() => /No conversations yet/.test(document.body.textContent));
  });

  await t.test("blocking hides members from each other and reporting reaches the owner queue", async () => {
    const alpha = await env.newPage();
    await env.login(alpha, "alpha@test.invalid");
    await alpha.waitForSelector("#profiles .card");
    await alpha.locator("#profiles .card", { hasText: "Solo" }).locator("button.open").click();
    await alpha.click("#dialog-report-toggle");
    await alpha.selectOption("#report-form [name=reason]", "Fake profile");
    await alpha.click("#report-form button[type=submit]");
    await alpha.waitForFunction(() => /owner will review/.test(document.getElementById("dialog-status").textContent));
    await alpha.click("#dialog-block");
    await alpha.waitForFunction(() => ![...document.querySelectorAll("#profiles .card h2")].some(h => h.textContent.startsWith("Solo")) && document.querySelectorAll("#profiles .card").length > 0);
    assert.equal((await env.sql("select count(*)::int as n from public.member_reports where status = 'open'")).rows[0].n, 1);
  });

  await t.test("MANDATORY 5: photo upload completes, including Android files with no MIME type, and failures never spin", async () => {
    const page = await env.newPage({ mobile: true });
    await env.login(page, "alpha@test.invalid");
    await page.waitForURL(/discover\.html$/);
    await page.goto(env.base + "dashboard.html");
    await page.waitForSelector("#profile-panel:not(.hidden)");
    // Some Android pickers hand over files with an empty MIME type. Playwright's setInputFiles
    // would infer one from the name, so build the File in the page.
    await page.evaluate(bytes => {
      const file = new File([new Uint8Array(bytes)], "IMG_0001.jpg", { type: "" });
      const transfer = new DataTransfer(); transfer.items.add(file);
      const input = document.getElementById("photo-file");
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, [...PNG]);
    assert.equal(await page.evaluate(() => document.getElementById("photo-file").files[0].type), "");
    await page.click("#upload-photo");
    await page.waitForFunction(() => /has been saved/.test(document.getElementById("photo-status").textContent));
    const stored = (await env.sql("select m.profile_photo_url from public.members m join auth.users u on u.id = m.user_id where u.email = 'alpha@test.invalid'")).rows[0].profile_photo_url;
    assert.ok(stored && stored.endsWith(".jpg"));
    assert.equal(await page.isVisible("#photo-preview"), true);

    env.gateway.options.failUploads = [400, { statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" }];
    await page.setInputFiles("#photo-file", { name: "second.png", mimeType: "image/png", buffer: PNG });
    await page.click("#upload-photo");
    await page.waitForFunction(() => /denied this photo upload/.test(document.getElementById("photo-status").textContent));
    assert.equal(await page.textContent("#upload-photo"), "Upload photo", "the button resets after a failure");
    assert.equal(await page.isEnabled("#upload-photo"), true, "the member can retry");
    env.gateway.options.failUploads = null;
    await page.click("#upload-photo");
    await page.waitForFunction(() => /has been saved/.test(document.getElementById("photo-status").textContent));

    const bravo = await env.newPage();
    await env.login(bravo, "bravo@test.invalid");
    await bravo.waitForSelector("#profiles .card");
    const card = bravo.locator("#profiles .card", { hasText: "Alpha" });
    await card.locator("img.photo").waitFor();
    assert.equal(await card.locator("img.photo").evaluate(img => img.complete && img.naturalWidth > 0), true, "Bravo sees Alpha's private photo");
  });

  await t.test("a large phone photo (over 5 MB) is resized to a JPEG under the bucket limit and uploads", async () => {
    const page = await env.newPage({ mobile: true });
    await env.login(page, "bravo@test.invalid");
    await page.waitForURL(/discover\.html$/);
    await page.goto(env.base + "dashboard.html");
    await page.waitForSelector("#profile-panel:not(.hidden)");
    const originalSize = await page.evaluate(async () => {
      const canvas = document.createElement("canvas"); canvas.width = 3000; canvas.height = 2400;
      const ctx = canvas.getContext("2d"); const img = ctx.createImageData(3000, 2400);
      for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 2654435761) >>> 24;
      ctx.putImageData(img, 0, 0);
      const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
      const transfer = new DataTransfer(); transfer.items.add(new File([blob], "camera.png", { type: "image/png" }));
      const input = document.getElementById("photo-file"); input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return blob.size;
    });
    assert.ok(originalSize > 5 * 1024 * 1024, "fixture is larger than the 5 MB bucket limit (" + originalSize + ")");
    await page.click("#upload-photo");
    await page.waitForFunction(() => /has been saved/.test(document.getElementById("photo-status").textContent), null, { timeout: 60000 });
    const stored = (await env.sql("select m.profile_photo_url from public.members m join auth.users u on u.id = m.user_id where u.email = 'bravo@test.invalid'")).rows[0].profile_photo_url;
    assert.ok(stored.endsWith(".jpg"), "re-encoded as JPEG");
  });

  await t.test("pending members see their own profile with clear review guidance and cannot browse or message", async () => {
    const page = await env.newPage();
    await env.login(page, "pending@test.invalid");
    await page.waitForURL(/dashboard\.html$/);
    await page.goto(env.base + "discover.html");
    await page.waitForFunction(() => /awaiting manual review/.test(document.getElementById("status").textContent));
    assert.equal(await page.locator("#profiles .card").count(), 0);
    await page.goto(env.base + "messages.html");
    await page.waitForFunction(() => /opens once the platform owner approves/.test(document.getElementById("status").textContent));
  });

  await t.test("MANDATORY 4: an account with no linked registration gets recovery guidance, not a loop or a new profile", async () => {
    await env.member("invited-legacy@test.invalid", {});
    const page = await env.newPage();
    await env.login(page, "invited-legacy@test.invalid");
    await page.waitForURL(/dashboard\.html\?profile=recovery$/);
    await page.waitForSelector("#recovery-panel:not(.hidden)");
    assert.match(await page.textContent("#recovery-account"), /invited-legacy@test\.invalid/);
    await page.goto(env.base + "discover.html");
    await page.waitForURL(/dashboard\.html\?profile=recovery$/);
    await page.waitForTimeout(500);
    assert.match(page.url(), /dashboard\.html\?profile=recovery$/, "stays put — no redirect loop");
    assert.equal((await env.sql("select count(*)::int as n from public.members where first_name = 'LegacyOnly'")).rows[0].n, 1, "legacy row untouched");
    assert.equal((await env.sql("select count(*)::int as n from public.members m join auth.users u on u.id = m.user_id where u.email = 'invited-legacy@test.invalid'")).rows[0].n, 0, "no profile was invented");
  });

  await t.test("signed-out visitors are sent to login from every member page", async () => {
    const page = await env.newPage();
    for (const path of ["dashboard.html", "discover.html", "messages.html"]) {
      await page.goto(env.base + path);
      await page.waitForURL(/login\.html$/);
    }
  });
});

test("before discovery_messaging_safety.sql is applied, discovery still works through the earlier function", async (t) => {
  const env = await setup("e2e_previous", ALL.slice(0, 3));
  t.after(() => env.close());
  await env.member("old-a@test.invalid", profile("OldA"), { approved: true });
  await env.member("old-b@test.invalid", profile("OldB"), { approved: true });
  const page = await env.newPage();
  await env.login(page, "old-a@test.invalid");
  await page.waitForURL(/discover\.html$/);
  await page.waitForSelector("#profiles .card");
  assert.deepEqual(await page.locator("#profiles .card h2").allTextContents(), ["OldB, 30"]);
  assert.equal(await page.isVisible("#filters"), false);
});

test("when only the old 100-member discovery function is live, the page names the fix", async (t) => {
  const env = await setup("e2e_oldest", ALL.slice(0, 2));
  t.after(() => env.close());
  await env.member("oldest@test.invalid", profile("Oldest"), { approved: true });
  const page = await env.newPage();
  await env.login(page, "oldest@test.invalid");
  await page.waitForURL(/discover\.html$/);
  await page.waitForFunction(() => /waits for 100 approved members[\s\S]*ambiguous/.test(document.getElementById("status").textContent));
});
