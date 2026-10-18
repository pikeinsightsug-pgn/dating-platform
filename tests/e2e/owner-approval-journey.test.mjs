// A new member stays pending until the owner approves them in the owner console; then
// discovery, photo upload and two-way messaging work. Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile, SUPABASE, PNG } from "./harness.mjs";
import { TEST_SERVICE_KEY } from "./gateway.mjs";
import { loadAdminFunction } from "./edge-runtime.mjs";

const OWNER = "owner@test.invalid";

test("Daniel: pending until the owner approves, then discovery, photo and two-way messaging", async (t) => {
  const env = await setup("e2e_daniel");
  t.after(() => env.close());
  env.gateway.options.adminFunction = await loadAdminFunction({
    SUPABASE_URL: env.gateway.url, SUPABASE_ANON_KEY: "anon-test", SUPABASE_SERVICE_ROLE_KEY: TEST_SERVICE_KEY, ADMIN_EMAIL: OWNER
  });
  await env.sql("insert into auth.users (email, email_confirmed_at) values ($1, now())", [OWNER]);
  env.gateway.passwords.set(OWNER, "Owner-pass-123");
  // Production-like state: two approved test accounts and five unlinked original records.
  await env.member("tiago@test.invalid", profile("Tiago", { age: 42, gender: "Man", location: "Botswana" }), { approved: true });
  await env.member("alp@test.invalid", profile("Alp", { age: 40, gender: "Man", location: "Botswana" }), { approved: true });
  await env.sql("update public.members set is_test_account = true where user_id is not null");
  for (const n of ["OrigA", "OrigB", "OrigC", "OrigD", "OrigE"])
    await env.sql("insert into public.members (first_name, age, gender, location, relationship_goal, bio, profile_photo_url, approved) values ($1, 30, 'Man', 'Botswana', 'Marriage', 'x', $2, false)", [n, "old-" + n + ".jpg"]);
  const fp = async () => (await env.sql("select md5(string_agg(to_jsonb(m)::text, '|' order by id)) f from public.members m where user_id is null")).rows[0].f;
  const before = await fp();

  // 1. Daniel registers with a photo; email confirmation is required (no session yet).
  const daniel = await env.newPage();
  await env.fillRegistration(daniel, { name: "Daniel", email: "daniel@test.invalid", gender: "Man", seeking: "Everyone", min: "18", max: "120", location: "Uganda" });
  await daniel.setInputFiles("#photo", { name: "me.png", mimeType: "image/png", buffer: PNG });
  await daniel.click("#register-form button[type=submit]");
  await daniel.waitForSelector("#success-view:not(.hidden)");
  assert.ok(await daniel.isVisible("#success-photo-note"), "the member is told to add the photo after logging in");
  await env.sql("update auth.users set email_confirmed_at = now() where email = 'daniel@test.invalid'");

  // 2. Daniel logs in: pending, so only his own profile (the reported symptoms).
  await env.login(daniel, "daniel@test.invalid");
  await daniel.waitForURL(/dashboard\.html$/);
  await daniel.waitForFunction(() => /awaiting manual review/.test(document.getElementById("approval-status").textContent));
  await daniel.goto(env.base + "messages.html");
  await daniel.waitForFunction(() => /Messaging opens once/.test(document.getElementById("status").textContent));
    const row = (await env.sql("select m.approved, m.is_test_account, m.profile_photo_url from public.members m join auth.users u on u.id = m.user_id where u.email = 'daniel@test.invalid'")).rows[0];
  assert.deepEqual(row, { approved: false, is_test_account: false, profile_photo_url: null }, "new members start pending");

  // 3. Owner approves Daniel in the owner console (no SQL), marking him as a test account.
  const owner = await env.newPage();
  await owner.goto(env.base + "admin/");
  await owner.fill("#project", SUPABASE); await owner.fill("#anon", "sb_publishable_test");
  await owner.fill("#email", OWNER); await owner.fill("#password", "Owner-pass-123");
  await owner.click("#signin");
  await owner.waitForFunction(() => /Loaded \d+ profiles/.test(document.getElementById("status").textContent));
  const card = owner.locator("#members article.member").filter({ has: owner.locator("h3", { hasText: "Daniel" }) });
  await card.getByRole("button", { name: "Mark as my test account" }).click();
  await owner.waitForFunction(() => /Loaded/.test(document.getElementById("status").textContent));
  await card.getByRole("button", { name: "Approve" }).click();
  await owner.waitForFunction(() => [...document.querySelectorAll("#members article")].some(a => a.textContent.includes("Daniel") && a.textContent.includes("Approved")));
  assert.deepEqual((await env.sql("select approved, is_test_account from public.members where first_name = 'Daniel'")).rows[0], { approved: true, is_test_account: true });

  // 4. Daniel logs in again: Discover shows the two other test accounts, never the originals.
  await daniel.goto(env.base + "dashboard.html");
  await daniel.click("#signout"); await daniel.waitForURL(/signedout=1/);
  await env.login(daniel, "daniel@test.invalid");
  await daniel.waitForURL(/discover\.html$/);
  await daniel.waitForSelector("#profiles .card");
  const seen = await daniel.locator("#profiles .card h2").allTextContents();
    assert.deepEqual(seen.sort(), ["Alp, 40", "Tiago, 42"]);
  assert.match(await daniel.textContent("#signed-in"), /^Signed in as Daniel \(daniel@test\.invalid\)$/);

  // Even if the server ever returned the member's own row, Discover must not show it as a match.
  const ownId = (await env.sql("select id from public.members where first_name = 'Daniel'")).rows[0].id;
  await daniel.route("**/rest/v1/rpc/browse_member_profiles", async route => {
    const request = route.request();
    const response = await fetch(env.gateway.url + request.url().slice(SUPABASE.length), { method: request.method(), headers: request.headers(), body: request.postData() });
    const rows = await response.json();
    const own = { ...rows[0], id: ownId, first_name: "Daniel", age: 30 };
    await route.fulfill({ status: 200, json: [own, ...rows].map(r => ({ ...r, total_count: rows.length + 1 })) });
  });
  await daniel.reload();
  await daniel.waitForSelector("#profiles .card");
  assert.deepEqual((await daniel.locator("#profiles .card h2").allTextContents()).sort(), ["Alp, 40", "Tiago, 42"], "own profile never shown");
  await daniel.unroute("**/rest/v1/rpc/browse_member_profiles");

  // 5. Daniel uploads his photo from My Profile; it persists and Tiago can see it.
  await daniel.goto(env.base + "dashboard.html");
  await daniel.waitForSelector("#profile-panel:not(.hidden)");
  await daniel.setInputFiles("#photo-file", { name: "me.png", mimeType: "image/png", buffer: PNG });
  await daniel.click("#upload-photo");
  await daniel.waitForFunction(() => /has been saved/.test(document.getElementById("photo-status").textContent));
  await daniel.reload(); await daniel.waitForSelector("#photo-preview:not(.hidden)");
  assert.ok(await daniel.locator("#photo-preview").evaluate(i => i.complete && i.naturalWidth > 0), "the photo persists after reload");

  // 6. Two-way messaging Daniel <-> Tiago in separate browser contexts.
  await daniel.goto(env.base + "discover.html");
  await daniel.locator("#profiles .card", { hasText: "Tiago" }).locator("button.open").click();
  await daniel.click("#dialog-message");
  await daniel.waitForSelector("#compose:not(.hidden)");
  await daniel.fill("#body", "Test 1 from Daniel"); await daniel.click("#compose button[type=submit]");
  await daniel.waitForSelector(".bubble.mine");
  const tiago = await env.newPage({ mobile: true });
  await env.login(tiago, "tiago@test.invalid"); await tiago.waitForURL(/discover\.html$/);
  await tiago.waitForSelector("#profiles .card");
  assert.match(await tiago.textContent("#signed-in"), /^Signed in as Tiago /);
  const danielCard = tiago.locator("#profiles .card", { hasText: "Daniel" });
  assert.ok(await danielCard.locator("img.photo").evaluate(i => new Promise(r => i.complete ? r(i.naturalWidth > 0) : i.onload = () => r(i.naturalWidth > 0))), "Tiago sees Daniel's photo");
  await tiago.goto(env.base + "messages.html");
  await tiago.locator("#conversations button", { hasText: "Daniel" }).click();
  await tiago.waitForSelector(".bubble.theirs");
  assert.match(await tiago.textContent(".bubble.theirs"), /Test 1 from Daniel/);
  await tiago.fill("#body", "Test 2 from Tiago"); await tiago.click("#compose button[type=submit]");
  await tiago.waitForFunction(() => document.querySelectorAll(".bubble").length === 2);
  await daniel.reload(); await daniel.waitForSelector(".bubble.theirs");
  assert.match(await daniel.textContent(".bubble.theirs"), /Test 2 from Tiago/);

  // 7. Privacy and data.
  const alp = await env.newPage();
  await env.login(alp, "alp@test.invalid"); await alp.waitForURL(/discover\.html$/);
  const peek = await alp.evaluate(async () => {
    const db = window.FYP.createClient();
    const list = await db.rpc("list_my_conversations");
    const table = await db.from("member_messages").select("body");
    return { conversations: (list.data || []).length, rows: (table.data || []).length };
  });
    assert.deepEqual(peek, { conversations: 0, rows: 0 });
  assert.equal(await fp(), before, "the original records are unchanged");
});
