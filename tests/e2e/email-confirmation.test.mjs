// A new member registers, opens the confirmation link from their email and can then log in.
// Covers Supabase's default email link, a link straight to the website (token_hash), a link
// that was already used, and a resent email. Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, PNG, SUPABASE } from "./harness.mjs";

test("the email confirmation link completes registration", async (t) => {
  const env = await setup("e2e_email_confirmation");
  t.after(() => env.close());

  const register = async (name, email) => {
    const page = await env.newPage({ mobile: true });
    await env.fillRegistration(page, { name, email, gender: "Woman", seeking: "Men", min: "25", max: "45", location: "Uganda" });
    await page.setInputFiles("#photo", { name: "me.png", mimeType: "image/png", buffer: PNG });
    await page.click("#register-form button[type=submit]");
    await page.waitForSelector("#success-view:not(.hidden)");
    return page;
  };
  const defaultLink = email => {
    const mail = env.gateway.confirmationEmail(email);
    return `${SUPABASE}/auth/v1/verify?token=${mail.token}&type=signup&redirect_to=${encodeURIComponent(mail.redirect)}`;
  };
  const pending = async page => {
    await page.waitForURL(/dashboard\.html$/);
    await page.waitForFunction(() => /awaiting manual review/.test(document.getElementById("approval-status").textContent));
  };
  const profileRow = async email => (await env.sql(
    "select m.approved, u.email_confirmed_at is not null as confirmed from auth.users u left join public.members m on m.user_id = u.id where u.email = $1", [email])).rows[0];

  await t.test("Supabase's default link: opened from the email app, the member lands signed in and pending", async () => {
    await register("Nakato", "nakato@test.invalid");
    const link = defaultLink("nakato@test.invalid");
    assert.match(env.gateway.confirmationEmail("nakato@test.invalid").redirect, /\/account\.html$/, "the email returns to the join page");
    const fromEmail = await env.newPage({ mobile: true }); // a different browser tab, as an email app opens
    await fromEmail.goto(link);
    await pending(fromEmail);
    assert.deepEqual(await profileRow("nakato@test.invalid"), { approved: false, confirmed: true });

    // Logging in afterwards works and never asks to confirm again.
    const later = await env.newPage();
    await env.login(later, "nakato@test.invalid");
    await pending(later);

    // Opening the same link a second time explains it was already used.
    const again = await env.newPage();
    await again.goto(link);
    await again.waitForFunction(() => /expired or was already used/.test(document.getElementById("status").textContent));
  });

  await t.test("a link straight to the website (token_hash template) also confirms the account", async () => {
    await register("Achieng", "achieng@test.invalid");
    const { token } = env.gateway.confirmationEmail("achieng@test.invalid");
    const page = await env.newPage({ mobile: true });
    await page.goto(env.base + "?token_hash=" + token + "&type=signup"); // the homepage forwards it
    await pending(page);
    assert.deepEqual(await profileRow("achieng@test.invalid"), { approved: false, confirmed: true });
  });

  await t.test("a template link to a page that does not exist (…/auth/confirm) still confirms the account", async () => {
    await register("Neo", "neo@test.invalid");
    const { token } = env.gateway.confirmationEmail("neo@test.invalid");
    const page = await env.newPage({ mobile: true });
    await page.goto(env.base + "auth/confirm?token_hash=" + token + "&type=email");
    await pending(page);
    assert.deepEqual(await profileRow("neo@test.invalid"), { approved: false, confirmed: true });

    // The same link again: a clear message, not a silent return to the form.
    const again = await env.newPage();
    await again.goto(env.base + "?token_hash=" + token + "&type=email");
    await again.waitForFunction(() => /expired or was already used/.test(document.getElementById("status").textContent));
  });

  await t.test("after “Resend confirmation email”, the new link works and the old one is explained", async () => {
    await register("Mosa", "mosa@test.invalid");
    const oldLink = defaultLink("mosa@test.invalid");
    const login = await env.newPage({ mobile: true });
    await login.goto(env.base + "login.html");
    await login.fill("#login-email", "mosa@test.invalid"); await login.fill("#login-password", "Test-pass-123");
    await login.click("#login-form button[type=submit]");
    await login.waitForFunction(() => /confirm your email/.test(document.getElementById("status").textContent));
    await login.click("#resend-confirmation");
    await login.waitForFunction(() => /sent|check/i.test(document.getElementById("status").textContent));

    const stale = await env.newPage();
    await stale.goto(oldLink);
    await stale.waitForFunction(() => /expired or was already used/.test(document.getElementById("status").textContent));
    assert.equal((await profileRow("mosa@test.invalid")).confirmed, false);

    const fresh = await env.newPage();
    await fresh.goto(defaultLink("mosa@test.invalid"));
    await pending(fresh);
  });
});
