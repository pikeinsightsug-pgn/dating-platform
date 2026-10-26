import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const repo = new URL("../", import.meta.url);
const read = async (path) => readFile(new URL(path, repo), "utf8");
const scriptBlocks = (html) => [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);

test("inline application scripts parse", async () => {
  for (const path of ["account.html", "login.html", "index.html", "dashboard.html", "discover.html", "messages.html", "admin/index.html"]) {
    const html = await read(path);
    const scripts = scriptBlocks(html);
    assert.ok(scripts.length, path + " has an inline script");
    scripts.forEach((source, index) => new vm.Script(source, { filename: path + "#" + index }));
  }
});

const core = (await import("../assets/member-core.js")).default ?? globalThis.FYP;

function fakeDb({ existing = [], insertError = null, readError = null } = {}) {
  const state = { inserts: [], reads: 0, rows: [...existing] };
  return { state, from(table) {
    assert.equal(table, "members");
    return {
      select() { return this; },
      eq() { return this; },
      limit: async () => { state.reads++; return readError ? { data: null, error: readError } : { data: state.rows.slice(0, 1), error: null }; },
      insert: async (profile) => { state.inserts.push(profile); if (insertError) return { error: insertError }; state.rows.push({ id: "new-id", ...profile }); return { error: null }; }
    };
  } };
}
const signupUser = (meta = {}) => ({ id: "auth-id", user_metadata: { profile_type: "member_registration", first_name: "Test", age: 30, gender: "Woman", location: "Uganda", city: "Kampala", relationship_goal: "Friendship", bio: "Test profile", ...meta } });

test("sign-in reuses a linked profile and never creates a second one", async () => {
  const db = fakeDb({ existing: [{ id: "existing-id", approved: true }] });
  assert.deepEqual(await core.ensureOwnProfile(db, signupUser()), { id: "existing-id", approved: true });
  assert.equal(db.state.inserts.length, 0);
});

test("a confirmed signup without a profile gets exactly one pending profile from its own signup data", async () => {
  const db = fakeDb();
  const profile = await core.ensureOwnProfile(db, signupUser());
  assert.equal(db.state.inserts.length, 1);
  assert.equal(db.state.inserts[0].user_id, "auth-id");
  assert.equal(db.state.inserts[0].approved, false);
  assert.equal(profile.id, "new-id");
});

test("accounts without signup data (owner invites, legacy members) are never given a guessed profile", async () => {
  for (const user of [{ id: "auth-id", user_metadata: {} }, signupUser({ profile_type: undefined }), signupUser({ age: 16 }), signupUser({ location: "Narnia" })]) {
    const db = fakeDb();
    assert.equal(await core.ensureOwnProfile(db, user), null);
    assert.equal(db.state.inserts.length, 0);
  }
});

test("profile read failures surface an error instead of redirecting to recovery", async () => {
  await assert.rejects(core.ensureOwnProfile(fakeDb({ readError: { message: "boom" } }), signupUser()), /could not be loaded/);
});

