// Scam protection in Messages: contact details held back between strangers, the money warning,
// and reporting from the chat. Every person is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile, ALL, SUPABASE } from "./harness.mjs";
import { TEST_SERVICE_KEY } from "./gateway.mjs";
import { loadAdminFunction } from "./edge-runtime.mjs";

const OWNER = "owner@test.invalid";

const FILES = [...ALL, "supabase/smart_discovery.sql", "supabase/question_of_the_day.sql", "supabase/likes_and_matches.sql", "supabase/safety_protection.sql"];

test("scam protection in messages", async (t) => {
  const env = await setup("e2e_safety", FILES);
  t.after(() => env.close());
  env.gateway.options.adminFunction = await loadAdminFunction({
    SUPABASE_URL: env.gateway.url, SUPABASE_ANON_KEY: "anon-test", SUPABASE_SERVICE_ROLE_KEY: TEST_SERVICE_KEY, ADMIN_EMAIL: OWNER
  });
  await env.sql("insert into auth.users (email, email_confirmed_at) values ($1, now())", [OWNER]);
  env.gateway.passwords.set(OWNER, "Owner-pass-123");
  await env.member("rudo@test.invalid", profile("Rudo", { gender: "Woman", location: "Zimbabwe", city: "Harare" }), { approved: true });
  await env.member("conman@test.invalid", profile("Conman", { gender: "Man", location: "Kenya", city: "Nairobi" }), { approved: true });
  const id = async name => (await env.sql("select id from public.members where first_name = $1", [name])).rows[0].id;
  const rudo = await id("Rudo");
  const conman = await id("Conman");

  // A stranger cannot send a phone number in the first messages.
  const him = await env.newPage();
  await env.login(him, "conman@test.invalid");
  await him.waitForURL(/discover\.html/);
  await him.goto(env.base + "messages.html?member=" + rudo);
  await him.waitForSelector("#compose:not(.hidden)");
  assert.match(await him.textContent(".safety"), /Never send money/);
  await him.fill("#body", "Hello beautiful, WhatsApp me on 0771 234 567");
  await him.click("#compose button[type=submit]");
  await him.waitForFunction(() => /For your safety/.test(document.getElementById("status").textContent));
  assert.equal((await env.sql("select count(*)::int as n from public.member_messages")).rows[0].n, 0, "the number was not sent");

  // A money request is delivered, with a warning for the receiver.
  await him.fill("#body", "Please send me money for transport so I can visit you");
  await him.click("#compose button[type=submit]");
  await him.waitForSelector(".bubble.mine");

  const her = await env.newPage({ mobile: true });
  await env.login(her, "rudo@test.invalid");
  await her.waitForURL(/discover\.html/);
  await her.goto(env.base + "messages.html?member=" + conman);
  await her.waitForSelector(".bubble.theirs .warn");
  assert.match(await her.textContent(".bubble.theirs .warn"), /Never send money/);

  // She reports him from the chat.
  await her.click("#report");
  await her.selectOption("#report-form select[name=reason]", "Scam or payment request");
  await her.fill("#report-form input[name=details]", "Asked me for transport money");
  await her.click("#report-form button[type=submit]");
  await her.waitForFunction(() => /Thank you/.test(document.getElementById("status").textContent));
  const report = (await env.sql("select reason, details from public.member_reports where reported_member_id = $1", [conman])).rows;
  assert.deepEqual(report, [{ reason: "Scam or payment request", details: "Asked me for transport money" }]);

  // Two more members report him: after 3 different people he is paused automatically.
  for (const name of ["Tendai", "Amara"]) {
    await env.member(name.toLowerCase() + "@test.invalid", profile(name, { gender: "Woman" }), { approved: true });
    await env.sql("insert into public.member_reports (reporter_member_id, reported_member_id, reason) values ($1, $2, 'Scam or payment request')", [await id(name), conman]);
  }
  assert.deepEqual((await env.sql("select approved, safety_hold from public.members where id = $1", [conman])).rows[0], { approved: false, safety_hold: true });

  // The owner sees him paused in the report queue and bans him.
  const owner = await env.newPage();
  await owner.goto(env.base + "admin/");
  await owner.fill("#project", SUPABASE); await owner.fill("#anon", "sb_publishable_test");
  await owner.fill("#email", OWNER); await owner.fill("#password", "Owner-pass-123");
  await owner.click("#signin");
  await owner.waitForSelector("#reports article.member");
  const card = owner.locator("#reports article.member").filter({ hasText: "Conman" });
  assert.match(await card.textContent(), /3 reports/);
  assert.match(await card.textContent(), /PAUSED automatically/);
  assert.match(await owner.textContent("#reports-title"), /\(3\)/);
  await card.getByRole("button", { name: "🚫 Ban Conman" }).click();
  await owner.waitForFunction(() => /No open reports/.test(document.getElementById("reports").textContent));
  assert.deepEqual((await env.sql("select approved, safety_hold, banned from public.members where id = $1", [conman])).rows[0], { approved: false, safety_hold: false, banned: true });
  const userId = (await env.sql("select user_id from public.members where id = $1", [conman])).rows[0].user_id;
  assert.ok(env.gateway.bans.has(userId), "the banned member cannot sign in");
  assert.equal((await env.sql("select count(*)::int as n from public.member_reports where status = 'open'")).rows[0].n, 0, "his reports are closed");
});
