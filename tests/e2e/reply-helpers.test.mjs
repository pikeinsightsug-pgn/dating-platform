// Helping members reply: a "waiting for your reply" banner for chats they opened but never
// answered, a tag in the inbox, and one-tap quick replies that name the other person.
// Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile } from "./harness.mjs";

test("helping members reply", async (t) => {
  const env = await setup("e2e_reply_helpers");
  t.after(() => env.close());
  await env.member("amina-r@test.invalid", profile("Amina"), { approved: true });
  await env.member("kabo-r@test.invalid", profile("Kabo", { gender: "Man", location: "Botswana" }), { approved: true });
  await env.member("founder-r@test.invalid", profile("Pike", { gender: "Man" }), { approved: true });
  await env.sql("update public.members set is_official = true where first_name = 'Pike'");
  const ids = Object.fromEntries((await env.sql("select first_name, id from public.members")).rows.map(r => [r.first_name, r.id]));
  // Kabo already opened both messages (nothing unread), but never answered Amina.
  await env.sql("insert into public.member_messages (sender_member_id, recipient_member_id, body, read_at) values ($1, $2, 'Hello Kabo! How are you?', now())", [ids.Amina, ids.Kabo]);
  await env.sql("insert into public.member_messages (sender_member_id, recipient_member_id, body, read_at) values ($1, $2, 'Welcome to P.K Connect!', now())", [ids.Pike, ids.Kabo]);

  const kabo = await env.newPage({ mobile: true });
  await kabo.addInitScript(() => { window.FYP_UNREAD_INTERVAL_MS = 500; });
  await env.login(kabo, "kabo-r@test.invalid");
  await kabo.waitForURL(/discover\.html$/);

  await t.test("a chat that was read but not answered shows a reminder (the founder's welcome does not count)", async () => {
    await kabo.waitForSelector("#waiting-banner");
    assert.equal(await kabo.textContent("#waiting-banner-text"), "💬 Amina is waiting for your reply. A short, friendly answer makes their day!");
    assert.equal(await kabo.locator("#unread-banner").count(), 0, "nothing is unread, so the unread banner stays away");
    assert.equal(await kabo.getAttribute("#waiting-banner-link", "href"), "messages.html?member=" + ids.Amina, "the button opens Amina's chat");
  });

  await t.test("the inbox marks it and quick replies fill the message box without sending", async () => {
    await kabo.goto(env.base + "messages.html");
    await kabo.waitForSelector("#conversations button");
    const amina = kabo.locator("#conversations button", { hasText: "Amina" });
    assert.match(await amina.textContent(), /Waiting for your reply/);
    assert.doesNotMatch(await kabo.locator("#conversations button", { hasText: "Pike" }).textContent(), /Waiting for your reply/);
    await amina.click();
    await kabo.waitForSelector("#quick-replies:not(.hidden) button");
    await kabo.click("#quick-replies button:has-text('Say hi back')");
    assert.equal(await kabo.inputValue("#body"), "Hi Amina! 😊 Thanks for your message. How is your day going?");
    await kabo.click("#quick-replies button:has-text('Ask about them')");
    assert.equal(await kabo.inputValue("#body"), "Hello Amina 👋 Nice to hear from you! Tell me a little about yourself?", "one suggestion replaces another");
    await kabo.fill("#body", "Hi there!");
    await kabo.click("#quick-replies button:has-text('Busy, write later')");
    assert.equal(await kabo.inputValue("#body"), "Hi there! Hi Amina! I'm a bit busy right now, but I'll write more soon 😊", "the member's own words are kept");
    assert.equal((await env.sql("select count(*)::int as n from public.member_messages where sender_member_id = $1", [ids.Kabo])).rows[0].n, 0, "nothing was sent by tapping");
    await kabo.fill("#body", "");
    await kabo.click("#quick-replies button:has-text('Say hi back')");
    await kabo.click("#compose button[type=submit]");
    await kabo.waitForSelector("#quick-replies.hidden", { state: "attached" });
    assert.doesNotMatch(await amina.textContent(), /Waiting for your reply/, "answered chats are no longer marked");
  });

  await t.test("once answered, the reminder is gone", async () => {
    await kabo.goto(env.base + "discover.html");
    await kabo.waitForSelector("#profiles .card");
    await kabo.waitForTimeout(1200);
    assert.equal(await kabo.locator("#waiting-banner").count(), 0);
  });

  await t.test("the official account's own chats never show quick replies", async () => {
    await kabo.goto(env.base + "messages.html?member=" + ids.Pike);
    await kabo.waitForSelector("#compose:not(.hidden)");
    await kabo.waitForTimeout(800);
    assert.equal(await kabo.isVisible("#quick-replies"), false);
  });
});
