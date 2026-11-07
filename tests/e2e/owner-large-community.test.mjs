// The owner console keeps showing every member once the community passes 1000 profiles
// (a single database request returns at most 1000 rows). Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile, SUPABASE } from "./harness.mjs";
import { TEST_SERVICE_KEY } from "./gateway.mjs";
import { loadAdminFunction } from "./edge-runtime.mjs";

const OWNER = "owner@test.invalid";
const MEMBERS = 1205;

test("the owner console lists every member in a large community", async (t) => {
  const env = await setup("e2e_owner_large_community");
  t.after(() => env.close());
  env.gateway.options.adminFunction = await loadAdminFunction({
    SUPABASE_URL: env.gateway.url, SUPABASE_ANON_KEY: "anon-test", SUPABASE_SERVICE_ROLE_KEY: TEST_SERVICE_KEY, ADMIN_EMAIL: OWNER
  });
  await env.sql("insert into auth.users (email, email_confirmed_at) values ($1, now())", [OWNER]);
  env.gateway.passwords.set(OWNER, "Owner-pass-123");
  // The first member joined long ago, so with newest-first ordering they are on the last page.
  await env.member("first@test.invalid", profile("Firstever", { location: "Botswana", city: "Francistown" }), { approved: true });
  await env.sql("update auth.users set created_at = now() - interval '2 years' where email = 'first@test.invalid'");
  await env.sql("update public.members set created_at = now() - interval '2 years' where first_name = 'Firstever'");
  await env.sql(
    `insert into auth.users (email, email_confirmed_at, raw_user_meta_data)
     select 'member' || n || '@test.invalid', now(), $1::jsonb || jsonb_build_object('first_name', 'Member' || n)
     from generate_series(2, $2) n`, [JSON.stringify(profile("Member")), MEMBERS]);
  assert.equal(Number((await env.sql("select count(*) from public.members")).rows[0].count), MEMBERS);

  const owner = await env.newPage();
  await owner.goto(env.base + "admin/");
  await owner.fill("#project", SUPABASE); await owner.fill("#anon", "sb_publishable_test");
  await owner.fill("#email", OWNER); await owner.fill("#password", "Owner-pass-123");
  await owner.click("#signin");
  await owner.waitForFunction(() => /Loaded [\d,]+ profiles/.test(document.getElementById("status").textContent), null, { timeout: 60000 });
  const status = await owner.textContent("#status");
  assert.match(status.replace(/,/g, ""), new RegExp("Loaded " + MEMBERS + " profiles"), status);
  assert.ok(await owner.locator("#members article.member h3", { hasText: "Firstever" }).count(), "the oldest member is still listed");
  assert.match(await owner.textContent("#function-version"), /up to date/, "the console accepts the function version");
});
