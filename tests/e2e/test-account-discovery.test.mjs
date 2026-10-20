// The owner's test accounts can see genuine approved members in Discover Members, but cannot
// message them, and genuine members never see test accounts. Reproduces the live report:
// signed in as Alp (test account), only Tiago (test account) was shown and a genuine approved member was missing.
// Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile } from "./harness.mjs";

test("test accounts can view, but not message, genuine approved members", async (t) => {
  const env = await setup("e2e_test_account_discovery");
  t.after(() => env.close());
  await env.member("tiago@test.invalid", profile("Tiago", { age: 42, gender: "Man", location: "Botswana" }), { approved: true });
  await env.member("alp@test.invalid", profile("Alp", { age: 40, gender: "Man", location: "Botswana" }), { approved: true });
  await env.sql("update public.members set is_test_account = true");
  await env.member("genuine@test.invalid", profile("Genuine", { age: 29, gender: "Man", location: "Uganda", city: "Lira" }), { approved: true });
  await env.member("pending@test.invalid", profile("Pending", { age: 30 }), { approved: false });
  const fp = async () => (await env.sql("select md5(string_agg(to_jsonb(m)::text, '|' order by id)) f from public.members m")).rows[0].f;
  const before = await fp();

  const discover = async page => {
    await page.waitForURL(/discover\.html$/);
    await page.waitForFunction(() => /Showing|no other approved/i.test(document.getElementById("status").textContent));
    return { names: (await page.locator("#profiles .card h2").allTextContents()).sort(), status: await page.textContent("#status") };
  };

  await t.test("Alp (test account) sees the genuine member and Tiago, never the pending member", async () => {
    const alp = await env.newPage();
    await env.login(alp, "alp@test.invalid");
    const seen = await discover(alp);
    assert.deepEqual(seen.names, ["Genuine, 29", "Tiago, 42"]);
    assert.match(seen.status, /Showing 2 of 2 approved member profiles/);

    // The 18–60 filter from the report keeps both.
    await alp.fill("[name=min_age]", "18"); await alp.fill("[name=max_age]", "60");
    await alp.locator("#filters button[type=submit]").click();
    await alp.waitForFunction(() => /Showing 2 of 2/.test(document.getElementById("status").textContent));

    // The genuine profile opens, without a message button; Tiago's keeps it.
    await alp.getByRole("button", { name: "View profile of Genuine" }).click();
    await alp.waitForFunction(() => /test account/.test(document.getElementById("dialog-status").textContent));
    assert.equal(await alp.isVisible("#dialog-message"), false, "no message button for a genuine member");
    await alp.click("#dialog-close");
    await alp.getByRole("button", { name: "View profile of Tiago" }).click();
    await alp.waitForSelector("#dialog-message:visible");
    await alp.click("#dialog-close");

    // A direct link to message the genuine member is refused clearly, and the server refuses a send.
    const genuineId = (await env.sql("select id from public.members where first_name = 'Genuine'")).rows[0].id;
    await alp.goto(env.base + "messages.html?member=" + genuineId);
    await alp.waitForFunction(() => /not available for messaging/.test(document.getElementById("status").textContent));
    const sent = await alp.evaluate(async id => (await window.FYP.createClient().rpc("send_member_message", { p_recipient_member_id: id, p_body: "hi" })).error?.code, genuineId);
    assert.equal(sent, "42501");
  });

  await t.test("a genuine member never sees the test accounts", async () => {
    const genuine = await env.newPage({ mobile: true });
    await env.login(genuine, "genuine@test.invalid");
    const seen = await discover(genuine);
    assert.deepEqual(seen.names, []);
    assert.match(seen.status, /no other approved member profiles yet/i);
  });

  await t.test("no member data changed", async () => {
    assert.equal(await fp(), before);
    assert.equal((await env.sql("select count(*)::int n from public.member_messages")).rows[0].n, 0);
  });
});