test("routing: approved members go to discovery, pending to the dashboard, unlinked to recovery (no loop back to account.html)", async () => {
  assert.equal(core.destinationFor({ approved: true }), "discover.html");
  assert.equal(core.destinationFor({ approved: false }), "dashboard.html");
  assert.equal(core.destinationFor(null), "dashboard.html?profile=recovery");
  for (const page of ["dashboard.html", "discover.html", "messages.html"]) {
    // Member pages may only send signed-out visitors to the login page.
    assert.doesNotMatch(await read(page), /location\.replace\(["']account\.html["']\)/, page);
  }
});

test("auth errors produce specific guidance", () => {
  assert.match(core.authErrorMessage({ code: "email_not_confirmed" }), /confirm your email/);
  assert.match(core.authErrorMessage({ code: "invalid_credentials" }), /do not match/);
  assert.match(core.authErrorMessage({ message: "User already registered" }, "signup"), /already exists/);
  assert.match(core.authErrorMessage({ code: "REQUEST_TIMEOUT" }), /timed out/);
  assert.match(core.authErrorMessage({ message: "Database error saving new user" }, "signup"), /server setup/);
});

test("Android files with no MIME type are recognised by extension", () => {
  assert.equal(core.photoTypeOf({ type: "", name: "IMG_2041.JPG" }), "image/jpeg");
  assert.equal(core.photoTypeOf({ type: "", name: "photo.webp" }), "image/webp");
  assert.equal(core.photoTypeOf({ type: "", name: "photo.heic" }), "image/heic");
  assert.equal(core.photoTypeOf({ type: "image/jpg", name: "x" }), "image/jpeg");
  assert.equal(core.photoTypeOf({ type: "", name: "document.pdf" }), "");
});

test("dashboard never inserts a member row directly and gates photo upload on a linked profile", async () => {
  const html = await read("dashboard.html");
  assert.doesNotMatch(html, /\.from\(["']members["']\)\s*\.insert/);
  assert.match(html, /\.eq\(["']user_id["'],\s*user\.id\)/);
  // The upload button stays disabled until the member has a linked profile and a (cropped) photo is ready.
  assert.match(html, /if \(!file \|\| !memberProfile\) return;/);
  assert.match(html, /if \(!photoReady\(\) \|\| !memberProfile \|\| photoButton\.disabled \|\| photoUploading\) return;/);
  assert.match(html, /accept="image\/\*"/);
});

test("request timeout aborts a stalled Supabase request and classifies it for retry", async () => {
  const stalled = (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const request = core.boundedFetch(stalled, "https://cyvkpcwjkeifpvegwhpt.supabase.co", 10);
  await assert.rejects(request("https://cyvkpcwjkeifpvegwhpt.supabase.co/storage/v1/object/test"), (error) => {
    assert.equal(error.code, "REQUEST_TIMEOUT");
    return /timed out/i.test(error.message);
  });
  const html = await read("dashboard.html");
  assert.match(html, /took longer than 60 seconds[\s\S]*try again/i);
  assert.match(html, /finally \{\s*photoUploading = false; photoInput\.disabled = false/);
});

test("no page ships a service-role key or an unpinned Supabase library", async () => {
  for (const path of ["index.html", "account.html", "login.html", "privacy.html", "dashboard.html", "discover.html", "messages.html", "admin/index.html", "assets/member-core.js"]) {
    const text = await read(path);
    assert.doesNotMatch(text, /service_role|sb_secret_/i, path);
    assert.doesNotMatch(text, /supabase-js@2"/, path + " pins the Supabase library version");
  }
});

test("owner preview endpoint checks owner identity and signs only same-owner private paths", async () => {
  const source = await read("supabase/functions/admin-members/index.ts");
  const authGate = source.indexOf("Not authorized for owner actions.");
  const listAction = source.indexOf('body.action === "list"');
  const signer = source.indexOf("createSignedUrl(photoPath, 300)");
  assert.ok(authGate >= 0 && listAction > authGate && signer > listAction);
  assert.match(source, /isMemberPhotoPathOwnedByUser\(member\.user_id, photoPath\)/);
  const helper = (await read("supabase/functions/_shared/member-photo-path.js")).replace("export function", "function");
  const check = new Function(helper + "; return isMemberPhotoPathOwnedByUser;")();
  assert.equal(check("user-1", "user-1/photo.webp"), true);
  assert.equal(check("user-1", "user-2/photo.webp"), false);
  assert.equal(check("user-1", "https://example.test/photo.webp"), false);
  assert.equal(check("user-1", "user-1/../private.webp"), false);
});

test("discovery contract restricts results to approved adults and omits private fields", async () => {
  const sql = await read("supabase/member_discovery_photos.sql");
  const start = sql.indexOf("create function public.browse_approved_profiles()");
  const end = sql.indexOf("$$;", start);
  assert.ok(start >= 0 && end > start);
  const fn = sql.slice(start, end);
  assert.match(fn, /current_approved_member_id\(\) is null/);
  assert.match(fn, /m\.approved = true and m\.age >= 18/);
  assert.match(fn, /m\.id <> public\.current_approved_member_id\(\)/);
  const returnedColumns = fn.match(/returns table\s*\(([\s\S]*?)\)/i)?.[1] || "";
  assert.doesNotMatch(returnedColumns, /account_email|partner_preference|user_id/i);
  assert.match(await read("discover.html"), /rpc\(["']browse_approved_profiles["']\)/);
});

test("filtered discovery excludes self, blocked and unapproved members and omits private fields", async () => {
  const sql = await read("supabase/discovery_messaging_safety.sql");
  const start = sql.indexOf("create or replace function public.browse_member_profiles(");
  const fn = sql.slice(start, sql.indexOf("$$;", start));
  assert.match(fn, /require_approved_member\(\)/);
  assert.match(fn, /m\.approved = true and m\.age >= 18 and m\.user_id is not null/);
  assert.match(fn, /m\.id <> me/);
  assert.match(fn, /not public\.members_are_blocked\(me, m\.id\)/);
  const returned = fn.match(/returns table\s*\(([\s\S]*?)\)\s*language/i)?.[1] || "";
  assert.doesNotMatch(returned, /email|phone|partner_preference|user_id|approved/i);
  assert.doesNotMatch(sql, /drop table|truncate|delete from public\.members/i);
  assert.match(await read("discover.html"), /rpc\(["']browse_member_profiles["']/);
});

test("reconciliation matches only on email/phone, flags duplicates and minors, and never auto-links by name", async () => {
  const { reconcile, parseCsv, normalizePhone, archiveSql } = await import("../tools/reconcile-registrations.mjs");
  const formRows = parseCsv([
    "Timestamp,Full name,Email address,WhatsApp number,Age,Country,City,Referral code",
    "2026/01/02 10:00:00,Amina K,AMINA@test.invalid ,0772 000001,29,Uganda,Kampala,REF1",
    "2026/01/03 10:00:00,Amina K,amina@test.invalid,,29,Uganda,Kampala,",
    "2026/01/04 10:00:00,Kabo M,kabo@test.invalid,71234567,33,Botswana,Gaborone,",
    "2026/01/05 10:00:00,Teen T,teen@test.invalid,,16,Uganda,Gulu,",
    "2026/01/06 10:00:00,Grace N,grace@test.invalid,,41,Uganda,Mbale,",
    "2026/01/07 10:00:00,\"Sam, Jr\",,,38,Uganda,Jinja,"
  ].join("\n"));
  const members = [
    { id: "m1", first_name: "Amina", age: "29", location: "Uganda", user_id: "", email: "amina@test.invalid", approved: "false" },
    { id: "m2", first_name: "Kabo", age: "33", location: "Botswana", user_id: "u2", approved: "true" },
    { id: "m3", first_name: "Sam", age: "38", location: "Uganda", user_id: "", approved: "false" }
  ];
  const authUsers = [{ id: "u2", email: "kabo@test.invalid", email_confirmed_at: "2026-01-04" }, { id: "u9", email: "grace@test.invalid", email_confirmed_at: "" }];
  const report = reconcile({ formRows, members, authUsers });
  const byRow = Object.fromEntries(report.results.map(r => [r.form_row, r]));
  // Rows 2 and 3 share an email: both are flagged, neither is merged.
  assert.equal(byRow[2].status, "possible_duplicate");
  assert.equal(byRow[3].duplicate_group, byRow[2].duplicate_group);
  assert.equal(byRow[2].matched_member_id, "m1");
  assert.equal(byRow[2].phone, "+256772000001");
  assert.equal(byRow[2].referral_code, "REF1");
  assert.equal(byRow[3].status, "possible_duplicate");
  assert.equal(byRow[4].status, "matched_profile");
  assert.equal(byRow[5].status, "ineligible");
  assert.equal(byRow[6].status, "needs_profile");
  assert.equal(byRow[7].status, "possible_duplicate", "name+age resemblance is flagged, not linked");
  assert.equal(byRow[7].matched_member_id, "");
  assert.equal(report.totals.form_rows, 6);
  assert.equal(normalizePhone("71234567", "Botswana"), "+26771234567");
  const sql = archiveSql(report.results);
  assert.match(sql, /on conflict \(source_row_hash\) do nothing/);
  assert.doesNotMatch(sql, /update public\.members|insert into public\.members/);
  assert.match(sql, /"Full name": "Sam, Jr"|Sam, Jr/);
});

test("reconciliation reads the real Google Form layout: combined contact answer, age groups, nickname, 'other country' question", async () => {
  const { reconcile, parseCsv, parsePhone, toCsv, REDACTED_FIELDS, summaryMarkdown } = await import("../tools/reconcile-registrations.mjs");
  // Question titles copied from the live form; every answer below is invented.
  const header = [
    "Timestamp", "1. 🌍 Where are you currently based? ", "  2. 📍 What city or town are you in?  ", "  3. ❤️ What's your gender?  ",
    "  4. 🎂 What age group are you in?  ", "  6. 🎯 What age range would you prefer?  ",
    "8. 🌍❤️ Would you consider dating someone from the other country? ", "  16. 👋 What should we call you?  ", "  17. 📸 Add your profile photo  ",
    "18. WhatsApp or phone number — please include your country code. 📱 You may also provide your email address. 📧  ", "Column 19",
    "\"Referral Code (if someone invited you)\nDid someone invite you to join our dating platform? If yes, enter their referral code.\n\""
  ].join(",");
  const row = (when, country, city, age, other, name, contact, ref = "") =>
    [when, country, city, "Female", age, "25–34", `"${other}"`, `"${name}"`, "https://drive.example.invalid/photo-" + name.length, `"${contact}"`, "", ref].join(",");
  const formRows = parseCsv([header,
    row("10/7/2026 18:00:00", "Uganda", "Kampala", "25–29", "🤔 Maybe", "Testa", "+256 700 000 001", "UG1"),
    row("10/7/2026 19:00:00", "Botswana", "Gaborone", "45–49", "❤️ Yes, definitely", "Testb", "+26770000002 testb@example.invalid"),
    row("10/8/2026 08:00:00", "Uganda", "Gulu", "18–24", "💕 Yes, if we connect well", "Testc", "0700000003"),
    row("10/8/2026 09:00:00", "Uganda", "Gulu", "18–24", "💕 Yes, if we connect well", "Testd", "+256700000003"),
    row("10/9/2026 10:00:00", "🌍 Another country", "Gulu city", "30–34", "❤️ Yes, definitely", "Teste", "+256700000006 country code UG1"),
    row("10/9/2026 11:00:00", "Uganda", "Kampala", "25–29", "🤔 Maybe", "someone@example.invalid", "Ok"),
    row("10/9/2026 12:00:00", "Botswana", "Maun", "50–54", "🤔 Maybe", "Yes", "Ok"),
    row("10/10/2026 12:00:00", "Uganda", "Kampala", "25–29", "🤔 Maybe", "Testa", "+256700000009"),
    row("10/10/2026 13:00:00", "Botswana", "Lobatse", "55+", "🤔 Maybe", "Testf", "00267 71 000 010"),
    row("10/11/2026 13:00:00", "Uganda", "Jinja", "30–34", "🤔 Maybe", "Testg", "+256700000011")
  ].join("\n"));
  assert.equal(formRows.length, 10);
  const members = [
    { id: "m-b", first_name: "Testb", age: "46", location: "Botswana", user_id: "u-b", approved: "false" },
    { id: "m-g", first_name: "Testg", age: "33", location: "Uganda", user_id: "", approved: "false" }
  ];
  const authUsers = [{ id: "u-b", email: "testb@example.invalid", email_confirmed_at: "2026-10-17" }];
  const report = reconcile({ formRows, members, authUsers });
  const cols = report.columns;
  assert.match(cols.country, /^1\./, "country is Q1, not the 'other country' question");
  assert.match(cols.age, /^4\./, "age group is Q4, not the preferred range");
  assert.match(cols.name, /16\./);
  assert.equal(cols.phone, cols.email, "one combined contact question supplies both");
  const r = Object.fromEntries(report.results.map(x => [x.form_row, x]));
  assert.equal(r[3].status, "matched_profile", "email in the combined answer confirms the linked member");
  assert.equal(r[3].matched_member_id, "m-b");
  assert.equal(r[4].phone, "+256700000003");
  assert.ok(r[4].flags.includes("phone_country_code_assumed"));
  assert.equal(r[4].status, "possible_duplicate");
  assert.equal(r[5].duplicate_group, r[4].duplicate_group, "same phone → same review group, nothing merged");
  assert.equal(r[6].status, "needs_verification", "'Another country' is checked by hand, not rejected");
  assert.equal(r[6].phone, "+256700000006", "a trailing note such as UG1 is not glued onto the number");
  assert.ok(r[7].flags.includes("email_written_in_name_field") && r[7].flags.includes("name_needs_review"));
  assert.equal(r[7].has_email, true);
  assert.equal(r[8].status, "incomplete");
  assert.equal(r[2].status, "possible_duplicate", "same nickname, age group and country is flagged…");
  assert.match(r[2].notes, /name-only — not proof/, "…but explicitly not treated as the same person");
  assert.equal(r[2].matched_member_id, "");
  assert.equal(r[10].phone, "+26771000010");
  assert.equal(r[10].age_group, "55+");
  assert.equal(r[11].status, "possible_duplicate", "name + age resemblance to a member is review-only");
  assert.equal(r[11].matched_member_id, "");
  assert.ok(report.results.every(x => x.status !== "ineligible"), "every age group here is 18+");
  assert.deepEqual(report.duplicateGroups, { contact: 1, contact_rows: 2, name_only: 1, name_only_rows: 2 });
  assert.equal(parsePhone("+256781000000. Email. a@b.invalid", "Uganda").phone, "+256781000000");

  // A phone-only registration is confirmed through the phone on the person's Auth account.
  const byPhone = reconcile({ formRows: formRows.slice(9, 10), members: [{ id: "m-p", first_name: "Other", age: "31", location: "Uganda", user_id: "u-p", approved: "false" }],
    authUsers: [{ id: "u-p", email: "", phone: "256700000011", email_confirmed_at: "2026-10-17" }] });
  assert.equal(byPhone.results[0].status, "matched_profile");
  assert.equal(byPhone.results[0].matched_member_id, "m-p");

  // The shareable outputs never contain names, contact details or photo links.
  const shareable = toCsv(report.results, REDACTED_FIELDS) + summaryMarkdown(report, { members: true, auth: true });
  for (const secret of ["Testa", "Testb", "example.invalid", "drive.example", "+256700", "700 000 001", "+26771000010"]) {
    assert.ok(!shareable.includes(secret), "redacted output leaks " + secret);
  }
});

test("the first-100-free offer is gone and payments are described as off during testing", async () => {
  for (const path of ["index.html", "account.html", "dashboard.html", "discover.html", "messages.html", "admin/index.html", "agent/dashboard.html"]) {
    const html = await read(path);
    assert.doesNotMatch(html, /first 100[^.<]{0,40}free|join free|free founding|founding members? (can )?join|free (member )?account|for free/i, path + " still advertises a free-membership offer");
  }
  assert.match(await read("index.html"), /registration does not require any payment/i);
  for (const path of ["index.html", "account.html", "login.html", "dashboard.html"]) {
    // No payment collection anywhere: no card fields, no payment provider scripts.
    assert.doesNotMatch(await read(path), /card number|cvv|stripe|paystack|flutterwave|checkout/i, path);
  }
});

test("every member-facing page shows a clickable contact email", async () => {
  for (const path of ["index.html", "account.html", "login.html", "privacy.html", "dashboard.html", "discover.html", "messages.html"]) {
    assert.match(await read(path), /<a href="mailto:pikeinsightsug@gmail\.com"/, path);
  }
  for (const path of ["account.html", "dashboard.html", "assets/member-core.js"]) {
    assert.doesNotMatch(await read(path), /contact (the owner|support)/i, path + " still points to an unnamed contact");
  }
});

test("the owner console expects exactly the admin-members version in the repository", async () => {
  const fn = (await read("supabase/functions/admin-members/index.ts")).match(/const FUNCTION_VERSION = "([^"]+)"/);
  const page = (await read("admin/index.html")).match(/const EXPECTED_FUNCTION_VERSION = "([^"]+)"/);
  assert.ok(fn && page, "both version markers exist");
  assert.equal(page[1], fn[1], "bump both together when admin-members changes");
});

test("every page uses the one name P.K CONNECT – Find Your Person", async () => {
  for (const page of ["index.html", "account.html", "login.html", "dashboard.html", "discover.html", "messages.html", "privacy.html", "about.html", "safety.html", "admin/index.html", "404.html"]) {
    const html = await read(page);
    assert.match(html, /<title>[^<]*P\.K CONNECT – Find Your Person[^<]*<\/title>/, page + " tab title");
    // No leftover bare "Find Your Person" without the P.K CONNECT name in front of it.
    assert.doesNotMatch(html.replace(/P\.K CONNECT – Find Your Person/g, "").replace(/class="brand-sub">Find Your Person</g, ""), /Find Your Person/, page + " uses the full name");
    if (page !== "admin/index.html") assert.match(html, /class="brand-main">P\.K <span>CONNECT<\/span>/, page + " header logo");
    assert.doesNotMatch(html, /PikeConnection|Pike<span>/i, page + " must not be renamed");
  }
});

test("customer-facing pages no longer describe the site as a test or preview", async () => {
  for (const page of ["index.html", "account.html", "login.html", "dashboard.html", "discover.html", "messages.html", "privacy.html", "about.html", "safety.html"]) {
    assert.doesNotMatch(await read(page), /testing phase|during testing|deploy preview|\bbeta\b/i, page);
  }
});

test("a missing page sends visitors to the homepage instead of a dead end", async () => {
  const html = await read("404.html");
  assert.match(html, /var target = base \+ location\.search \+ location\.hash;/, "email-link details are kept");
  assert.match(html, /location\.replace\(target\)/);
  assert.match(html, /"\/dating-platform\/" : "\/"/, "works on GitHub Pages and Netlify");
  assert.match(html, /<a class="btn" id="home" href="\.\/">/, "a manual link if scripts are blocked");
});

test("visitors can see who runs the site and that we never ask for money privately", async () => {
  const home = await read("index.html"), about = await read("about.html"), safety = await read("safety.html");
  for (const html of [home, about, safety]) assert.match(html, /never ask you for money in a private message/);
  assert.match(home, /href="about\.html"/); assert.match(home, /href="safety\.html"/);
  assert.match(about, /Pike Insights/); assert.match(about, /pikeinsightsug@gmail\.com/);
  assert.match(safety, /Report/); assert.match(safety, /Block/);
});

test("the official founder account is recognisable and cannot be imitated", async () => {
  for (const name of ["Pike – Founder", "P.K Connect Team", "PK CONNECT", "Official", "Site admin"]) {
    assert.equal(core.isReservedName(name), true, name + " is reserved");
  }
  for (const name of ["Tiago", "Supporter Ann", "Pike", "Grace"]) assert.equal(core.isReservedName(name), false, name + " is allowed");
  const failing = { rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }) };
  assert.deepEqual(await core.listOfficialAccounts(failing), [], "pages keep working before the database setup is applied");
  const throwing = { rpc: async () => { throw new Error("offline"); } };
  assert.deepEqual(await core.listOfficialAccounts(throwing), []);
  const discover = await read("discover.html"), messages = await read("messages.html"), dashboard = await read("dashboard.html");
  for (const html of [discover, messages, dashboard]) assert.match(html, /listOfficialAccounts\(db\)/);
  assert.match(discover, /not a dating profile/);
  const safety = await read("safety.html"), home = await read("index.html");
  for (const html of [safety, home]) assert.match(html, /only official account/);
  const sql = await read("supabase/official_account.sql");
  assert.match(sql, /m\.is_official = false/, "official accounts stay out of discovery");
  assert.doesNotMatch(sql, /grant update \(is_official\)/i, "members can never make themselves official");
});

test("pages load code only from this site and carry a security policy", async () => {
  const { createHash } = await import("node:crypto");
  const hash = (buf) => createHash("sha256").update(buf).digest("hex");
  const vendored = await readFile(new URL("assets/vendor/supabase-js-2.117.2.js", repo));
  const installed = await readFile(new URL("node_modules/@supabase/supabase-js/dist/umd/supabase.js", repo)).catch(() => null);
  if (installed) assert.equal(hash(vendored), hash(installed), "the self-hosted library is the exact pinned release");
  const pages = ["404.html", "about.html", "account.html", "dashboard.html", "discover.html", "index.html", "login.html",
    "messages.html", "privacy.html", "safety.html", "admin/index.html", "agent/dashboard.html"];
  for (const path of pages) {
    const html = await read(path);
    assert.match(html, /http-equiv="Content-Security-Policy"/, path + " has a security policy");
    assert.match(html, /object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'none'/, path + " blocks plugins, base and form hijacking");
    assert.doesNotMatch(html, /<script[^>]+src="https?:/i, path + " loads no script from another website");
  }
  const core = await read("assets/member-core.js"), admin = await read("admin/index.html");
  for (const text of [core, admin]) assert.match(text, /window\.top !== window\.self/, "refuses to run inside another site's frame");
});

test("members can join from any country, and every part of the platform uses the same list", async () => {
  const { COUNTRIES: shared } = await import("../supabase/functions/_shared/countries.js");
  assert.deepEqual(core.COUNTRIES, shared, "website and owner function use the same countries");
  const sql = await read("supabase/worldwide_members.sql");
  const body = sql.slice(sql.indexOf("= any (array["), sql.indexOf("]::text[]"));
  const fromSql = [...body.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  assert.deepEqual(fromSql, shared, "the database accepts exactly the same countries");
  assert.equal(new Set(shared).size, shared.length, "no duplicates");
  for (const country of ["Uganda", "Botswana", "Kenya", "South Africa", "United Kingdom", "United States"]) assert.ok(shared.includes(country), country);
  const signup = await read("account.html"), discover = await read("discover.html"), dashboard = await read("dashboard.html"), admin = await read("admin/index.html");
  for (const html of [signup, discover, dashboard, admin]) {
    assert.match(html, /fillCountrySelect\(/, "country choices come from the shared list");
    assert.doesNotMatch(html, /<option>Uganda<\/option>/, "no page is limited to Uganda and Botswana");
  }
  assert.doesNotMatch(await read("supabase/functions/admin-members/index.ts"), /\["Uganda", "Botswana"\]/);
});
