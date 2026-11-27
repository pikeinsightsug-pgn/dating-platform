// "🆕 Just joined" on Discover: a new member is shown to people they fit both ways, with words
// that match them ("View his profile, you may like him"), and opens like any profile.
// Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile, ALL } from "./harness.mjs";

const FILES = [...ALL, "supabase/smart_discovery.sql", "supabase/question_of_the_day.sql", "supabase/likes_and_matches.sql", "supabase/just_joined.sql"];

test("just joined", async (t) => {
  const env = await setup("e2e_just_joined", FILES);
  t.after(() => env.close());
  await env.member("grace-jj@test.invalid", profile("Grace", { gender: "Woman", seeking_gender: "Men" }), { approved: true });
  await env.sql("update public.members set created_at = now() - interval '30 days' where first_name = 'Grace'");
  await env.member("james-jj@test.invalid", profile("James", { gender: "Man", seeking_gender: "Women", age: 31 }), { approved: true });
  await env.member("kofi-jj@test.invalid", profile("Kofi", { gender: "Man", seeking_gender: "Men" }), { approved: true });

  await t.test("a woman looking for men sees the new man who wants to meet women", async () => {
    const page = await env.newPage({ mobile: true });
    await env.login(page, "grace-jj@test.invalid");
    await page.waitForURL(/discover\.html/);
    await page.waitForSelector("#just-joined:not(.hidden) .mini");
    const box = await page.textContent("#just-joined");
    assert.match(box, /James has just joined!/);
    assert.match(box, /View his profile, you may like him/);
    assert.match(box, /Joined today/);
    assert.doesNotMatch(box, /Kofi/, "someone who only wants to meet men is not shown to her");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "fits a phone screen");
    await page.click("#just-joined .view-profile");
    await page.waitForSelector("#profile-dialog[open]");
    assert.match(await page.textContent("#dialog-name"), /James/);
  });

  await t.test("long-standing members are not announced as new", async () => {
    const page = await env.newPage({ mobile: true });
    await env.login(page, "james-jj@test.invalid");
    await page.waitForURL(/discover\.html/);
    await page.waitForSelector("#profiles .card");
    assert.equal(await page.isVisible("#just-joined"), false, "Grace joined a month ago and Kofi wants to meet men");
  });
});
