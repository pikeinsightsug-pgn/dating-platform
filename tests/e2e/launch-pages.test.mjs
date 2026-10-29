// Browser tests for the launch pages: homepage, registration questionnaire, login, password
// reset, profile editing, owner approval/rejection and phone layouts. Local only: real pages
// and supabase-js against the local gateway and Postgres. Invented people only.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile, ALL, PNG, SUPABASE } from "./harness.mjs";
import { TEST_SERVICE_KEY } from "./gateway.mjs";
import { loadAdminFunction } from "./edge-runtime.mjs";

const OWNER = "owner@test.invalid";
const noHorizontalScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("launch pages", async (t) => {
  const env = await setup("e2e_launch");
  t.after(() => env.close());

  await t.test("homepage: headline, couple photo, Join/Log in, privacy, no-payment statement and contact email", async () => {
    for (const mobile of [true, false]) {
      const page = await env.newPage({ mobile });
      await page.goto(env.base);
      assert.match(await page.textContent("h1"), /meaningful relationship/i);
      const photo = page.locator(".hero-photo img");
      assert.equal(await photo.evaluate(img => img.complete && img.naturalWidth > 0), true, "couple photo loads");
      assert.match(await photo.getAttribute("alt"), /African couple/);
      assert.ok(await page.locator("a.btn[href='account.html']", { hasText: "Join now" }).first().isVisible());
      assert.ok(await page.locator("a.btn[href='login.html']", { hasText: "Log in" }).first().isVisible());
      assert.match(await page.textContent("body"), /registration does not require any payment/i);
      assert.doesNotMatch(await page.textContent("body"), /first 100|free founding|join free/i);
      assert.ok(await page.locator("a[href='mailto:pikeinsightsug@gmail.com']").count() >= 2);
      assert.ok(await page.locator("a[href='privacy.html']").count() >= 1);
      assert.ok(await page.locator("#how").count() && await page.locator("#privacy").count() && await page.locator("#contact").count());
      assert.equal(await noHorizontalScroll(page), true, (mobile ? "phone" : "desktop") + " homepage has no sideways scrolling");
    }
  });

  await t.test("public pages fit a small Android screen (360px) without sideways scrolling", async () => {
    const page = await env.newPage({ mobile: true });
    await page.setViewportSize({ width: 360, height: 740 });
    for (const path of ["", "account.html", "login.html", "privacy.html", "about.html", "safety.html"]) {
      await page.goto(env.base + path);
      await page.waitForLoadState("load");
      assert.equal(await noHorizontalScroll(page), true, (path || "index.html") + " fits 360px");
    }
  });

  await t.test("registration shows a clear message for every missing or invalid answer", async () => {
    const page = await env.newPage({ mobile: true });
    await page.goto(env.base + "account.html");
    await page.click("#register-form button[type=submit]");
    const errors = await page.locator("#register-form .error:not(:empty)").allTextContents();
    for (const expected of [/email address/, /8 characters/, /what to call you/, /your age/i, /gender/, /country you live in/, /city/, /who you would like to meet/, /looking for/, /18 or older/, /privacy notice/]) {
      assert.ok(errors.some(e => expected.test(e)), "message for " + expected);
    }
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "email", "focus moves to the first problem");

    await env.fillRegistration(page, { name: "Young", email: "young@test.invalid", age: "17", password: "short" });
    await page.click("#register-form button[type=submit]");
    assert.match(await page.textContent("#age-error"), /18 or older/);
    assert.match(await page.textContent("#password-error"), /8 characters/);
    // "Show password" lets people check what they typed instead of typing it twice.
    await page.check("#show_password");
    assert.equal(await page.getAttribute("#password", "type"), "text");
    assert.equal((await env.sql("select count(*)::int as n from auth.users where email = 'young@test.invalid'")).rows[0].n, 0, "nothing was submitted");
  });

  await t.test("duplicate registration is caught without creating a second account", async () => {
    await env.member("taken@test.invalid", profile("Taken"));
    for (const confirm of [true, false]) {
      env.gateway.options.requireEmailConfirmation = confirm;
      const page = await env.newPage();
      await env.fillRegistration(page, { name: "Again", email: "taken@test.invalid" });
      await page.click("#register-form button[type=submit]");
      await page.waitForFunction(() => /already/.test(document.getElementById("email-error").textContent));
      assert.equal(await page.isVisible("#success-view"), false);
    }
    env.gateway.options.requireEmailConfirmation = true;
    assert.equal((await env.sql("select count(*)::int as n from auth.users where email = 'taken@test.invalid'")).rows[0].n, 1);
    assert.equal((await env.sql("select count(*)::int as n from public.members where first_name in ('Taken', 'Again')")).rows[0].n, 1);
  });

  await t.test("registration with an optional photo (Android file with no type) saves the profile, profession and photo", async () => {
    env.gateway.options.requireEmailConfirmation = false; // sign-in straight after signup
    const page = await env.newPage({ mobile: true });
    await env.fillRegistration(page, { name: "Photogenic", email: "photo-signup@test.invalid", gender: "Woman", seeking: "Men", profession: "Nurse", bio: "" });
    await page.evaluate(bytes => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], "IMG_2001.jpg", { type: "" }));
      const input = document.getElementById("photo"); input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, [...PNG]);
    await page.click("#register-form button[type=submit]");
    await page.waitForURL(/dashboard\.html$/);
    env.gateway.options.requireEmailConfirmation = true;
    const row = (await env.sql("select m.* from public.members m join auth.users u on u.id = m.user_id where u.email = 'photo-signup@test.invalid'")).rows[0];
    assert.equal(row.seeking_gender, "Men");
    assert.deepEqual([row.preferred_age_min, row.preferred_age_max], [null, null], "age range is no longer asked when joining");
    assert.equal(row.profession, "Nurse");
    assert.equal(row.bio, "Hello! I'm Photogenic from Kampala. I'm new on P.K CONNECT. Say hi 👋", "an empty bio gets a starter line");
    assert.equal(row.approved, false, "new members always start pending");
    assert.ok(row.profile_photo_url && row.profile_photo_url.startsWith(row.user_id + "/"), "photo stored in the member's private folder");
    await page.waitForSelector("#photo-preview:not(.hidden)");
  });

  await t.test("profile editing saves preferences, and discovery shows every approved member", async () => {
    await env.member("bloke-35@test.invalid", profile("Bloke", { gender: "Man", age: 35 }), { approved: true });
    await env.member("bloke-60@test.invalid", profile("Elder", { gender: "Man", age: 60 }), { approved: true });
    await env.member("lady-33@test.invalid", profile("Lady", { gender: "Woman", age: 33 }), { approved: true });
    await env.sql("update public.members set approved = true where first_name = 'Photogenic'");
    const page = await env.newPage({ mobile: true });
    await env.login(page, "photo-signup@test.invalid");
    await page.waitForURL(/discover\.html$/);
    await page.waitForSelector("#profiles .card");
    const everyone = await page.locator("#profiles .card h2").allTextContents();
    assert.ok(["Bloke, 35", "Elder, 60", "Lady, 33"].every(n => everyone.includes(n)), "every approved member, whatever her preferences");
    assert.equal(await page.inputValue("#filters [name=gender]"), "", "gender filter starts at Any");
    assert.equal(await page.inputValue("#filters [name=min_age]"), "18");
    assert.equal(await page.inputValue("#filters [name=max_age]"), "120");
    // She can still narrow the list herself.
    await page.selectOption("#filters [name=gender]", "Man");
    await page.click("#filters button[type=submit]");
    await page.waitForFunction(() => /Showing/.test(document.getElementById("status").textContent) && !document.querySelector("#profiles").textContent.includes("Lady"));
    assert.deepEqual((await page.locator("#profiles .card h2").allTextContents()).sort(), ["Bloke, 35", "Elder, 60"]);

    await page.goto(env.base + "dashboard.html");
    await page.waitForSelector("#profile-panel:not(.hidden)");
    await page.selectOption("[name=seeking_gender]", "Everyone");
    await page.fill("[name=preferred_age_min]", "30");
    await page.fill("[name=preferred_age_max]", "65");
    assert.equal(await page.inputValue("[name=profession]"), "Nurse");
    await page.fill("[name=profession]", "Senior nurse");
    await page.fill("[name=bio]", "Updated biography from the profile editor.");
    await page.click("#save-profile");
    await page.waitForFunction(() => /has been saved/.test(document.getElementById("status").textContent));
    const row = (await env.sql("select seeking_gender, preferred_age_max, bio, profession, approved from public.members where first_name = 'Photogenic'")).rows[0];
    assert.deepEqual(row, { seeking_gender: "Everyone", preferred_age_max: 65, bio: "Updated biography from the profile editor.", profession: "Senior nurse", approved: true });

    await page.goto(env.base + "discover.html");
    await page.waitForSelector("#profiles .card");
    const names = await page.locator("#profiles .card h2").allTextContents();
    assert.ok(names.includes("Elder, 60") && names.includes("Lady, 33") && !names.some(n => n.startsWith("Photogenic")), "wider preferences, still never herself");
    // Other approved members see her profession on her card.
    const bloke = await env.newPage();
    await env.login(bloke, "bloke-35@test.invalid"); await bloke.waitForURL(/discover\.html$/);
    await bloke.waitForSelector("#profiles .card");
    assert.match(await bloke.locator("#profiles .card", { hasText: "Photogenic" }).textContent(), /💼 Senior nurse/);
  });

  await t.test("login: wrong password message, then an existing member is taken past registration", async () => {
    const page = await env.newPage();
    await env.login(page, "bloke-35@test.invalid", "wrong-password");
    await page.waitForFunction(() => /do not match/.test(document.getElementById("status").textContent));
    await env.login(page, "bloke-35@test.invalid");
    await page.waitForURL(/discover\.html$/);
    for (const path of ["login.html", "account.html", "account.html?mode=login"]) {
      await page.goto(env.base + path);
      await page.waitForURL(/discover\.html$/);
    }
  });

  await t.test("password reset: request, follow the email link, set a new password, log in with it", async () => {
    const page = await env.newPage({ mobile: true });
    await page.goto(env.base + "login.html");
    await page.click("[data-view=forgot]");
    await page.fill("#forgot-email", "lady-33@test.invalid");
    await page.click("#forgot-form button[type=submit]");
    await page.waitForFunction(() => /If an account matches/.test(document.getElementById("forgot-status").textContent));
    const s = await env.gateway.sessionFor("lady-33@test.invalid");
    await page.goto(env.base + `account.html?mode=recovery#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_at=${s.expires_at}&expires_in=3600&token_type=bearer&type=recovery`);
    await page.waitForSelector("#recovery-view:not(.hidden)");
    await page.fill("#new_password", "Brand-new-pass-9");
    await page.fill("#new_password_confirm", "Brand-new-pass-9");
    await page.click("#recovery-form button[type=submit]");
    await page.waitForURL(/login\.html\?reset=1$/);
    assert.equal(await page.isVisible("#password-updated"), true);
    await env.login(page, "lady-33@test.invalid", "Brand-new-pass-9");
    await page.waitForURL(/discover\.html$/);
  });

  await t.test("owner approval and rejection: only the owner can change it, and rejected members disappear", async () => {
    env.gateway.options.adminFunction = await loadAdminFunction({
      SUPABASE_URL: env.gateway.url, SUPABASE_ANON_KEY: "anon-test", SUPABASE_SERVICE_ROLE_KEY: TEST_SERVICE_KEY, ADMIN_EMAIL: OWNER
    });
    await env.sql("insert into auth.users (email, email_confirmed_at) values ($1, now())", [OWNER]);
    env.gateway.passwords.set(OWNER, "Owner-pass-123");
    await env.member("newbie@test.invalid", profile("Newbie", { gender: "Man", age: 31 }));

    // A member calling the owner function is refused.
    const member = await env.newPage();
    await env.login(member, "lady-33@test.invalid", "Brand-new-pass-9");
    await member.waitForURL(/discover\.html$/);
    const refused = await member.evaluate(async url => {
      const { data } = await window.FYP.createClient().auth.getSession();
      const res = await fetch(url + "/functions/v1/admin-members", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + data.session.access_token }, body: JSON.stringify({ action: "approve", member_id: "00000000-0000-4000-8000-000000000000" }) });
      return res.status;
    }, SUPABASE);
    assert.equal(refused, 403);
    // Nor can a member read the member list, and a signed-out caller is refused before any data is read.
    const probes = await member.evaluate(async url => {
      const { data } = await window.FYP.createClient().auth.getSession();
      const call = (headers, action) => fetch(url + "/functions/v1/admin-members", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ action }) })
        .then(async r => [r.status, (await r.json()).members === undefined]);
      return { member: await call({ Authorization: "Bearer " + data.session.access_token }, "list"), anonymous: await call({}, "list") };
    }, SUPABASE);
    assert.deepEqual(probes, { member: [403, true], anonymous: [401, true] });

    const owner = await env.newPage();
    await owner.goto(env.base + "admin/");
    await owner.fill("#project", SUPABASE); await owner.fill("#anon", "sb_publishable_test");
    await owner.fill("#email", OWNER); await owner.fill("#password", "Owner-pass-123");
    await owner.click("#signin");
    await owner.waitForFunction(() => /Loaded \d+ profiles/.test(document.getElementById("status").textContent));
    assert.match(await owner.textContent("#function-version"), /^Owner function admin-members is up to date \(version \d{4}-\d{2}-\d{2}\)\.$/);
    const card = name => owner.locator("#members article.member").filter({ has: owner.locator("h3", { hasText: name }) });
    assert.match(await card("Photogenic").textContent(), /Wants to meet: Everyone/);
    assert.match(await card("Photogenic").textContent(), /Profession: Senior nurse/);
    await card("Newbie").getByRole("button", { name: "Approve" }).click();
    await owner.waitForFunction(() => [...document.querySelectorAll("#members article")].some(a => a.textContent.includes("Newbie") && a.textContent.includes("Approved")));

    await member.goto(env.base + "discover.html");
    await member.waitForSelector("#profiles .card");
    assert.ok((await member.locator("#profiles .card h2").allTextContents()).includes("Newbie, 31"), "approved member appears");

    await card("Newbie").getByRole("button", { name: "Return to pending" }).click();
    await owner.waitForFunction(() => [...document.querySelectorAll("#members article")].some(a => a.textContent.includes("Newbie") && a.textContent.includes("Pending review")));
    await member.reload();
    await member.waitForSelector("#profiles .card");
    assert.ok(!(await member.locator("#profiles .card h2").allTextContents()).includes("Newbie, 31"), "rejected member is hidden again");

    const newbie = await env.newPage();
    await env.login(newbie, "newbie@test.invalid");
    await newbie.waitForURL(/dashboard\.html$/);
    await newbie.goto(env.base + "discover.html");
    await newbie.waitForFunction(() => /awaiting manual review/.test(document.getElementById("status").textContent));
  });
});

test("before the new database file is applied, registration and profile editing still work", async (t) => {
  const env = await setup("e2e_launch_previous", ALL.slice(0, 3));
  t.after(() => env.close());
  env.gateway.options.requireEmailConfirmation = false;
  const page = await env.newPage({ mobile: true });
  await env.fillRegistration(page, { name: "Early", email: "early@test.invalid" });
  await page.click("#register-form button[type=submit]");
  await page.waitForURL(/dashboard\.html$/);
  await page.waitForSelector("#profile-panel:not(.hidden)");
  await page.fill("[name=city]", "Entebbe");
  await page.selectOption("[name=seeking_gender]", "Women");
  await page.click("#save-profile");
  await page.waitForFunction(() => /has been saved/.test(document.getElementById("status").textContent));
  const row = (await env.sql("select city, approved from public.members where first_name = 'Early'")).rows[0];
  assert.deepEqual(row, { city: "Entebbe", approved: false });
});
