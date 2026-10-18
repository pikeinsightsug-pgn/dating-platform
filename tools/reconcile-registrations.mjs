#!/usr/bin/env node
// Reconciles original registrations (Google Form / Airtable CSV exports) with the
// Supabase members table and Auth accounts. Read-only: it only reads the CSV files you
// pass and writes a report folder. It never contacts Supabase or changes any record.
//
//   node tools/reconcile-registrations.mjs \
//     --form form-responses.csv [--source google_form|airtable] \
//     --members members.csv --auth auth-users.csv [--out reconciliation-output] \
//     [--include-contacts] [--archive-sql]
//
// By default the output has no names, phone numbers, emails or photo links: summary.md
// (counts) and reconciliation.csv (status per form row number). --include-contacts adds a
// private follow-up sheet; --archive-sql writes the SQL that archives the original answers.
//
// members.csv: Supabase Table Editor → members → Export → CSV.
// auth-users.csv: SQL Editor → `select id, email, phone, email_confirmed_at, created_at from auth.users;` → Download CSV.
// Column names in the form export are detected by keyword; override with --map field=Header,
// e.g. --map phone="WhatsApp number". Fields: timestamp,email,phone,name,age,dob,gender,country,city,referral.
// One question may supply both phone and email; age may be an exact age or an age group.
//
// Keep every input and output file off GitHub (the default output folder is git-ignored).
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

// Patterns are tried in order. EXCLUDE stops look-alike questions from being picked,
// e.g. "Would you consider dating someone from the other country?" is not the country.
const KEYWORDS = {
  timestamp: [/^timestamp$/i, /submitted|created|date submitted/i],
  email: [/e-?mail/i],
  phone: [/whats\s*app/i, /phone|mobile|telephone|contact number/i],
  name: [/first name/i, /full name|your name|^name$/i, /what should we call you|call you|nickname|display name/i],
  age: [/^age$|your age|how old/i, /age group|age bracket/i],
  dob: [/date of birth|birth ?date|dob/i],
  gender: [/gender|sex/i],
  country: [/where are you (currently )?based|country of residence|which country do you live|^country$/i, /country|nationality/i],
  city: [/city|town|district|location/i],
  referral: [/referr|invite code|promo/i]
};
const EXCLUDE = {
  age: /prefer|would you like|partner|range/i,
  country: /other country|consider dating|from the other/i,
  city: /based/i
};
// One form question may legitimately collect both phone and email.
const SHAREABLE = new Set(["email", "phone"]);
export function detectColumns(headers, overrides = {}) {
  const map = {};
  for (const [field, patterns] of Object.entries(KEYWORDS)) {
    if (overrides[field]) { map[field] = overrides[field]; continue; }
    const taken = Object.entries(map).filter(([f]) => !(SHAREABLE.has(f) && SHAREABLE.has(field))).map(([, h]) => h);
    for (const pattern of patterns) {
      const hit = headers.find(h => pattern.test(h) && !(EXCLUDE[field] && EXCLUDE[field].test(h)) && !taken.includes(h));
      if (hit) { map[field] = hit; break; }
    }
  }
  return map;
}

