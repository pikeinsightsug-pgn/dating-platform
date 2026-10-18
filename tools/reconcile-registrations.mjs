#!/usr/bin/env node
// Reconciles original registrations (Google Form / Airtable CSV exports) with the
// Supabase members table and Auth accounts. Read-only: it only reads the CSV files you
// pass and writes a report folder. It never contacts Supabase or changes any record.
//
//   node tools/reconcile-registrations.mjs \
//     --form form-responses.csv [--source google_form|airtable] \
//     --members members.csv --auth auth-users.csv [--out reconciliation-output]
//
// members.csv: Supabase Table Editor → members → Export → CSV.
// auth-users.csv: SQL Editor → `select id, email, email_confirmed_at, created_at from auth.users;` → Download CSV.
// Column names in the form export are detected by keyword; override with --map field=Header,
// e.g. --map phone="WhatsApp number". Fields: timestamp,email,phone,name,age,dob,gender,country,city,referral.
//
// The output folder contains private contact details. Keep it off GitHub (it is git-ignored).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(v => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v !== "")) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(values => Object.fromEntries(headers.map((h, i) => [h, (values[i] ?? "").trim()])));
}

const KEYWORDS = {
  timestamp: [/^timestamp$/i, /submitted|created|date submitted/i],
  email: [/e-?mail/i],
  phone: [/whats\s*app/i, /phone|mobile|telephone|contact number/i],
  name: [/first name/i, /full name|your name|^name$/i],
  age: [/^age$|your age|how old/i],
  dob: [/date of birth|birth ?date|dob/i],
  gender: [/gender|sex/i],
  country: [/country|nationality/i],
  city: [/city|town|district|location/i],
  referral: [/referr|invite code|promo/i]
};
export function detectColumns(headers, overrides = {}) {
  const map = {};
  for (const [field, patterns] of Object.entries(KEYWORDS)) {
    if (overrides[field]) { map[field] = overrides[field]; continue; }
    for (const pattern of patterns) {
      const hit = headers.find(h => pattern.test(h) && !Object.values(map).includes(h));
      if (hit) { map[field] = hit; break; }
    }
  }
  return map;
}

