// The owner helps people who could not finish registering: confirming someone whose email
// never arrived, and inviting someone who could not register at all. The owner never sets a
// password and nobody is approved automatically. Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile, SUPABASE } from "./harness.mjs";
import { TEST_SERVICE_KEY } from "./gateway.mjs";
import { loadAdminFunction } from "./edge-runtime.mjs";

const OWNER = "owner@test.invalid";

test("owner adds or helps members who could not register", async (t) => {
  const env = await setup("e2e_owner_add_member");
  t.after(() => env.close());
  env.gateway.options.adminFunction = await loadAdminFunction({
    SUPABASE_URL: env.gateway.url, SUPABASE_ANON_KEY: "anon-test", SUPABASE_SERVICE_ROLE_KEY: TEST_SERVICE_KEY, ADMIN_EMAIL: OWNER
  });
  await env.sql("insert into auth.users (email, email_confirmed_at) values ($1, now())", [OWNER]);
  env.gateway.passwords.set(OWNER, "Owner-pass-123");
  await env.member("kabo@test.invalid", profile("Kabo", { age: 34, gender: "Man", location: "Botswana", city: "Gaborone", seeking_gender: "Women" }), { approved: true });
  const rows = async email => (await env.sql(
    "select m.first_name, m.approved, m.location, u.email_confirmed_at is not null as confirmed from auth.users u left join public.members m on m.user_id = u.id where u.email = $1", [email])).rows;

  const owner = await env.newPage();
  await owner.goto(env.base + "admin/");
  await owner.fill("#project", SUPABASE); await owner.fill("#anon", "sb_publishable_test");
  await owner.fill("#email", OWNER); await owner.fill("#password", "Owner-pass-123");
  await owner.click("#signin");
  await owner.waitForFunction(() => /Loaded \d+ profiles/.test(document.getElementById("status").textContent));
  const card = name => owner.locator("#members article.member").filter({ has: owner.locator("h3", { hasText: name }) });
  const add = async (fields, consent = true) => {
    for (const [name, value] of Object.entries(fields)) {
      const field = owner.locator(`#add-form [name=${name}]`);
      if (await field.evaluate(f => f.tagName === "SELECT")) await field.selectOption(value); else await field.fill(String(value));
    }
    if (consent) await owner.check("#add-form [name=consent]");
    await owner.click("#add-submit");
    await owner.waitForFunction(() => document.getElementById("add-submit").textContent === "Add member" && document.getElementById("add-status").textContent);
    return owner.textContent("#add-status");
  };

  await t.test("someone whose confirmation email never arrived: the owner confirms them with just their email", async () => {
    const page = await env.newPage({ mobile: true });
    await env.fillRegistration(page, { name: "Naledi", email: "naledi@test.invalid", gender: "Woman", seeking: "Men", min: "25", max: "45", location: "Botswana" });
    await page.click("#register-form button[type=submit]");
    await page.waitForSelector("#success-view:not(.hidden)");
    assert.deepEqual(await rows("naledi@test.invalid"), [{ first_name: null, approved: null, location: null, confirmed: false }], "stuck: unconfirmed, no profile");

    assert.match(await add({ email: "naledi@test.invalid" }), /is confirmed\. They can now log in with the password they chose/);
    assert.deepEqual(await rows("naledi@test.invalid"), [{ first_name: "Naledi", approved: false, location: "Botswana", confirmed: true }], "their own answers, pending");

    // She logs in with her own password and sees the review message.
    await env.login(page, "naledi@test.invalid");
    await page.waitForURL(/dashboard\.html$/);
    await page.waitForFunction(() => /awaiting manual review/.test(document.getElementById("approval-status").textContent));
    assert.equal(await card("Naledi").getByRole("button", { name: "Approve" }).isEnabled(), true);
  });

  await t.test("someone who could not register at all: the owner fills in their details and they accept an invitation", async () => {
    assert.match(await add({ email: "achan@test.invalid" }), /Enter the person's first name/, "details are needed for someone new");
    assert.deepEqual(await rows("achan@test.invalid"), [], "nothing created");

    const status = await add({ email: "achan@test.invalid", first_name: "Achan", age: 31, gender: "Woman", seeking_gender: "Men",
      location: "Uganda", city: "Gulu", relationship_goal: "Marriage", bio: "Teacher who loves music." });
    assert.match(status, /Invitation sent to achan@test\.invalid/);
    assert.deepEqual(await rows("achan@test.invalid"), [{ first_name: "Achan", approved: false, location: "Uganda", confirmed: false }]);
    await card("Achan").waitFor();
    assert.match(await card("Achan").textContent(), /Waiting for them to accept/);
    assert.equal(await card("Achan").getByRole("button", { name: "Approve" }).isEnabled(), false, "cannot approve before they accept");

    // Achan opens the invitation email, chooses her own password and lands on her pending profile.
    const mail = env.gateway.confirmationEmail("achan@test.invalid");
    assert.equal(mail.type, "invite");
    assert.match(mail.redirect, /\/account\.html$/);
    const page = await env.newPage({ mobile: true });
    await page.goto(`${SUPABASE}/auth/v1/verify?token=${mail.token}&type=invite&redirect_to=${encodeURIComponent(mail.redirect)}`);
    await page.waitForFunction(() => document.getElementById("recovery-title").textContent === "Activate your account");
    await page.fill("#recovery-form [name=password]", "Achan-pass-123");
    await page.fill("#recovery-form [name=password_confirm]", "Achan-pass-123");
    await page.click("#recovery-form button[type=submit]");
    await page.waitForURL(/dashboard\.html/);
    await page.waitForFunction(() => /awaiting manual review/.test(document.getElementById("approval-status").textContent));
    assert.equal(await page.inputValue("[name=first_name]"), "Achan", "the details the owner entered");

    // The owner approves; Achan logs in with her own password and meets members.
    await owner.click("#refresh");
    await owner.waitForFunction(() => /Loaded/.test(document.getElementById("status").textContent));
    await card("Achan").getByRole("button", { name: "Approve" }).click();
    await owner.waitForFunction(() => [...document.querySelectorAll("#members article")].some(a => a.textContent.includes("Achan") && a.textContent.includes("Approved")));
    const again = await env.newPage();
    await env.login(again, "achan@test.invalid", "Achan-pass-123");
    await again.waitForURL(/discover\.html$/);
    await again.waitForSelector("#profiles .card");
    assert.deepEqual(await again.locator("#profiles .card h2").allTextContents(), ["Kabo, 34"]);
    assert.equal((await rows("achan@test.invalid")).length, 1, "exactly one profile");
  });

  await t.test("safety: consent is required, existing members are never changed, invalid details are refused", async () => {
    assert.match(await add({ email: "someone@test.invalid", first_name: "Some" }, false), /tick the box/i);
    const before = await env.sql("select md5(string_agg(to_jsonb(m)::text, '|' order by id)) f from public.members m");
    assert.match(await add({ email: "kabo@test.invalid" }), /already has a confirmed account and profile/);
    assert.deepEqual(await env.sql("select md5(string_agg(to_jsonb(m)::text, '|' order by id)) f from public.members m"), before, "nothing changed");
    assert.match(await add({ email: "young@test.invalid", first_name: "Young", age: 17, gender: "Man", location: "Uganda",
      city: "Mbale", relationship_goal: "Friendship", bio: "x" }), /18 or over/);
    assert.deepEqual(await rows("young@test.invalid"), []);
    assert.equal((await env.sql("select count(*)::int n from public.members where approved")).rows[0].n, 2, "only Kabo and the owner-approved Achan are approved");
  });

  await t.test("members cannot use the owner action", async () => {
    const page = await env.newPage();
    await env.login(page, "kabo@test.invalid"); await page.waitForURL(/discover\.html$/);
    const status = await page.evaluate(async url => {
      const db = window.FYP.createClient();
      const { data } = await db.auth.getSession();
      const res = await fetch(url + "/functions/v1/admin-members", { method: "POST",
        headers: { "Content-Type": "application/json", apikey: "x", Authorization: "Bearer " + data.session.access_token },
        body: JSON.stringify({ action: "add_member", email: "evil@test.invalid", consent: true }) });
      return res.status;
    }, SUPABASE);
    assert.equal(status, 403);
  });
});
