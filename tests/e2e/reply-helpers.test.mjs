// Message ideas in Messages: when someone is waiting for an answer, or before the first message,
// three friendly one-tap messages built from the other member's profile. Tapping one only fills
// the box; the member still presses Send. Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile } from "./harness.mjs";

test("message ideas help members reply", async (t) => {
  const env = await setup("e2e_reply_helpers");
  t.after(() => env.close());
  await env.member("amina@test.invalid", profile("Amina", { interests: "Cooking, gospel music" }), { approved: true });
  await env.member("kabo@test.invalid", profile("Kabo", { gender: "Man", location: "Botswana", city: "Maun" }), { approved: true });
  await env.member("neo@test.invalid", profile("Neo", { city: "Gulu" }), { approved: true });
  const ids = Object.fromEntries((await env.sql("select first_name, id from public.members")).rows.map(r => [r.first_name, r.id]));
  await env.sql("insert into public.member_messages (sender_member_id, recipient_member_id, body) values ($1, $2, 'Hello Kabo, how are you?')", [ids.Amina, ids.Kabo]);

  const kabo = await env.newPage({ mobile: true });
  await env.login(kabo, "kabo@test.invalid");
  await kabo.waitForURL(/discover\.html$/);

  await t.test("a waiting message gets three reply ideas from the sender's profile", async () => {
    await kabo.goto(env.base + "messages.html");
    await kabo.locator("#conversations button", { hasText: "Amina" }).click();
    await kabo.waitForSelector(".bubble.theirs");
    await kabo.waitForFunction(() => /cooking/.test(document.getElementById("reply-chips").textContent));
    const ideas = await kabo.locator("#reply-chips button").allTextContents();
    assert.equal(ideas.length, 3);
    assert.equal(ideas[0], "Good question, Amina! ", "her message ended with a question");
    assert.equal(ideas[2], "I see you enjoy cooking. What do you love most about it?");
    assert.equal(await kabo.evaluate(() => document.documentElement.scrollWidth), 390, "fits a phone screen");
  });

  await t.test("tapping an idea fills the box; nothing is sent until Send", async () => {
    await kabo.locator("#reply-chips button").nth(1).click();
    assert.equal(await kabo.inputValue("#body"), "Hello Amina! It's lovely to hear from you. How is your week going?");
    assert.equal(await kabo.isVisible("#reply-helpers"), false, "ideas step aside once the box has text");
    assert.equal(Number((await env.sql("select count(*) from public.member_messages where sender_member_id = $1", [ids.Kabo])).rows[0].count), 0);
    await kabo.fill("#body", "");
    await kabo.waitForSelector("#reply-helpers:not(.hidden)");
    await kabo.locator("#reply-chips button").nth(1).click();
    await kabo.fill("#body", (await kabo.inputValue("#body")) + " 🌸");
    await kabo.click("#compose button[type=submit]");
    await kabo.waitForSelector(".bubble.mine");
    assert.equal(await kabo.isVisible("#reply-helpers"), false, "no ideas once he has answered");
    const sent = (await env.sql("select body from public.member_messages where sender_member_id = $1", [ids.Kabo])).rows;
    assert.deepEqual(sent.map(r => r.body), ["Hello Amina! It's lovely to hear from you. How is your week going? 🌸"]);
  });

  await t.test("a new conversation gets opening ideas", async () => {
    await kabo.goto(env.base + "messages.html?member=" + ids.Neo);
    await kabo.waitForFunction(() => /life in Gulu/.test(document.getElementById("reply-chips").textContent));
    assert.match(await kabo.textContent("#reply-chips"), /Hi Neo 👋 I came across your profile/);
  });

  await t.test("a ready-made first message from a profile is kept, with no ideas on top", async () => {
    await kabo.goto(env.base + "messages.html?member=" + ids.Neo + "&draft=" + encodeURIComponent("I saw your answer today!"));
    await kabo.waitForFunction(() => document.getElementById("body").value === "I saw your answer today!");
    await kabo.waitForTimeout(800);
    assert.equal(await kabo.isVisible("#reply-helpers"), false);
  });
});
