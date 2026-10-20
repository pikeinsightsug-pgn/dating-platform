// End-to-end restoration of original (Google Form) registrations through the real pages,
// the real owner console and the real admin-members Edge Function code, against a local
// database. Every person here is invented. Proves the workflow, not the live project.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile, SUPABASE } from "./harness.mjs";
import { TEST_SERVICE_KEY } from "./gateway.mjs";
import { loadAdminFunction } from "./edge-runtime.mjs";
import { parseCsv, reconcile, archiveSql } from "../../tools/reconcile-registrations.mjs";

const OWNER = "owner@test.invalid";
const FORM = [
  "Timestamp,1. 🌍 Where are you currently based? ,  2. 📍 What city or town are you in?  ,  3. ❤️ What's your gender?  ,  4. 🎂 What age group are you in?  ,  16. 👋 What should we call you?  ,  17. 📸 Add your profile photo  ,18. WhatsApp or phone number — please include your country code. 📱 You may also provide your email address. 📧  ,Referral Code",
  "10/7/2026 18:00:00,Uganda,Kampala,Female,25–29,Restora,https://drive.example.invalid/restora,\"+256700000101 restora@test.invalid\",UG1",
  "10/8/2026 09:00:00,Botswana,Gaborone,Male,35–39,Revivo,https://drive.example.invalid/revivo,+26770000102,"
].join("\n");

async function ownerConsole(env) {
  const page = await env.newPage();
  await page.goto(env.base + "admin/");
  await page.fill("#project", SUPABASE);
  await page.fill("#anon", "sb_publishable_test");
  await page.fill("#email", OWNER);
  await page.fill("#password", "Owner-pass-123");
  await page.click("#signin");
  await page.waitForFunction(() => /Loaded \d+ profiles/.test(document.getElementById("status").textContent));
  return page;
}
// Match on each card's heading: dropdowns inside cards also list other members' names.
const card = (page, text) => page.locator("#members article.member").filter({ has: page.locator("h3", { hasText: text }) });
const original = (page, text) => page.locator("#legacy article").filter({ has: page.locator("h3", { hasText: text }) });

