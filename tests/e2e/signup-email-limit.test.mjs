// When Supabase's site-wide email limit is reached, the person is told it is not their fault,
// their answers and photo stay filled in, and pressing the button again later works.
// Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, PNG } from "./harness.mjs";

test("Supabase's email limit does not lose the registration", async (t) => {
  const env = await setup("e2e_signup_email_limit");
  t.after(() => env.close());
  const page = await env.newPage({ mobile: true });
  await env.fillRegistration(page, { name: "Wanjiru", email: "wanjiru@test.invalid", gender: "Woman", seeking: "Men", min: "25", max: "45", location: "Uganda" });
  await page.setInputFiles("#photo", { name: "me.png", mimeType: "image/png", buffer: PNG });

  env.gateway.options.failSignup = [429, { code: 429, error_code: "over_email_send_rate_limit", msg: "email rate limit exceeded" }];
  await page.click("#register-form button[type=submit]");
  await page.waitForFunction(() => /not a mistake on your part/.test(document.getElementById("status").textContent));
  assert.doesNotMatch(await page.textContent("#status"), /Too many attempts/);
  assert.equal(await page.inputValue("#email"), "wanjiru@test.invalid", "answers stay filled in");
  assert.equal(await page.evaluate(() => document.getElementById("photo").files.length), 1, "the photo stays chosen");
  assert.equal(await page.isEnabled("#register-form button[type=submit]"), true, "the button can be pressed again");

  env.gateway.options.failSignup = null;
  await page.click("#register-form button[type=submit]");
  await page.waitForSelector("#success-view:not(.hidden)");
  assert.equal((await env.sql("select count(*)::int n from auth.users where email = 'wanjiru@test.invalid'")).rows[0].n, 1, "exactly one account");
});
