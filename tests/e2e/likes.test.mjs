// Likes and matches on Discover: a daily match from another country, a like, the "likes you"
// banner, liking back, the "It's a match" pop-up and the ready-made hello. Every person is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile, ALL } from "./harness.mjs";

const FILES = [...ALL, "supabase/smart_discovery.sql", "supabase/question_of_the_day.sql", "supabase/likes_and_matches.sql"];

test("likes and matches", async (t) => {
  const env = await setup("e2e_likes", FILES);
  t.after(() => env.close());
  await env.member("tumelo@test.invalid", profile("Tumelo", { gender: "Man", location: "Botswana", city: "Gaborone", interests: "Travel, Music" }), { approved: true });
  await env.member("rudo@test.invalid", profile("Rudo", { gender: "Woman", location: "Zimbabwe", city: "Harare", interests: "travel" }), { approved: true });

  // Tumelo sees Rudo (another country) among his matches today, with what they share.
  const him = await env.newPage({ mobile: true });
  await env.login(him, "tumelo@test.invalid");
  await him.waitForURL(/discover\.html/);
  await him.waitForSelector("#matches-today:not(.hidden) .mini");
  const strip = await him.textContent("#matches-today");
  assert.match(strip, /Rudo/);
  assert.match(strip, /Also looking for marriage/);
  assert.match(strip, /You both like travel/);
  assert.doesNotMatch(strip, /Harare|Gaborone/, "city is never a reason");
  await him.click("#matches-today .like-small");
  await him.waitForFunction(() => document.querySelector("#matches-today .like-small").getAttribute("aria-pressed") === "true");
  assert.equal(await him.isVisible(".match-pop"), false, "a one-way like is not a match");

  // Rudo sees that someone likes her, likes him back and gets the match pop-up.
  const her = await env.newPage({ mobile: true });
  await env.login(her, "rudo@test.invalid");
  await her.waitForURL(/discover\.html/);
  await her.waitForSelector("#likes-banner:not(.hidden)");
  assert.match(await her.textContent("#likes-banner"), /1 person likes you/);
  await her.click("#likes-banner button");
  await her.waitForSelector("#liked-you:not(.hidden) .mini");
  assert.match(await her.textContent("#liked-you"), /Tumelo/);
  await her.click("#liked-you .like-small");
  await her.waitForSelector(".match-pop");
  assert.match(await her.textContent(".match-pop"), /It's a match/);
  await her.click(".match-pop a.btn");
  await her.waitForURL(/messages\.html\?member=/);
  await her.waitForFunction(() => /We matched/.test(document.querySelector("textarea").value));

  // The match shows for him too, with a hello button.
  await him.reload();
  await him.waitForSelector("#likes-banner:not(.hidden)");
  assert.match(await him.textContent("#likes-banner"), /1 match/);
});