test("restoring original registrations: archive, activate, link, approve, then members see each other", async (t) => {
  const env = await setup("e2e_restore");
  t.after(() => env.close());
  env.gateway.options.adminFunction = await loadAdminFunction({
    SUPABASE_URL: env.gateway.url, SUPABASE_ANON_KEY: "anon-test",
    SUPABASE_SERVICE_ROLE_KEY: TEST_SERVICE_KEY, ADMIN_EMAIL: OWNER
  });
  await env.sql("insert into auth.users (email, email_confirmed_at) values ($1, now())", [OWNER]);
  env.gateway.passwords.set(OWNER, "Owner-pass-123");

  // The owner's own test accounts (like Alp and Tiago).
  await env.member("tester-one@test.invalid", profile("TesterOne"), { approved: true });
  await env.member("tester-two@test.invalid", profile("TesterTwo", { location: "Botswana" }), { approved: true });

  // Archive the original form answers (the SQL the reconciliation tool generates).
  const report = reconcile({ formRows: parseCsv(FORM) });
  await env.sql(archiveSql(report.results));
  await env.sql(archiveSql(report.results)); // rerunning must not duplicate
  const archived = await env.sql("select count(*)::int as n, bool_and(original_answers::text like '%drive.example.invalid%') as photos from public.legacy_registrations");
  assert.deepEqual(archived.rows[0], { n: 2, photos: true }, "both originals archived once, photo links preserved");

  // Revivo already has an old profile without an account (from the early website form).
  await env.sql("insert into public.members (first_name, age, gender, location, city, relationship_goal, bio, approved) values ('Revivo', 37, 'Man', 'Botswana', 'Gaborone', 'Marriage', 'Original website registration', false)");

  await t.test("an original registrant re-registers on account.html and gets one pending profile", async () => {
    const page = await env.newPage({ mobile: true });
    await env.fillRegistration(page, { name: "Restora", email: "restora@test.invalid", password: "Restora-pass-1", age: "27", seeking: "Everyone", min: "18", max: "120", bio: "Back from the original form, still hoping to meet someone kind." });
    await page.click("#register-form button[type=submit]");
    await page.waitForSelector("#success-view:not(.hidden)");
    await env.sql("update auth.users set email_confirmed_at = now() where email = 'restora@test.invalid'");
    await env.login(page, "restora@test.invalid", "Restora-pass-1");
    await page.waitForURL(/dashboard\.html$/);
    assert.equal((await env.sql("select count(*)::int as n from public.members where first_name = 'Restora'")).rows[0].n, 1);
  });

  await t.test("an invited registrant follows the email link from the homepage, sets a password and is not given a guessed profile", async () => {
    // What "Invite user" in Supabase produces: a confirmed account with no signup profile.
    await env.sql("insert into auth.users (email, email_confirmed_at) values ('revivo@test.invalid', now())");
    const s = await env.gateway.sessionFor("revivo@test.invalid");
    const page = await env.newPage({ mobile: true });
    // Invitation links return to the Site URL (the homepage), which hands them to account.html.
    await page.goto(env.base + `#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_at=${s.expires_at}&expires_in=3600&token_type=bearer&type=invite`);
    await page.waitForURL(/account\.html/);
    await page.waitForFunction(() => document.getElementById("recovery-title").textContent === "Activate your account");
    await page.fill("#recovery-form [name=password]", "Revivo-pass-1");
    await page.fill("#recovery-form [name=password_confirm]", "Revivo-pass-1");
    await page.click("#recovery-form button[type=submit]");
    await page.waitForURL(/dashboard\.html\?profile=recovery$/);
    await page.waitForSelector("#recovery-panel:not(.hidden)");
    assert.match(await page.textContent("#recovery-account"), /revivo@test\.invalid/);
    assert.equal((await env.sql("select count(*)::int as n from public.members where first_name = 'Revivo'")).rows[0].n, 1, "no duplicate profile");
  });

  await t.test("an expired email link explains what to do instead of failing silently", async () => {
    const page = await env.newPage();
    await page.goto(env.base + "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
    await page.waitForURL(/account\.html/);
    await page.waitForFunction(() => /expired or was already used/.test(document.getElementById("status").textContent));
  });

  await t.test("with an older Edge Function deployed, the owner console still lists profiles", async () => {
    env.gateway.options.adminFunctionOnly = ["list", "approve", "reject"];
    const page = await ownerConsole(env);
    assert.match(await page.textContent("#recovery-status"), /Redeploy/);
    assert.match(await page.textContent("#function-version"), /older version \(no version reported; this page expects \d{4}-\d{2}-\d{2}\)/);
    assert.match(await page.textContent("#approved"), /incl\. test accounts/, "never presents test accounts as genuine members");
    assert.ok(await card(page, "Restora").count());
    env.gateway.options.adminFunctionOnly = null;
  });

  await t.test("the owner links, marks test accounts and approves — nothing happens automatically", async () => {
    const before = (await env.sql("select count(*)::int as n from public.members where approved")).rows[0].n;
    assert.equal(before, 2, "only the two owner test accounts are approved so far");
    const page = await ownerConsole(env);

    await card(page, "TesterOne").getByRole("button", { name: "Mark as my test account" }).click();
    await page.waitForFunction(() => /Loaded/.test(document.getElementById("status").textContent));
    await card(page, "TesterTwo").getByRole("button", { name: "Mark as my test account" }).click();
    await page.waitForFunction(() => document.querySelectorAll("#members .badge").length && /2 marked as test/.test(document.getElementById("test-count").textContent));

    const revivoId = (await env.sql("select id from auth.users where email = 'revivo@test.invalid'")).rows[0].id;
    const revivo = card(page, "Revivo");
    await revivo.locator("select").selectOption(revivoId);
    await revivo.locator("input[type=checkbox]").check();
    await revivo.getByRole("button", { name: "Link verified account" }).click();
    await page.waitForFunction(() => /Profile linked/.test(document.getElementById("status").textContent));

    await page.click("#legacy-toggle");
    await page.waitForFunction(() => document.querySelectorAll("#legacy article").length === 2);
    for (const name of ["Restora", "Revivo"]) {
      const entry = original(page, name);
      const option = await entry.locator("select").first().locator("option", { hasText: name }).getAttribute("value");
      await entry.locator("select").first().selectOption(option);
      await entry.locator("input[type=checkbox]").check();
      await entry.getByRole("button", { name: "Link to profile" }).click();
      await page.waitForFunction(n => [...document.querySelectorAll("#legacy article")].some(a => a.textContent.includes(n) && a.textContent.includes("Linked profile")), name);
    }
    assert.equal((await env.sql("select count(*)::int as n from public.legacy_registrations where reconciliation_status = 'linked' and matched_member_id is not null")).rows[0].n, 2);
    assert.equal((await env.sql("select count(*)::int as n from public.members where approved")).rows[0].n, 2, "linking approved nobody");

    for (const name of ["Restora", "Revivo"]) {
      await card(page, name).getByRole("button", { name: "Approve" }).click();
      await page.waitForFunction(n => [...document.querySelectorAll("#members article")].some(a => a.textContent.includes(n) && a.textContent.includes("Approved")), name);
    }
    assert.equal(await page.textContent("#approved"), "2", "genuine approved count excludes test accounts");
  });

  await t.test("restored members see each other, never the test accounts", async () => {
    const restora = await env.newPage({ mobile: true });
    await env.login(restora, "restora@test.invalid", "Restora-pass-1");
    await restora.waitForURL(/discover\.html$/);
    await restora.waitForSelector("#profiles .card");
    assert.deepEqual(await restora.locator("#profiles .card h2").allTextContents(), ["Revivo, 37"]);

    const revivo = await env.newPage();
    await env.login(revivo, "revivo@test.invalid", "Revivo-pass-1");
    await revivo.waitForURL(/discover\.html$/);
    await revivo.waitForSelector("#profiles .card");
    assert.deepEqual(await revivo.locator("#profiles .card h2").allTextContents(), ["Restora, 27"]);

    const tester = await env.newPage();
    await env.login(tester, "tester-one@test.invalid");
    await tester.waitForURL(/discover\.html$/);
    await tester.waitForSelector("#profiles .card");
    assert.deepEqual((await tester.locator("#profiles .card h2").allTextContents()).sort(), ["Restora, 27", "Revivo, 37", "TesterTwo, 30"],
      "test accounts see each other and, read-only, the genuine members");

    const originals = await env.sql("select count(*)::int as n from public.legacy_registrations");
    assert.equal(originals.rows[0].n, 2, "original registrations are all still archived");
  });
});
