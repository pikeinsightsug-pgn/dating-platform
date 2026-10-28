// Members without a profile photo (for example everyone who joined while email confirmation
// was on, when the join-form photo could not be saved) see a clear reminder until they add one.
// Every person here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, profile, PNG, confirmCrop } from "./harness.mjs";

test("members without a photo are reminded to add one", async (t) => {
  const env = await setup("e2e_photo_reminder");
  t.after(() => env.close());
  await env.member("nophoto@test.invalid", profile("Nalule"), { approved: false });

  const page = await env.newPage({ mobile: true });
  await env.login(page, "nophoto@test.invalid");
  await page.waitForURL(/dashboard\.html$/);
  await page.waitForSelector("#photo-reminder:not(.hidden)");
  assert.match(await page.textContent("#photo-reminder"), /Add your profile photo/);

  // The button jumps to the photo section; uploading there removes the reminder.
  await page.click("#photo-reminder a");
  await page.setInputFiles("#photo-file", { name: "me.png", mimeType: "image/png", buffer: PNG });
  await confirmCrop(page);
  await page.click("#upload-photo");
  await page.waitForFunction(() => /has been saved/.test(document.getElementById("photo-status").textContent));
  assert.equal(await page.isVisible("#photo-reminder"), false, "hidden once the photo is saved");
  await page.reload();
  await page.waitForSelector("#photo-preview:not(.hidden)");
  assert.equal(await page.isVisible("#photo-reminder"), false, "stays hidden after reload");
});