const EMAIL_IN_TEXT = /[^\s,;:<>()"']+@[^\s,;:<>()"']+\.[a-z]{2,}/i;
export const normalizeEmail = value => {
  const email = String(value || "").trim().toLowerCase().replace(/[.,;]+$/, "");
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
};
export const extractEmail = text => normalizeEmail((String(text || "").match(EMAIL_IN_TEXT) || [""])[0]);

// Uganda: +256 and 9 national digits; Botswana: +267 and 7-8 national digits.
// Returns { phone, quality } where quality is "ok", "assumed_country_code" or "unverified".
export function parsePhone(value, country) {
  const text = String(value || "").replace(EMAIL_IN_TEXT, " ");
  // First phone-like run only, so trailing notes such as "UG1" are not glued onto the number.
  const run = (text.match(/(?:\+|00)?\d[\d\s().-]{5,}\d/) || [""])[0];
  let digits = run.replace(/\D/g, "");
  if (!digits) return { phone: "", quality: "none" };
  if (run.trim().startsWith("00")) digits = digits.replace(/^00/, "");
  if (/^256\d{9}$/.test(digits) || /^267\d{7,8}$/.test(digits)) return { phone: "+" + digits, quality: "ok" };
  const c = String(country || "").toLowerCase();
  if (c.includes("uganda") && /^0?7\d{8}$/.test(digits)) return { phone: "+256" + digits.replace(/^0/, ""), quality: "assumed_country_code" };
  if (c.includes("botswana") && /^7\d{6,7}$/.test(digits)) return { phone: "+267" + digits, quality: "assumed_country_code" };
  if (/^07\d{8}$/.test(digits)) return { phone: "+256" + digits.slice(1), quality: "assumed_country_code" };
  return { phone: "+" + digits, quality: "unverified" };
}
export const normalizePhone = (value, country) => parsePhone(value, country).phone;

const normalizeName = value => String(value || "").trim().toLowerCase().split(/[\s,]+/)[0].replace(/[^\p{L}'-]/gu, "") || "";
const NON_NAME = /^(yes|no|ok|okay|none|n\/a|anytime|i don.?t have|video call|vedio call|required)\b/i;

// Exact age, a date of birth, or an age group such as "45–49" or "55+".
export function ageRangeFrom(record, cols, submittedAt) {
  const raw = String(record[cols.age] || "").trim();
  const group = raw.match(/^(\d{2})\s*[–—-]\s*(\d{2})$/);
  if (group) return { min: Number(group[1]), max: Number(group[2]), label: group[1] + "–" + group[2] };
  const plus = raw.match(/^(\d{2})\s*\+$/);
  if (plus) return { min: Number(plus[1]), max: 120, label: plus[1] + "+" };
  const exact = Number(raw.replace(/[^\d]/g, ""));
  if (raw && Number.isInteger(exact) && exact > 0 && exact < 130) return { min: exact, max: exact, label: String(exact) };
  if (cols.dob && record[cols.dob]) {
    const birth = new Date(record[cols.dob]);
    if (!Number.isNaN(birth.getTime())) {
      const ref = submittedAt || new Date();
      let years = ref.getFullYear() - birth.getFullYear();
      if (ref < new Date(ref.getFullYear(), birth.getMonth(), birth.getDate())) years--;
      return { min: years, max: years, label: String(years) };
    }
  }
  return null;
}
function countryOf(value) {
  const v = String(value || "").toLowerCase();
  if (v.includes("uganda")) return "Uganda";
  if (v.includes("botswana")) return "Botswana";
  if (!v.trim()) return "";
  return "Other";
}

export const STATUS_ACTIONS = {
  matched_profile: "Confirmed by email: already a linked app member. Nothing to import.",
  needs_link: "Confirmed by email/phone: a profile exists but is not linked to this person's account. Owner verifies identity, then links in /admin/.",
  needs_account: "Confirmed by email/phone: a profile exists without an account. Owner invites the person, then links in /admin/.",
  needs_profile: "Confirmed by email: has an Auth account but no profile. Owner reviews before anything is created.",
  not_in_app: "No match found in the Supabase data provided. Candidate for a controlled import or invitation after review.",
  possible_duplicate: "Possible duplicate (shared contact, or a name/age/country resemblance). Compare manually; never merge or delete automatically.",
  needs_verification: "Answer needs checking before import (country outside Uganda/Botswana, or unusual details).",
  incomplete: "No usable phone or email. Owner must find another way to contact this person.",
  ineligible: "Under 18 or otherwise not eligible. Keep the original record; never import or approve."
};

export function reconcile({ formRows, members = [], authUsers = [], overrides = {}, source = "google_form" }) {
  const cols = detectColumns(formRows.length ? Object.keys(formRows[0]) : [], overrides);
  const authById = new Map(authUsers.map(u => [u.id, u]));
  const authByEmail = new Map(authUsers.filter(u => normalizeEmail(u.email)).map(u => [normalizeEmail(u.email), u]));
  // Supabase stores Auth phone numbers without "+"; normalise both sides the same way.
  const authPhone = u => u && u.phone ? normalizePhone(String(u.phone).startsWith("+") ? u.phone : "+" + u.phone) : "";
  const authByPhone = new Map(authUsers.filter(u => authPhone(u)).map(u => [authPhone(u), u]));
  const memberEmail = m => normalizeEmail(m.email || (m.user_id && authById.get(m.user_id)?.email));
  const memberPhone = m => normalizePhone(m.phone || m.whatsapp || m.phone_number, m.location) || authPhone(m.user_id && authById.get(m.user_id));
  const membersByEmail = new Map(), membersByPhone = new Map();
  for (const m of members) {
    const e = memberEmail(m), p = memberPhone(m);
    if (e) membersByEmail.set(e, [...(membersByEmail.get(e) || []), m]);
    if (p) membersByPhone.set(p, [...(membersByPhone.get(p) || []), m]);
  }

  const parsed = formRows.map((record, index) => {
    const submitted = cols.timestamp && record[cols.timestamp] ? new Date(record[cols.timestamp]) : null;
    const submittedAt = submitted && !Number.isNaN(submitted.getTime()) ? submitted : null;
    const country = countryOf(record[cols.country]);
    const contactText = [record[cols.phone], cols.email !== cols.phone ? record[cols.email] : ""].filter(Boolean).join(" ");
    const rawName = String(record[cols.name] || "").trim();
    const flags = [];
    let email = extractEmail(record[cols.email]) || extractEmail(contactText);
    if (!email && extractEmail(rawName)) { email = extractEmail(rawName); flags.push("email_written_in_name_field"); }
    const { phone, quality } = parsePhone(contactText, country);
    if (quality === "assumed_country_code") flags.push("phone_country_code_assumed");
    if (quality === "unverified") flags.push("phone_format_unverified");
    const nameUsable = rawName && !EMAIL_IN_TEXT.test(rawName) && !NON_NAME.test(rawName) && rawName.split(/\s+/).length <= 4;
    if (rawName && !nameUsable) flags.push("name_needs_review");
    const firstName = nameUsable ? rawName.split(/[\s,]+/)[0] : "";
    const age = ageRangeFrom(record, cols, submittedAt);
    if (!age) flags.push("age_missing");
    if (country === "Other") flags.push("country_outside_uganda_botswana");
    if (!country) flags.push("country_missing");
    return { index, record, submittedAt, country, email, phone, firstName, age, flags };
  });

  // Within-form duplicate groups: rows sharing a phone or email (strong), or sharing
  // first name + age group + country with no shared contact (weak, name-only).
  const groupOf = new Map();
  let nextGroup = 1;
  const byKey = new Map();
  for (const row of parsed) for (const key of [row.email && "e:" + row.email, row.phone && "p:" + row.phone].filter(Boolean)) {
    byKey.set(key, [...(byKey.get(key) || []), row.index]);
  }
  for (const indexes of byKey.values()) {
    if (indexes.length < 2) continue;
    const existing = indexes.map(i => groupOf.get(i)).find(Boolean);
    const id = existing || "D" + nextGroup++;
    indexes.forEach(i => groupOf.set(i, id));
  }
  const nameGroups = new Map();
  for (const row of parsed) {
    if (!row.firstName || !row.age || groupOf.has(row.index)) continue;
    const key = [normalizeName(row.firstName), row.age.label, row.country].join("|");
    nameGroups.set(key, [...(nameGroups.get(key) || []), row.index]);
  }
  const nameOnly = new Set();
  for (const indexes of nameGroups.values()) {
    if (indexes.length < 2) continue;
    const id = "N" + nextGroup++;
    indexes.forEach(i => { groupOf.set(i, id); nameOnly.add(i); });
  }

  const results = parsed.map(row => {
    const { index, record, submittedAt, country, email, phone, firstName, age, flags } = row;
    const strong = new Set([...(email ? membersByEmail.get(email) || [] : []), ...(phone ? membersByPhone.get(phone) || [] : [])]);
    const matched = [...strong];
    // A name resemblance is reported for manual review only; it is never a match.
    const weak = matched.length ? [] : members.filter(m => firstName && normalizeName(m.first_name) === normalizeName(firstName) &&
      age && Number(m.age) >= age.min && Number(m.age) <= age.max && (!country || country === "Other" || m.location === country));
    const account = (email && authByEmail.get(email)) || (phone && authByPhone.get(phone)) || null;
    const group = groupOf.get(index) || "";
    const notes = [];

    let status;
    if (age && age.max < 18) status = "ineligible";
    else if (group || matched.length > 1 || weak.length) status = "possible_duplicate";
    else if (matched.length === 1 && matched[0].user_id && account && matched[0].user_id === account.id) status = "matched_profile";
    else if (matched.length === 1 && matched[0].user_id) status = "needs_link";
    else if (matched.length === 1) status = "needs_account";
    else if (!email && !phone) status = "incomplete";
    else if (country !== "Uganda" && country !== "Botswana") status = "needs_verification";
    else status = account ? "needs_profile" : "not_in_app";

    if (group) notes.push(nameOnly.has(index) ? "same first name, age group and country as other form rows in group " + group + " (name-only — not proof of the same person)" : "shares a phone or email with other form rows in group " + group);
    if (matched.length > 1) notes.push("contact matches " + matched.length + " member rows: " + matched.map(m => m.id).join(" "));
    if (weak.length) notes.push("name and age resemble member row(s) " + weak.map(m => m.id).join(" ") + " — verify manually");
    if (age && age.max < 18) notes.push("under 18 — must not be imported or shown");
    if (age && age.min < 18 && age.max >= 18) notes.push("age group includes under-18 ages — verify age");

    return {
      form_row: index + 2, source, status, duplicate_group: group, flags: flags.join(" "),
      submitted_at: submittedAt ? submittedAt.toISOString() : "",
      country: country || "", age_group: age ? age.label : "",
      has_phone: Boolean(phone), has_email: Boolean(email),
      matched_member_id: matched.length === 1 ? matched[0].id : "",
      auth_account: account ? (account.email_confirmed_at ? "confirmed" : "unconfirmed") : "none",
      next_action: STATUS_ACTIONS[status], notes: notes.join("; "),
      // Private fields: written only with --include-contacts or into the archive SQL.
      first_name: firstName, email, phone,
      age_min: age ? age.min : null,
      referral_code: String(record[cols.referral] || "").trim(),
      original: record
    };
  });

  const formEmails = new Set(results.map(r => r.email).filter(Boolean));
  const formPhones = new Set(results.map(r => r.phone).filter(Boolean));
  const accountsWithoutProfile = authUsers.filter(u => !members.some(m => m.user_id === u.id))
    .map(u => ({ id: u.id, in_form: formEmails.has(normalizeEmail(u.email)) || formPhones.has(authPhone(u)), confirmed: Boolean(u.email_confirmed_at) }));
  const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
  const flagCounts = results.flatMap(r => r.flags ? r.flags.split(" ") : []).reduce((acc, f) => ({ ...acc, [f]: (acc[f] || 0) + 1 }), {});
  const groups = [...new Set(results.map(r => r.duplicate_group).filter(Boolean))];
  return {
    columns: cols, results, counts, flagCounts, accountsWithoutProfile,
    duplicateGroups: {
      contact: groups.filter(g => g.startsWith("D")).length,
      contact_rows: results.filter(r => r.duplicate_group.startsWith("D")).length,
      name_only: groups.filter(g => g.startsWith("N")).length,
      name_only_rows: results.filter(r => r.duplicate_group.startsWith("N")).length
    },
    totals: {
      form_rows: formRows.length,
      rows_with_phone: results.filter(r => r.has_phone).length,
      rows_with_email: results.filter(r => r.has_email).length,
      rows_with_neither: results.filter(r => !r.has_phone && !r.has_email).length,
      members_provided: members.length,
      members_linked: members.filter(m => m.user_id).length,
      members_unlinked: members.filter(m => !m.user_id).length,
      members_approved: members.filter(m => String(m.approved) === "true").length,
      auth_accounts_provided: authUsers.length,
      auth_without_profile: accountsWithoutProfile.length
    }
  };
}

const csvCell = value => /[",\n\r]/.test(String(value)) ? '"' + String(value).replace(/"/g, '""') + '"' : String(value);
const sqlText = value => value === "" || value == null ? "null" : "'" + String(value).replace(/'/g, "''") + "'";

// Without contact details: safe to show the owner on screen or share with a developer.
export const REDACTED_FIELDS = ["form_row", "status", "duplicate_group", "flags", "submitted_at", "country", "age_group", "has_phone", "has_email", "matched_member_id", "auth_account", "next_action", "notes"];
const CONTACT_FIELDS = ["form_row", "status", "duplicate_group", "first_name", "email", "phone", "referral_code", "flags", "next_action", "notes"];
export const toCsv = (rows, fields) => [fields.join(","), ...rows.map(r => fields.map(f => csvCell(r[f])).join(","))].join("\n") + "\n";

export function summaryMarkdown(report, { members, auth }) {
  const mapped = Object.entries(report.columns).map(([k, v]) => `- ${k}: "${v.replace(/\s+/g, " ").trim().slice(0, 90)}"`);
  const missing = Object.keys(KEYWORDS).filter(k => !report.columns[k]);
  return [
    "# Registration reconciliation summary (counts only)", "",
    "Generated " + new Date().toISOString() + ". Read-only: no database record or source file was changed.", "",
    ...(!members || !auth ? ["**Supabase comparison incomplete:** " + [!members && "members.csv", !auth && "auth.csv"].filter(Boolean).join(" and ") +
      " not provided, so no registration can be shown as already in Supabase. \"not_in_app\" below means \"no match found in the data provided\".", ""] : []),
    "## Totals", ...Object.entries(report.totals).map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${v}`), "",
    "## Registrations by status", ...Object.entries(report.counts).sort().map(([k, v]) => `- ${k}: ${v} — ${STATUS_ACTIONS[k]}`), "",
    "## Possible duplicates within the form (flagged, never merged)",
    `- groups sharing a phone or email: ${report.duplicateGroups.contact} (${report.duplicateGroups.contact_rows} rows)`,
    `- name-only resemblance groups: ${report.duplicateGroups.name_only} (${report.duplicateGroups.name_only_rows} rows)`, "",
    "## Data-quality flags", ...(Object.keys(report.flagCounts).length ? Object.entries(report.flagCounts).sort().map(([k, v]) => `- ${k}: ${v}`) : ["- none"]), "",
    "## Form questions used", ...mapped,
    ...(missing.length ? ["", "Not found in this form (fine if the form never asked): " + missing.join(", ")] : []), "",
    "## Auth accounts without a member profile",
    `- ${report.accountsWithoutProfile.length} total; ${report.accountsWithoutProfile.filter(a => a.in_form).length} share an email or phone with a form response`, ""
  ].join("\n");
}

export function archiveSql(results) {
  const statusFor = { needs_link: "needs_account", not_in_app: "needs_account", needs_verification: "unreviewed" };
  const lines = results.map(r => {
    const hash = createHash("sha256").update(r.source + "\u0000" + JSON.stringify(r.original)).digest("hex");
    return `insert into public.legacy_registrations (source, source_row_hash, submitted_at, first_name, age, country, email_normalized, phone_normalized, referral_code, original_answers, reconciliation_status, matched_member_id)
values (${sqlText(r.source)}, '${hash}', ${sqlText(r.submitted_at)}, ${sqlText(r.first_name)}, ${r.age_min == null ? "null" : Number(r.age_min)}, ${sqlText(r.country)}, ${sqlText(r.email)}, ${sqlText(r.phone)}, ${sqlText(r.referral_code)}, ${sqlText(JSON.stringify(r.original))}::jsonb, '${statusFor[r.status] || r.status}', ${r.matched_member_id ? `(select id from public.members where id::text = ${sqlText(r.matched_member_id)})` : "null"})
on conflict (source_row_hash) do nothing;`;
  });
  return ["-- Archives original registrations verbatim into the private legacy_registrations table.",
    "-- Requires supabase/legacy_registrations.sql. Safe to rerun: identical rows are skipped.",
    "-- Does not create, link, approve or change any member profile. Contains private contact details.",
    "begin;", ...lines, "commit;", ""].join("\n");
}

function parseArgs(argv) {
  const args = { map: {} };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (key === "include-contacts" || key === "archive-sql") { args[key] = true; continue; }
    const value = argv[i + 1];
    if (key === "map") { const [f, ...h] = value.split("="); args.map[f] = h.join("="); i++; }
    else { args[key] = value; i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.form) {
    console.error("Usage: node tools/reconcile-registrations.mjs --form responses.csv [--members members.csv] [--auth auth-users.csv] [--source google_form|airtable] [--out dir] [--map field=Header] [--include-contacts] [--archive-sql]");
    process.exit(2);
  }
  // Inputs are only ever read; nothing is written next to them.
  const load = path => path ? parseCsv(readFileSync(resolve(path), "utf8")) : [];
  const report = reconcile({
    formRows: load(args.form), members: load(args.members), authUsers: load(args.auth),
    overrides: args.map, source: args.source || "google_form"
  });
  const out = resolve(args.out || "reconciliation-output");
  mkdirSync(out, { recursive: true });
  const summary = summaryMarkdown(report, { members: Boolean(args.members), auth: Boolean(args.auth) });
  writeFileSync(resolve(out, "summary.md"), summary);
  writeFileSync(resolve(out, "reconciliation.csv"), toCsv(report.results, REDACTED_FIELDS));
  const written = ["summary.md (counts only)", "reconciliation.csv (per form row, no names, contacts or photo links)"];
  if (args["include-contacts"]) {
    writeFileSync(resolve(out, "reconciliation-with-contacts.csv"), toCsv(report.results, CONTACT_FIELDS));
    written.push("reconciliation-with-contacts.csv (PRIVATE: names and contact details)");
  }
  if (args["archive-sql"]) {
    writeFileSync(resolve(out, "archive-original-registrations.sql"), archiveSql(report.results));
    written.push("archive-original-registrations.sql (PRIVATE: full original answers)");
  }
  process.stdout.write(summary + "\nWrote to " + out + ":\n- " + written.join("\n- ") + "\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
