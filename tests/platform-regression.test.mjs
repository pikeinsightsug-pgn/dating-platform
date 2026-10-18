import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const repo = new URL("../", import.meta.url);
const read = async (path) => readFile(new URL(path, repo), "utf8");
const scriptBlocks = (html) => [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);

test("inline application scripts parse", async () => {
  for (const path of ["account.html", "dashboard.html", "discover.html", "messages.html", "admin/index.html"]) {
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
  for (const user of [{ id: "auth-id", user_metadata: {} }, signupUser({ profile_type: undefined }), signupUser({ age: 16 }), signupUser({ location: "Kenya" })]) {
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
  assert.match(html, /photoButton\.disabled\s*=\s*photoUploading\s*\|\|\s*!file\s*\|\|\s*!memberProfile/);
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
  for (const path of ["index.html", "account.html", "dashboard.html", "discover.html", "messages.html", "admin/index.html", "assets/member-core.js"]) {
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
  assert.equal(byRow[2].status, "needs_account");
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
