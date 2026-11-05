// A member with unread messages sees it everywhere: a red count on every Messages link, a
// banner on Discover and My Profile, and the count in the browser tab. It clears once read.
// Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile } from "./harness.mjs";

test("unread messages are impossible to miss", async (t) => {
  const env = await setup("e2e_unread_alerts");
  t.after(() => env.close());
  await env.member("amina@test.invalid", profile("Amina"), { approved: true });
  await env.member("kabo@test.invalid", profile("Kabo", { gender: "Man", location: "Botswana" }), { approved: true });
  await env.member("pendo@test.invalid", profile("Pendo", { gender: "Man" }), { approved: false });
  const ids = Object.fromEntries((await env.sql("select first_name, id from public.members")).rows.map(r => [r.first_name, r.id]));
  for (const body of ["Hello Kabo!", "Are you there?"])
    await env.sql("insert into public.member_messages (sender_member_id, recipient_member_id, body) values ($1, $2, $3)", [ids.Amina, ids.Kabo, body]);

  const kabo = await env.newPage({ mobile: true });
  await kabo.addInitScript(() => { window.FYP_UNREAD_INTERVAL_MS = 500; });
  await env.login(kabo, "kabo@test.invalid");
  await kabo.waitForURL(/discover\.html$/);

  await t.test("Discover: red count on Messages, banner, and the tab title", async () => {
    await kabo.waitForSelector("a[data-messages-link].has-unread .unread-badge");
    assert.equal(await kabo.textContent("a[data-messages-link] .unread-badge"), "2");
    assert.match(await kabo.textContent("#unread-banner"), /You have 2 unread messages/);
    assert.match(await kabo.title(), /^\(2\) /);
    await kabo.goto(env.base + "dashboard.html");
    await kabo.waitForSelector("#unread-banner");
    assert.equal(await kabo.textContent("#messages-nav .unread-badge"), "2", "My Profile shows it too");
  });

  await t.test("a new message arriving while the page is open updates the count", async () => {
    await env.sql("insert into public.member_messages (sender_member_id, recipient_member_id, body) values ($1, $2, 'One more')", [ids.Amina, ids.Kabo]);
    await kabo.waitForFunction(() => document.querySelector("#messages-nav .unread-badge")?.textContent === "3");
  });

  await t.test("opening the conversation clears every alert", async () => {
    await kabo.click("#unread-banner a");
    await kabo.waitForURL(/messages\.html$/);
    assert.equal(await kabo.isVisible("#unread-banner"), false, "no banner on the Messages page itself");
    await kabo.locator("#conversations button", { hasText: "Amina" }).click();
    await kabo.waitForSelector(".bubble.theirs");
    await kabo.waitForFunction(() => !document.querySelector("a[data-messages-link].has-unread"));
    assert.doesNotMatch(await kabo.title(), /^\(\d+\)/);
    await kabo.goto(env.base + "discover.html");
    await kabo.waitForFunction(() => /Showing/.test(document.getElementById("status").textContent));
    await kabo.waitForTimeout(800);
    assert.equal(await kabo.isVisible("#unread-banner"), false);
  });

  await t.test("members with nothing unread, and pending members, see no alert", async () => {
    const amina = await env.newPage();
    await env.login(amina, "amina@test.invalid"); await amina.waitForURL(/discover\.html$/);
    await amina.waitForFunction(() => /Showing/.test(document.getElementById("status").textContent));
    await amina.waitForTimeout(800);
    assert.equal(await amina.locator(".unread-badge, #unread-banner").count(), 0);
    const pendo = await env.newPage();
    await env.login(pendo, "pendo@test.invalid"); await pendo.waitForURL(/dashboard\.html$/);
    await pendo.waitForTimeout(800);
    assert.equal(await pendo.locator(".unread-badge, #unread-banner").count(), 0);
  });
});
