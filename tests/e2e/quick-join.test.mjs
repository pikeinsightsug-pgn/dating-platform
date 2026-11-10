// Joining takes only the basics in two short steps (account and about you, then country and
// city); the member lands in Discover and the rest is guided by "Complete your profile". Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, PNG, confirmCrop } from "./harness.mjs";

test("quick join, then complete the profile", async (t) => {
  const env = await setup("e2e_quick_join");
  t.after(() => env.close());
  const page = await env.newPage({ mobile: true });

  await t.test("the join page asks only the basics, reassures, and offers WhatsApp help", async () => {
    await page.goto(env.base + "account.html");
    assert.match(await page.textContent("#register-title"), /30 seconds/);
    assert.match(await page.textContent(".trust-strip"), /free.*Private.*Report.*block/s);
    assert.match(await page.getAttribute("#whatsapp-help", "href"), /^https:\/\/wa\.me\/\d+/);
    assert.equal(await page.isVisible("#relationship_goal"), false, "goal is folded away");
    assert.equal(await page.isVisible('input[name=seeking_gender]'), false, "who to meet is folded away");
    await page.fill("#first_name", "Quick");
    await page.fill("#email", "quick@test.invalid");
    await page.fill("#password", "Test-pass-123");
    await page.fill("#age", "33");
    await page.selectOption("#gender", "Man");
    await page.check("#agree");
    assert.equal(await page.isVisible("#location"), false, "the country waits for step 2");
    assert.match(await page.textContent("#join-step-1 .join-reassure"), /Free · no card needed/);
    await page.click("#join-continue");
    await page.waitForSelector("#join-step-2:not(.hidden)");
    assert.equal(await page.isVisible("#whatsapp-help"), true, "WhatsApp help stays easy to find");
    await page.selectOption("#location", "Botswana");
    await page.fill("#city", "Gaborone");
    assert.match(await page.textContent("#join-step-2"), /no card needed.*never ask for money/s);
    await page.click("#register-form button[type=submit]");
    await page.waitForURL(/discover\.html$/);
    await page.waitForSelector("#welcome-new:not(.hidden)");
    await page.waitForSelector("#profiles, #status");
    const row = (await env.sql("select relationship_goal, seeking_gender, approved from public.members where first_name = 'Quick'")).rows[0];
    assert.deepEqual(row, { relationship_goal: "Exploring connections", seeking_gender: null, approved: true });
    await page.click("#welcome-new a[href^='dashboard.html']");
    await page.waitForURL(/dashboard\.html/);
  });

  await t.test("My Profile shows what is left, and it updates as the member completes it", async () => {
    await page.waitForSelector("#profile-checklist:not(.hidden)");
    assert.equal(await page.isVisible("#approval-guidance"), false, "no review notice for an approved member");
    assert.equal(await page.textContent("#checklist-progress"), "0 of 5 done");
    assert.match(await page.textContent("#checklist-items"), /photo.*looking for.*meet.*few words.*profession/is);

    await page.setInputFiles("#photo-file", { name: "me.png", mimeType: "image/png", buffer: PNG });
    await confirmCrop(page);
    await page.click("#upload-photo");
    await page.waitForFunction(() => /has been saved/.test(document.getElementById("photo-status").textContent));
    await page.waitForFunction(() => document.getElementById("checklist-progress").textContent === "1 of 5 done");

    await page.selectOption("[name=relationship_goal]", "Marriage");
    await page.selectOption("[name=seeking_gender]", "Women");
    await page.fill("[name=bio]", "I love football and good conversation.");
    await page.fill("[name=profession]", "Engineer");
    await page.click("#save-profile");
    await page.waitForFunction(() => /has been saved/.test(document.getElementById("status").textContent));
    await page.waitForSelector("#profile-checklist.hidden", { state: "attached" });
    await page.reload();
    await page.waitForSelector("#profile-panel:not(.hidden)");
    await page.waitForTimeout(500);
    assert.equal(await page.isVisible("#profile-checklist"), false, "a complete profile shows no checklist");
    const row = (await env.sql("select relationship_goal, seeking_gender, profession from public.members where first_name = 'Quick'")).rows[0];
    assert.deepEqual(row, { relationship_goal: "Marriage", seeking_gender: "Women", profession: "Engineer" });
  });
});
