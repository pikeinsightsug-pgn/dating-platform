import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./harness.mjs";

// Facebook opens ad links in its own in-app browser and adds tracking parameters to the URL.
const FB_AD = "?fbclid=IwAR0TestAdClick123&utm_source=facebook&utm_medium=paid";

test("a visitor from a Facebook ad can open the site and register", async () => {
  const env = await setup("fyp_facebook_ad");
  try {
    const page = await env.newPage({ mobile: true });
    await page.context().setExtraHTTPHeaders({ "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Mobile [FBAN/FB4A;FBAV/480.0.0.0;]" });
    const signupRedirects = [];
    page.on("request", request => { if (request.url().includes("/auth/v1/signup")) signupRedirects.push(new URL(request.url()).searchParams.get("redirect_to")); });

    // The ad link with tracking parameters stays on the homepage.
    await page.goto(env.base + FB_AD);
    assert.match(new URL(page.url()).pathname, /\/dating-platform\/$/, "the homepage is not redirected away");
    assert.ok(await page.isVisible("text=Join now"), "the Join now button is visible");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, "no sideways scrolling on a phone (" + overflow + "px)");

    // Join now opens the registration form.
    await page.click(".hero a[href='account.html']");
    await page.waitForSelector("#register-form");

    await page.fill("#first_name", "Neo");
    await page.fill("#email", "neo-fb@test.invalid");
    await page.fill("#password", "Test-pass-123");
    await page.fill("#age", "31");
    await page.selectOption("#gender", "Man");
    await page.selectOption("#location", "Botswana");
    await page.fill("#city", "Gaborone");
    await page.check('input[name=seeking_gender][value="Women"]');
    await page.selectOption("#relationship_goal", "Serious relationship");
    await page.fill("#bio", "Synthetic test member who arrived from a Facebook ad.");
    await page.check("#agree");
    await page.click("#register-form button[type=submit]");
    await page.waitForSelector("#success-view:not(.hidden)");
    await env.sql("update auth.users set email_confirmed_at = now() where email = 'neo-fb@test.invalid'");

    const row = (await env.sql("select m.location, m.approved from public.members m join auth.users u on u.id = m.user_id where u.email = 'neo-fb@test.invalid'")).rows[0];
    assert.deepEqual(row, { location: "Botswana", approved: false }, "a pending profile is created for the team to review");
    for (const redirect of signupRedirects) assert.ok(!redirect || !redirect.includes("fbclid"), "the confirmation email link does not carry Facebook tracking: " + redirect);

    // The Page's Sign up button may also link straight to the form with tracking added.
    const direct = await env.newPage({ mobile: true });
    await direct.goto(env.base + "account.html" + FB_AD);
    await direct.waitForSelector("#register-form");
    assert.ok(await direct.isVisible("#register-view"), "the form shows when opened straight from Facebook");
  } finally {
    await env.close();
  }
});
