// Members from any country: register through the real page, appear in discovery, and can be
// found with the country filter. Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile } from "./harness.mjs";

test("people from anywhere in the world can join and be found", async (t) => {
  const env = await setup("e2e_worldwide");
  t.after(() => env.close());
  await env.member("amina-ug@test.invalid", profile("Amina", { location: "Uganda" }), { approved: true });
  await env.member("thabo-za@test.invalid", profile("Thabo", { gender: "Man", location: "South Africa", city: "Johannesburg" }), { approved: true });

  await t.test("the join page lists every country and saves a pending profile from Kenya", async () => {
    const page = await env.newPage({ mobile: true });
    await env.fillRegistration(page, { name: "Wanjiru", email: "wanjiru-ke@test.invalid", location: "Kenya", city: "Nairobi" });
    const count = await page.$$eval("#location option", options => options.filter(o => o.value).length);
    assert.ok(count > 190, "the whole world is listed (" + count + " countries)");
    await page.click("#register-form button[type=submit]");
    await page.waitForSelector("#success-view:not(.hidden)");
    await env.sql("update auth.users set email_confirmed_at = now() where email = 'wanjiru-ke@test.invalid'");
    const row = (await env.sql("select m.location, m.city, m.approved from public.members m join auth.users u on u.id = m.user_id where u.email = 'wanjiru-ke@test.invalid'")).rows[0];
    assert.deepEqual(row, { location: "Kenya", city: "Nairobi", approved: false });
  });

  await t.test("discovery shows members from every country and filters by any country", async () => {
    const page = await env.newPage();
    await env.login(page, "amina-ug@test.invalid");
    await page.waitForURL(/discover\.html/);
    await page.waitForFunction(() => /Showing/.test(document.getElementById("status").textContent));
    assert.equal(await page.$eval("#filters [name=country] option", o => o.textContent), "All countries");
    await page.selectOption("#filters [name=gender]", "");
    await page.selectOption("#filters [name=country]", "South Africa");
    await page.click("#filters button[type=submit]");
    await page.waitForFunction(() => /Showing 1 of 1/.test(document.getElementById("status").textContent));
    assert.match(await page.textContent("#profiles"), /Thabo/);
  });

  await t.test("a member can move their profile to another country", async () => {
    const page = await env.newPage();
    await env.login(page, "thabo-za@test.invalid");
    await page.goto(page.url().replace(/[^/]*$/, "dashboard.html"));
    await page.waitForSelector("#profile-panel:not(.hidden)");
    assert.equal(await page.inputValue("#profile-form [name=location]"), "South Africa", "the saved country is selected");
    await page.selectOption("#profile-form [name=location]", "United Kingdom");
    await page.fill("#profile-form [name=city]", "London");
    await page.click("#profile-form button[type=submit]");
    await page.waitForFunction(() => /has been saved/.test(document.getElementById("status").textContent));
    const row = (await env.sql("select location, city from public.members where first_name = 'Thabo'")).rows[0];
    assert.deepEqual(row, { location: "United Kingdom", city: "London" });
  });
});
