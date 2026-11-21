// Question of the Day on Discover Members: answer first, then see and reply to others' answers.
// Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile, ALL } from "./harness.mjs";

test("members answer the Question of the Day and reply to each other", async (t) => {
  const env = await setup("e2e_daily_question", [...ALL, "supabase/smart_discovery.sql", "supabase/daily_question.sql"]);
  t.after(() => env.close());
  await env.member("amara@test.invalid", profile("Amara", { location: "Botswana", city: "Francistown" }), { approved: true });
  await env.member("kato@test.invalid", profile("Kato", { location: "Uganda", city: "Gulu", gender: "Man" }), { approved: true });

  const first = await env.newPage({ mobile: true });
  await env.login(first, "amara@test.invalid");
  await first.waitForURL(/discover\.html$/);
  await first.waitForSelector("#daily-question:not(.hidden)");
  assert.ok((await first.textContent("#dq-question")).trim().length > 5, "today's question is shown");
  assert.match(await first.textContent("#dq-count"), /Be the first/);
  assert.equal(await first.isVisible("#dq-answers"), false, "answers stay hidden until you answer");
  await first.fill("#dq-input", "Pap, always");
  await first.click("#dq-save");
  await first.waitForSelector("#dq-mine:not(.hidden)");
  assert.match(await first.textContent("#dq-mine-text"), /Pap, always/);
  await first.waitForFunction(() => /first to answer/.test(document.getElementById("dq-answers").textContent));

  const second = await env.newPage({ mobile: true });
  await env.login(second, "kato@test.invalid");
  await second.waitForURL(/discover\.html$/);
  await second.waitForSelector("#daily-question:not(.hidden)");
  assert.match(await second.textContent("#dq-count"), /1 member answered/);
  await second.fill("#dq-input", "Rice with beans");
  await second.click("#dq-save");
  await second.waitForSelector("#dq-answers .dq-answer");
  assert.match(await second.textContent("#dq-answers"), /Amara.*Pap, always/s);
  await second.screenshot({ path: process.env.DQ_SCREENSHOT || "/tmp/daily-question.png", fullPage: false });
  await second.click("#dq-answers .dq-message");
  await second.waitForURL(/messages\.html\?member=/);

  // Changing an answer keeps one answer per member.
  await first.reload();
  await first.waitForSelector("#dq-mine:not(.hidden)");
  await first.click("#dq-edit");
  await first.fill("#dq-input", "Rice, actually");
  await first.click("#dq-save");
  await first.waitForFunction(() => /Rice, actually/.test(document.getElementById("dq-mine-text").textContent));
  assert.equal((await env.sql("select count(*)::int as n from public.daily_answers")).rows[0].n, 2);
});

test("the card stays hidden when the database setup has not been applied", async (t) => {
  const env = await setup("e2e_daily_question_missing");
  t.after(() => env.close());
  await env.member("solo@test.invalid", profile("Solo"), { approved: true });
  const page = await env.newPage();
  await env.login(page, "solo@test.invalid");
  await page.waitForURL(/discover\.html$/);
  await page.waitForFunction(() => /no other approved member/i.test(document.getElementById("status").textContent));
  assert.equal(await page.isVisible("#daily-question"), false);
});
