// Two genuine approved members, one in Uganda and one in Botswana, find each other in Discover
// according to their preferences and message each other privately. Owner test accounts and
// pending members never appear to them. Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile } from "./harness.mjs";

test("genuine approved members in Uganda and Botswana discover and message each other", async (t) => {
  const env = await setup("e2e_genuine_members");
  t.after(() => env.close());
  // Owner test accounts, as in production.
  await env.member("tiago@test.invalid", profile("Tiago", { age: 42, gender: "Man", location: "Botswana" }), { approved: true });
  await env.member("alp@test.invalid", profile("Alp", { age: 40, gender: "Man", location: "Botswana" }), { approved: true });
  await env.sql("update public.members set is_test_account = true");
  // Genuine members.
  await env.member("amina@test.invalid", profile("Amina", { age: 29, gender: "Woman", location: "Uganda", city: "Kampala",
    seeking_gender: "Men", preferred_age_min: 25, preferred_age_max: 45 }), { approved: true });
  await env.member("kabo@test.invalid", profile("Kabo", { age: 34, gender: "Man", location: "Botswana", city: "Gaborone",
    seeking_gender: "Women", preferred_age_min: 22, preferred_age_max: 40 }), { approved: true });
  await env.member("lerato@test.invalid", profile("Lerato", { age: 31, gender: "Woman", location: "Botswana", city: "Maun",
    seeking_gender: "Men", preferred_age_min: 25, preferred_age_max: 45 }), { approved: true });
  await env.member("pendo@test.invalid", profile("Pendo", { age: 30, gender: "Man", location: "Uganda", city: "Jinja",
    seeking_gender: "Women", preferred_age_min: 22, preferred_age_max: 40 }), { approved: false });
  const members = async () => (await env.sql("select md5(string_agg(to_jsonb(m)::text, '|' order by id)) f from public.members m")).rows[0].f;
  const before = await members();
  const hidden = ["Alp", "Tiago", "Pendo"];

  const names = async page => {
    await page.waitForFunction(() => /Showing|No approved members|no other approved/i.test(document.getElementById("status").textContent));
    return (await page.locator("#profiles .card h2").allTextContents()).sort();
  };
  const signIn = async (email, options) => {
    const page = await env.newPage(options);
    await env.login(page, email);
    await page.waitForURL(/discover\.html$/);
    return page;
  };

  const amina = await signIn("amina@test.invalid", { mobile: true });
  const kabo = await signIn("kabo@test.invalid");

  await t.test("each sees the other across countries, following their preferences", async () => {
    assert.deepEqual(await names(amina), ["Kabo, 34"], "Amina (Uganda, seeking men) sees Kabo (Botswana)");
    assert.deepEqual(await names(kabo), ["Amina, 29", "Lerato, 31"], "Kabo (Botswana, seeking women) sees Amina (Uganda) and Lerato");
  });

  await t.test("widening every filter still never shows test accounts or pending members", async () => {
    for (const page of [amina, kabo]) {
      await page.selectOption("#filters [name=gender]", "");
      await page.selectOption("#filters [name=country]", "");
      await page.fill("#filters [name=min_age]", "18"); await page.fill("#filters [name=max_age]", "120");
      await page.locator("#filters button[type=submit]").click();
      await page.waitForFunction(() => /Showing/.test(document.getElementById("status").textContent));
      const seen = (await names(page)).join(" ");
      for (const name of hidden) assert.ok(!seen.includes(name), name + " must not appear");
    }
    assert.deepEqual(await names(amina), ["Kabo, 34", "Lerato, 31"]);
  });

  await t.test("they message each other privately, and the conversation persists", async () => {
    await amina.getByRole("button", { name: "View profile of Kabo" }).click();
    await amina.waitForSelector("#dialog-message:visible");
    await amina.click("#dialog-message");
    await amina.waitForSelector("#compose:not(.hidden)");
    await amina.fill("#body", "Hello from Kampala"); await amina.click("#compose button[type=submit]");
    await amina.waitForSelector(".bubble.mine");

    await kabo.goto(env.base + "messages.html");
    await kabo.locator("#conversations button", { hasText: "Amina" }).click();
    await kabo.waitForSelector(".bubble.theirs");
    assert.match(await kabo.textContent(".bubble.theirs"), /Hello from Kampala/);
    await kabo.fill("#body", "Hello from Gaborone"); await kabo.click("#compose button[type=submit]");
    await kabo.waitForFunction(() => document.querySelectorAll(".bubble").length === 2);

    await amina.reload();
    await amina.waitForFunction(() => document.querySelectorAll(".bubble").length === 2);
    assert.deepEqual((await amina.locator(".bubble").allTextContents()).map(text => text.match(/Hello from [A-Z][a-z]+/)[0]),
      ["Hello from Kampala", "Hello from Gaborone"]);
  });

  await t.test("other members, test accounts and pending members cannot read or join it", async () => {
    for (const email of ["lerato@test.invalid", "alp@test.invalid"]) {
      const page = await signIn(email);
      const peek = await page.evaluate(async () => {
        const db = window.FYP.createClient();
        return { conversations: ((await db.rpc("list_my_conversations")).data || []).length,
                 rows: ((await db.from("member_messages").select("body")).data || []).length };
      });
      assert.deepEqual(peek, { conversations: 0, rows: 0 }, email);
    }
    // A test account cannot message a genuine member, and a genuine member cannot message a test account.
    const ids = Object.fromEntries((await env.sql("select first_name, id from public.members")).rows.map(r => [r.first_name, r.id]));
    const alp = await signIn("alp@test.invalid");
    assert.equal(await alp.evaluate(async id => (await window.FYP.createClient().rpc("send_member_message", { p_recipient_member_id: id, p_body: "hi" })).error?.code, ids.Amina), "42501");
    assert.equal(await amina.evaluate(async id => (await window.FYP.createClient().rpc("send_member_message", { p_recipient_member_id: id, p_body: "hi" })).error?.code, ids.Tiago), "42501");
    // A genuine member cannot message a pending member either.
    assert.equal(await amina.evaluate(async id => (await window.FYP.createClient().rpc("send_member_message", { p_recipient_member_id: id, p_body: "hi" })).error?.code, ids.Pendo), "42501");

    // The pending member sees only the waiting message.
    const pendo = await env.newPage();
    await env.login(pendo, "pendo@test.invalid");
    await pendo.waitForURL(/dashboard\.html$/);
    await pendo.goto(env.base + "discover.html");
    await pendo.waitForFunction(() => /approv/i.test(document.getElementById("status").textContent));
    assert.equal(await pendo.locator("#profiles .card").count(), 0);
  });

  await t.test("no member records changed; only the two messages were added", async () => {
    assert.equal(await members(), before);
    assert.equal((await env.sql("select count(*)::int n from public.member_messages")).rows[0].n, 2);
  });
});