export const normalizeEmail = value => {
  const email = String(value || "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
};
// Uganda: +256 and 9 national digits; Botswana: +267 and 7-8 national digits.
export function normalizePhone(value, country) {
  let digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("256") || digits.startsWith("267")) return "+" + digits;
  const c = String(country || "").toLowerCase();
  if (c.includes("uganda") && /^0?7\d{8}$/.test(digits)) return "+256" + digits.replace(/^0/, "");
  if (c.includes("botswana") && /^\d{7,8}$/.test(digits)) return "+267" + digits;
  return "+" + digits;
}
const normalizeName = value => String(value || "").trim().toLowerCase().split(/[\s,]+/)[0].replace(/[^\p{L}'-]/gu, "") || "";
function ageFrom(record, cols, submittedAt) {
  const direct = Number(String(record[cols.age] || "").replace(/[^\d]/g, ""));
  if (cols.age && Number.isInteger(direct) && direct > 0 && direct < 130) return direct;
  if (cols.dob && record[cols.dob]) {
    const birth = new Date(record[cols.dob]);
    if (!Number.isNaN(birth.getTime())) {
      const ref = submittedAt || new Date();
      let years = ref.getFullYear() - birth.getFullYear();
      if (ref < new Date(ref.getFullYear(), birth.getMonth(), birth.getDate())) years--;
      return years;
    }
  }
  return null;
}
function countryOf(value) {
  const v = String(value || "").toLowerCase();
  if (v.includes("uganda")) return "Uganda";
  if (v.includes("botswana")) return "Botswana";
  return value ? String(value).trim() : "";
}

export function reconcile({ formRows, members, authUsers, overrides = {}, source = "google_form" }) {
  const cols = detectColumns(formRows.length ? Object.keys(formRows[0]) : [], overrides);
  const authById = new Map(authUsers.map(u => [u.id, u]));
  const authByEmail = new Map(authUsers.filter(u => normalizeEmail(u.email)).map(u => [normalizeEmail(u.email), u]));
  const memberEmail = m => normalizeEmail(m.email || (m.user_id && authById.get(m.user_id)?.email));
  const memberPhone = m => normalizePhone(m.phone || m.whatsapp || m.phone_number, m.location);
  const membersByEmail = new Map(), membersByPhone = new Map();
  for (const m of members) {
    const e = memberEmail(m), p = memberPhone(m);
    if (e) membersByEmail.set(e, [...(membersByEmail.get(e) || []), m]);
    if (p) membersByPhone.set(p, [...(membersByPhone.get(p) || []), m]);
  }
  const seen = new Map();
  const results = formRows.map((record, index) => {
    const submitted = cols.timestamp && record[cols.timestamp] ? new Date(record[cols.timestamp]) : null;
    const submittedAt = submitted && !Number.isNaN(submitted.getTime()) ? submitted : null;
    const country = countryOf(record[cols.country]);
    const email = normalizeEmail(record[cols.email]);
    const phone = normalizePhone(record[cols.phone], country);
    const firstName = String(record[cols.name] || "").trim().split(/[\s,]+/)[0] || "";
    const age = ageFrom(record, cols, submittedAt);
    const notes = [];
    const missing = ["name", "age", "country"].filter(f => (f === "age" ? age == null : !(f === "country" ? country : firstName)));
    if (!email && !phone) missing.push("email or phone");

    // Strong identifiers only: email or phone. Name/age/city similarity is reported, never auto-matched.
    const strong = new Set([...(email ? membersByEmail.get(email) || [] : []), ...(phone ? membersByPhone.get(phone) || [] : [])]);
    const matched = [...strong];
    const weak = matched.length ? [] : members.filter(m => firstName && normalizeName(m.first_name) === normalizeName(firstName) &&
      age != null && Number(m.age) === age && (!country || m.location === country));
    const account = email ? authByEmail.get(email) : null;
    const key = email || phone || (firstName && age ? "name:" + normalizeName(firstName) + ":" + age : "row:" + index);
    const duplicateOf = seen.get(key);
    if (duplicateOf == null) seen.set(key, index + 2);

    let status;
    if (age != null && age < 18) status = "ineligible";
    else if (country && !["Uganda", "Botswana"].includes(country)) status = "ineligible";
    else if (duplicateOf != null) status = "possible_duplicate";
    else if (matched.length > 1) status = "possible_duplicate";
    else if (matched.length === 1 && matched[0].user_id) status = "matched_profile";
    else if (matched.length === 1) status = account ? "needs_link" : "needs_account";
    else if (weak.length) status = "possible_duplicate";
    else if (missing.length) status = "incomplete";
    else status = account ? "needs_profile" : "not_in_app";

    if (duplicateOf != null) notes.push("same email/phone/name+age as form row " + duplicateOf);
    if (matched.length > 1) notes.push("matches " + matched.length + " member rows: " + matched.map(m => m.id).join(" "));
    if (weak.length) notes.push("name+age resemble member " + weak.map(m => m.id).join(" ") + " — verify manually");
    if (age != null && age < 18) notes.push("under 18 — must not be imported or shown");
    if (country && !["Uganda", "Botswana"].includes(country)) notes.push("country outside Uganda/Botswana: " + country);
    if (missing.length) notes.push("missing: " + missing.join(", "));

    const actions = {
      matched_profile: "Already a linked app member. Nothing to import.",
      needs_link: "Profile exists and an Auth account with this email exists. Owner verifies identity, then links them in /admin/.",
      needs_account: "Profile exists without an account. Invite this email from Supabase Auth → Users → Invite user (no new profile is created), then link in /admin/.",
      needs_profile: "Has an Auth account but no profile. Ask them to sign in; if no profile appears, owner reviews before creating one.",
      not_in_app: "Only in the form. Invite them to create an account (account.html) or invite + archive, then review.",
      possible_duplicate: "Possible duplicate. Compare manually; nothing is deleted.",
      incomplete: "Missing details. Contact the person to complete registration.",
      ineligible: "Not eligible. Keep the original record; do not import or approve."
    };
    return {
      form_row: index + 2, source, status, submitted_at: submittedAt ? submittedAt.toISOString() : "",
      first_name: firstName, age: age ?? "", country, email, phone,
      referral_code: String(record[cols.referral] || "").trim(),
      matched_member_id: matched.length === 1 ? matched[0].id : "",
      auth_account: account ? (account.email_confirmed_at ? "confirmed" : "unconfirmed") : "none",
      next_action: actions[status], notes: notes.join("; "),
      original: record
    };
  });

  const formEmails = new Set(results.map(r => r.email).filter(Boolean));
  const accountsWithoutProfile = authUsers.filter(u => !members.some(m => m.user_id === u.id))
    .map(u => ({ id: u.id, in_form: formEmails.has(normalizeEmail(u.email)), confirmed: Boolean(u.email_confirmed_at) }));
  const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
  return {
    columns: cols, results, counts, accountsWithoutProfile,
    totals: {
      form_rows: formRows.length,
      members: members.length,
      members_linked: members.filter(m => m.user_id).length,
      members_unlinked: members.filter(m => !m.user_id).length,
      members_approved: members.filter(m => String(m.approved) === "true").length,
      auth_accounts: authUsers.length,
      auth_without_profile: accountsWithoutProfile.length
    }
  };
}

const csvCell = value => /[",\n\r]/.test(String(value)) ? '"' + String(value).replace(/"/g, '""') + '"' : String(value);
const sqlText = value => value === "" || value == null ? "null" : "'" + String(value).replace(/'/g, "''") + "'";

export function archiveSql(results) {
  const statusFor = { needs_link: "needs_account", not_in_app: "needs_account" };
  const lines = results.map(r => {
    const hash = createHash("sha256").update(r.source + "\u0000" + JSON.stringify(r.original)).digest("hex");
    return `insert into public.legacy_registrations (source, source_row_hash, submitted_at, first_name, age, country, email_normalized, phone_normalized, referral_code, original_answers, reconciliation_status, matched_member_id)
values (${sqlText(r.source)}, '${hash}', ${sqlText(r.submitted_at)}, ${sqlText(r.first_name)}, ${r.age === "" ? "null" : Number(r.age)}, ${sqlText(r.country)}, ${sqlText(r.email)}, ${sqlText(r.phone)}, ${sqlText(r.referral_code)}, ${sqlText(JSON.stringify(r.original))}::jsonb, '${statusFor[r.status] || r.status}', ${r.matched_member_id ? `(select id from public.members where id::text = ${sqlText(r.matched_member_id)})` : "null"})
on conflict (source_row_hash) do nothing;`;
  });
  return ["-- Archives original registrations verbatim into the private legacy_registrations table.",
    "-- Requires supabase/legacy_registrations.sql. Safe to rerun: identical rows are skipped.",
    "-- Does not create, link, approve or change any member profile.",
    "begin;", ...lines, "commit;", ""].join("\n");
}

function parseArgs(argv) {
  const args = { map: {} };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    const value = argv[i + 1];
    if (key === "map") { const [f, ...h] = value.split("="); args.map[f] = h.join("="); i++; }
    else { args[key] = value; i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.form) {
    console.error("Usage: node tools/reconcile-registrations.mjs --form responses.csv [--members members.csv] [--auth auth-users.csv] [--source google_form|airtable] [--out dir] [--map field=Header]");
    process.exit(2);
  }
  const load = path => path ? parseCsv(readFileSync(resolve(path), "utf8")) : [];
  const report = reconcile({
    formRows: load(args.form), members: load(args.members), authUsers: load(args.auth),
    overrides: args.map, source: args.source || "google_form"
  });
  const out = resolve(args.out || "reconciliation-output");
  mkdirSync(out, { recursive: true });
  const fields = ["form_row", "status", "next_action", "submitted_at", "first_name", "age", "country", "email", "phone", "referral_code", "matched_member_id", "auth_account", "notes"];
  writeFileSync(resolve(out, "reconciliation.csv"), [fields.join(","), ...report.results.map(r => fields.map(f => csvCell(r[f])).join(","))].join("\n") + "\n");
  writeFileSync(resolve(out, "archive-original-registrations.sql"), archiveSql(report.results));
  const summary = [
    "# Registration reconciliation summary", "",
    "Generated " + new Date().toISOString() + ". Read-only: no database record was changed.", "",
    "## Totals", ...Object.entries(report.totals).map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${v}`), "",
    "## Original registrations by status", ...Object.entries(report.counts).sort().map(([k, v]) => `- ${k}: ${v}`), "",
    "## Detected form columns", ...Object.entries(report.columns).map(([k, v]) => `- ${k}: "${v}"`),
    ...(Object.keys(KEYWORDS).filter(k => !report.columns[k]).length
      ? ["", "Not detected (use --map if the form has them): " + Object.keys(KEYWORDS).filter(k => !report.columns[k]).join(", ")] : []), "",
    "## Auth accounts without a member profile",
    `- ${report.accountsWithoutProfile.length} total; ${report.accountsWithoutProfile.filter(a => a.in_form).length} share an email with a form response`, "",
    "Details per person are in reconciliation.csv (contains private contact details — do not commit or share)."
  ].join("\n") + "\n";
  writeFileSync(resolve(out, "summary.md"), summary);
  process.stdout.write(summary + "\nWrote " + out + "\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
