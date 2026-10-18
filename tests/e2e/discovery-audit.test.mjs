// Discovery audit with several independent accounts, two of them sharing a display name, so
// that "not yourself" is proven to depend on the signed-in account rather than the name.
// Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile } from "./harness.mjs";

test("discovery audit: independent accounts, same display names, pending and unlinked records", async (t) => {
  const env = await setup("e2e_discovery_audit");
  t.after(() => env.close());
  const samA = await env.member("sam-a@test.invalid", profile("Sam", { age: 30 }), { approved: true });
  await env.member("sam-b@test.invalid", profile("Sam", { age: 31, location: "Botswana" }), { approved: true });
  await env.member("lee@test.invalid", profile("Lee", { age: 33, gender: "Man" }), { approved: true });
  await env.member("pat@test.invalid", profile("Pat", { age: 29 })); // pending
  await env.sql("insert into public.members (first_name, age, gender, location, relationship_goal, bio, approved) values ('Old', 40, 'Man', 'Uganda', 'Marriage', 'x', true)"); // approved but no login
  const ids = Object.fromEntries((await env.sql("select first_name || '-' || age as k, id from public.members")).rows.map(r => [r.k, r.id]));
  const seen = async page => (await page.locator("#profiles .card h2").allTextContents()).sort();

  const expected = {
    "sam-a@test.invalid": { me: "Sam", others: ["Lee, 33", "Sam, 31"] },
    "sam-b@test.invalid": { me: "Sam", others: ["Lee, 33", "Sam, 30"] },
    "lee@test.invalid": { me: "Lee", others: ["Sam, 30", "Sam, 31"] }
  };
  const pages = {};
  for (const [email, want] of Object.entries(expected)) {
    await t.test(`${email} sees every other approved member and never itself`, async () => {
      const page = await env.newPage();
      await env.login(page, email);
      await page.waitForURL(/discover\.html$/);
      await page.waitForSelector("#profiles .card");
      assert.deepEqual(await seen(page), want.others);
      assert.match(await page.textContent("#signed-in"), new RegExp(`^Signed in as ${want.me} \\(${email.replace(/\./g, "\\.")}\\)$`));
      pages[email] = page;
    });
  }

  await t.test("a pending member cannot browse or open profiles, even by calling the database directly", async () => {
    const page = await env.newPage();
    await env.login(page, "pat@test.invalid");
    await page.waitForURL(/dashboard\.html$/);
    const direct = await page.evaluate(async id => {
      const db = window.FYP.createClient();
      const browse = await db.rpc("browse_member_profiles", {});
      const one = await db.rpc("get_member_profile", { p_member_id: id });
      const table = await db.from("members").select("first_name");
      return { browse: browse.error && browse.error.code, one: one.error && one.error.code, table: (table.data || []).map(r => r.first_name) };
    }, ids["Sam-30"]);
    assert.deepEqual(direct, { browse: "42501", one: "42501", table: ["Pat"] });
    await page.goto(env.base + "discover.html");
    await page.waitForFunction(() => /awaiting manual review/.test(document.getElementById("status").textContent));
    assert.equal(await page.locator("#profiles .card").count(), 0);
  });

  await t.test("one profile per login: a member cannot create a second profile for the same account", async () => {
    const attempt = await pages["sam-a@test.invalid"].evaluate(async userId => {
      const db = window.FYP.createClient();
      const { error } = await db.from("members").insert({ user_id: userId, first_name: "Sam2", age: 30, gender: "Woman", location: "Uganda", city: "Kampala", relationship_goal: "Marriage", bio: "Second profile attempt", approved: false });
      return error && error.code;
    }, samA);
    assert.ok(attempt, "the insert is refused");
    assert.equal((await env.sql("select count(*)::int as n from public.members where user_id = $1", [samA])).rows[0].n, 1);
  });

  await t.test("messages between the two Sams are attributed by account, both ways, and survive logout", async () => {
    const a = pages["sam-a@test.invalid"], b = pages["sam-b@test.invalid"];
    await a.goto(env.base + "messages.html?member=" + ids["Sam-31"]);
    await a.waitForSelector("#compose:not(.hidden)");
    await a.fill("#body", "Hello from Sam A"); await a.click("#compose button[type=submit]");
    await a.waitForSelector(".bubble.mine");
    await b.goto(env.base + "messages.html?member=" + ids["Sam-30"]);
    await b.waitForSelector(".bubble.theirs");
    await b.fill("#body", "Reply from Sam B"); await b.click("#compose button[type=submit]");
    await b.waitForFunction(() => document.querySelectorAll(".bubble").length === 2);
    const rows = (await env.sql("select sender_member_id as s, recipient_member_id as r, body from public.member_messages order by created_at")).rows;
    assert.deepEqual(rows, [
      { s: ids["Sam-30"], r: ids["Sam-31"], body: "Hello from Sam A" },
      { s: ids["Sam-31"], r: ids["Sam-30"], body: "Reply from Sam B" }
    ]);
    await a.click("#signout"); await a.waitForURL(/signedout=1/);
    await env.login(a, "sam-a@test.invalid"); await a.waitForURL(/discover\.html$/);
    await a.goto(env.base + "messages.html?member=" + ids["Sam-31"]);
    await a.waitForFunction(() => document.querySelectorAll(".bubble").length === 2);
    assert.match(await a.textContent(".bubble.mine"), /Hello from Sam A/);
    assert.match(await a.textContent(".bubble.theirs"), /Reply from Sam B/);
    // Lee, a third approved member, cannot read their conversation.
    const lee = await pages["lee@test.invalid"].evaluate(async id => {
      const db = window.FYP.createClient();
      return (await db.rpc("get_conversation", { p_other_member_id: id })).data;
    }, ids["Sam-30"]);
    assert.deepEqual(lee, []);
  });
});
