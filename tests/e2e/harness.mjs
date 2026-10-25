// Shared setup for the browser tests: a fresh local database with the checked-in
// migrations, the Supabase stand-in gateway, a static server for the site, and Chromium.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { chromium } from "playwright";
import { startGateway } from "./gateway.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const PG = { host: process.env.PGHOST || "/var/run/postgresql", port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || "postgres" };
export const SUPABASE = "https://cyvkpcwjkeifpvegwhpt.supabase.co";
const CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js";
export const ALL = ["supabase/registration_setup.sql", "supabase/launch_features_secure.sql", "supabase/member_discovery_photos.sql", "supabase/discovery_messaging_safety.sql", "supabase/legacy_registrations.sql", "supabase/member_extra_photos.sql", "supabase/official_account.sql"];
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function freshDatabase(name, files) {
  const admin = new pg.Client({ ...PG, database: "postgres" });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const db = new pg.Client({ ...PG, database: name });
  await db.connect();
  await db.query("set client_min_messages = warning");
  for (const file of ["tests/db/supabase_stub.sql", ...files]) await db.query(await readFile(join(repo, file), "utf8"));
  await db.end();
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".jpg": "image/jpeg", ".css": "text/css" };
function staticServer() {
  const server = http.createServer(async (req, res) => {
    // Like GitHub Pages: a path ending in "/" serves that folder's index.html.
    let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/dating-platform\/?/, "/");
    if (path.endsWith("/")) path += "index.html";
    try {
      const body = await readFile(join(repo, path));
      res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" }); res.end(body);
    } catch {
      // Like GitHub Pages: a missing page serves the site's 404.html.
      res.writeHead(404, { "content-type": "text/html" }); res.end(await readFile(join(repo, "404.html")));
    }
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

export async function setup(name, files = ALL) {
  await freshDatabase(name, files);
  const gateway = await startGateway({ database: name, ...PG });
  const site = await staticServer();
  const base = `http://127.0.0.1:${site.address().port}/dating-platform/`;
  const browser = await chromium.launch();
  const supabaseJs = await readFile(join(repo, "node_modules/@supabase/supabase-js/dist/umd/supabase.js"));
  async function newPage({ mobile = false } = {}) {
    const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {});
    await context.route(CDN, route => route.fulfill({ status: 200, contentType: "text/javascript", body: supabaseJs }));
    await context.route(SUPABASE + "/**", async route => {
      const request = route.request();
      const target = gateway.url + request.url().slice(SUPABASE.length);
      const response = await fetch(target, { method: request.method(), headers: request.headers(), body: request.postDataBuffer() || undefined, redirect: "manual" });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    const page = await context.newPage();
    page.on("pageerror", error => { throw error; });
    page.on("dialog", dialog => dialog.accept());
    return page;
  }
  const sql = (text, values) => gateway.pool.query(text, values);
  async function member(email, meta, { approved = false, password = "Test-pass-123" } = {}) {
    const row = (await sql("insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, now(), $2) returning id", [email, meta])).rows[0];
    gateway.passwords.set(email, password);
    if (approved) await sql("update public.members set approved = true where user_id = $1", [row.id]);
    return row.id;
  }
  async function login(page, email, password = "Test-pass-123") {
    await page.goto(base + "login.html");
    await page.fill("#login-email", email);
    await page.fill("#login-password", password);
    await page.click("#login-form button[type=submit]");
  }
  // Fills the registration questionnaire on account.html (does not submit).
  async function fillRegistration(page, f) {
    const v = { password: "Test-pass-123", age: "29", gender: "Woman", location: "Uganda", city: "Kampala",
      seeking: "Men", goal: "Serious relationship", min: "25", max: "40", bio: "Synthetic test member who enjoys music and long walks.", ...f };
    await page.goto(base + "account.html");
    await page.fill("#first_name", v.name);
    await page.fill("#email", v.email);
    await page.fill("#password", v.password);
    await page.fill("#password_confirm", v.confirm ?? v.password);
    await page.fill("#age", v.age);
    await page.selectOption("#gender", v.gender);
    await page.check(`input[name=location][value="${v.location}"]`);
    await page.fill("#city", v.city);
    await page.check(`input[name=seeking_gender][value="${v.seeking}"]`);
    await page.selectOption("#relationship_goal", v.goal);
    await page.selectOption("#preferred_age_min", v.min);
    await page.selectOption("#preferred_age_max", v.max);
    await page.fill("#bio", v.bio);
    if (v.adult !== false) await page.check("#adult_confirm");
    if (v.privacy !== false) await page.check("#privacy_accept");
  }
  return {
    base, gateway, sql, newPage, member, login, fillRegistration, repo,
    async close() { await browser.close(); await gateway.close(); site.close(); }
  };
}

// Completes the photo cropper that opens after choosing a profile photo. `adjust` may move or zoom first.
export async function confirmCrop(page, adjust) {
  await page.waitForFunction(() => { const d = document.querySelector(".crop-dialog"); return d && d.open; });
  await page.waitForSelector("#crop-adjust:not(.hidden)");
  if (adjust) await adjust();
  await page.click("#crop-preview");
  await page.waitForSelector("#crop-confirm:not(.hidden)");
  await page.click("#crop-use");
  await page.waitForFunction(() => !document.querySelector(".crop-dialog").open);
}

export const profile = (first_name, extra = {}) => ({
  profile_type: "member_registration", first_name, age: 30, gender: "Woman", location: "Uganda",
  city: "Kampala", relationship_goal: "Marriage", bio: "Synthetic test profile for " + first_name, ...extra
});

