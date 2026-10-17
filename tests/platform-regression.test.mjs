import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const repo = new URL("../", import.meta.url);
const read = async (path) => readFile(new URL(path, repo), "utf8");
const scriptBlocks = (html) => [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);

test("inline application scripts parse", async () => {
  for (const path of ["account.html", "dashboard.html", "discover.html", "admin/index.html"]) {
    const html = await read(path);
    const scripts = scriptBlocks(html);
    assert.ok(scripts.length, path + " has an inline script");
    scripts.forEach((source, index) => new vm.Script(source, { filename: path + "#" + index }));
  }
});

test("login reuses linked profiles and never creates profiles; fresh registration creates one pending profile", async () => {
  const html = await read("account.html");
  assert.ok(html.includes("await finishSignIn(data.user, true);"));
  assert.ok(html.includes("If no profile is linked, contact the owner"));
  const match = html.match(/async function ensureProfile\(user, allowCreate = false\) \{[\s\S]*?\n  \}\n  async function finishSignIn/);
  assert.ok(match, "ensureProfile function exists");
  const source = match[0].replace(/\n  async function finishSignIn[\s\S]*$/, "");
  const ensureProfile = new Function("db", "profileFromMetadata", "return (" + source + ");");

  async function run({ existing = [], allowCreate = false } = {}) {
    const state = { inserts: [], reads: 0 };
    const db = { from(table) {
      assert.equal(table, "members");
      return {
        select() { return this; },
        eq() { return this; },
        limit: async () => { state.reads++; return { data: existing, error: null }; },
        insert(profile) {
          state.inserts.push(profile);
          return { select() { return this; }, single: async () => ({ data: { id: "new-id", approved: profile.approved }, error: null }) };
        }
      };
    } };
    const metadata = { first_name: "Test", age: 30, gender: "Woman", location: "Uganda", city: "Kampala", relationship_goal: "Friendship", bio: "Test profile" };
    const profileFromMetadata = (user) => ({ user_id: user.id, ...metadata, approved: false });
    const result = await ensureProfile(db, profileFromMetadata)({ id: "auth-id" }, allowCreate);
    return { result, state };
  }

  const loginWithoutProfile = await run();
  assert.equal(loginWithoutProfile.result, null);
  assert.equal(loginWithoutProfile.state.inserts.length, 0);

  const existingLinked = await run({ existing: [{ id: "existing-id", approved: true }] });
  assert.deepEqual(existingLinked.result, { id: "existing-id", approved: true });
  assert.equal(existingLinked.state.inserts.length, 0);

  const signup = await run({ allowCreate: true });
  assert.equal(signup.result.id, "new-id");
  assert.equal(signup.state.inserts.length, 1);
  assert.equal(signup.state.inserts[0].user_id, "auth-id");
  assert.equal(signup.state.inserts[0].approved, false);
});

test("dashboard never inserts a member row and gates photo upload on a linked profile", async () => {
  const html = await read("dashboard.html");
  assert.doesNotMatch(html, /\.from\(["']members["']\)\s*\.insert/);
  assert.match(html, /\.eq\(["']user_id["'],\s*user\.id\)/);
  assert.match(html, /photoButton\.disabled\s*=\s*photoUploading\s*\|\|\s*!file\s*\|\|\s*!memberProfile/);
});

test("photo request timeout aborts a stalled Supabase request and classifies it for retry", async () => {
  const html = await read("dashboard.html");
  const start = html.indexOf("  const PHOTO_REQUEST_TIMEOUT_MS");
  const end = html.indexOf("  const db = window.supabase.createClient", start);
  assert.ok(start >= 0 && end > start);
  let source = html.slice(start, end).replace("PHOTO_REQUEST_TIMEOUT_MS = 60000", "PHOTO_REQUEST_TIMEOUT_MS = 10");
  const makeFetch = new Function("SUPABASE_URL", "fetch", "setTimeout", "clearTimeout", "AbortController", "URL", "Request", source + "; return photoRequestFetch;");
  const controlledFetch = (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const request = makeFetch("https://cyvkpcwjkeifpvegwhpt.supabase.co", controlledFetch, setTimeout, clearTimeout, AbortController, URL, Request);
  await assert.rejects(request("https://cyvkpcwjkeifpvegwhpt.supabase.co/storage/v1/object/test"), (error) => {
    assert.equal(error.code, "PHOTO_REQUEST_TIMEOUT");
    return /timed out/i.test(error.message);
  });
  assert.match(html, /took longer than 60 seconds[\s\S]*try again/i);
  assert.match(html, /finally \{\s*photoUploading = false; photoInput\.disabled = false/);
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
