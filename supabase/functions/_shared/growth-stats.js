// Growth numbers for the owner console, worked out from plain member and message rows.
// Kept free of Supabase/Deno code so the website tests can check the arithmetic directly.
// "Genuine" members exclude the owner's test accounts and the official founder account.

export const FOUNDING_SPOTS = 100;
const DAY = 24 * 60 * 60 * 1000;

function topCounts(values, limit) {
  const counts = new Map();
  for (const raw of values) {
    const key = (raw == null ? "" : String(raw)).trim() || "Not given";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

// members: [{ id, invited_by, gender, location, city, created_at, approved, is_test_account, is_official, profile_photo_url }]
// messages: [{ sender_member_id, recipient_member_id, created_at, read_at? }]
// lastSeen: optional { member_id: ISO time } from member_presence (last visit to a member page).
export function growthStats(members, messages, now = Date.now(), lastSeen = {}) {
  const excluded = new Set(members.filter((m) => m.is_test_account || m.is_official).map((m) => m.id));
  const genuine = members.filter((m) => !excluded.has(m.id));
  const since = (days) => (row) => row.created_at && now - Date.parse(row.created_at) < days * DAY;

  // New genuine members for each of the last 14 days, oldest first (UTC days).
  const today = Math.floor(now / DAY);
  const daily = [];
  for (let d = 13; d >= 0; d--) {
    const day = today - d;
    daily.push({
      date: new Date(day * DAY).toISOString().slice(0, 10),
      count: genuine.filter((m) => m.created_at && Math.floor(Date.parse(m.created_at) / DAY) === day).length,
    });
  }

  // Conversations between genuine members only (no founder welcomes, no test accounts).
  const real = messages.filter((x) => !excluded.has(x.sender_member_id) && !excluded.has(x.recipient_member_id));
  const pairs = new Map();
  for (const x of real) {
    const a = x.sender_member_id < x.recipient_member_id ? x.sender_member_id : x.recipient_member_id;
    const b = a === x.sender_member_id ? x.recipient_member_id : x.sender_member_id;
    const key = a + "|" + b;
    const pair = pairs.get(key) || new Set();
    pair.add(x.sender_member_id);
    pairs.set(key, pair);
  }
  const conversations = pairs.size;
  const twoWay = [...pairs.values()].filter((senders) => senders.size === 2).length;
  const week = real.filter(since(7));

  // Country comparison: which countries' members stay active, reply and (later) pay.
  // A member counts as active when they visited a member page, sent or opened a message.
  const lastActive = new Map();
  const touch = (id, at) => {
    const t = at ? Date.parse(at) : NaN;
    if (id && !Number.isNaN(t) && t > (lastActive.get(id) || 0)) lastActive.set(id, t);
  };
  for (const [id, at] of Object.entries(lastSeen || {})) touch(id, at);
  for (const x of messages) { touch(x.sender_member_id, x.created_at); touch(x.recipient_member_id, x.read_at); }
  const activeWithin = (id, days) => (lastActive.get(id) || 0) > now - days * DAY;
  const countryOf = new Map(genuine.map((m) => [m.id, (m.location == null ? "" : String(m.location)).trim() || "Not given"]));
  // Who started each conversation, and did the other person ever answer?
  const started = new Map();
  for (const x of [...real].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    const a = x.sender_member_id < x.recipient_member_id ? x.sender_member_id : x.recipient_member_id;
    const key = a + "|" + (a === x.sender_member_id ? x.recipient_member_id : x.sender_member_id);
    if (!started.has(key)) started.set(key, x.sender_member_id);
  }
  const approvedGenuine = genuine.filter((m) => m.approved === true);
  const byCountryRows = new Map();
  for (const m of approvedGenuine) {
    const c = countryOf.get(m.id);
    if (!byCountryRows.has(c)) byCountryRows.set(c, []);
    byCountryRows.get(c).push(m);
  }
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);
  const countryRow = (label, rows) => {
    const ids = new Set(rows.map((m) => m.id));
    const settled = rows.filter((m) => m.created_at && now - Date.parse(m.created_at) >= 7 * DAY);
    let chats = 0, answered = 0;
    for (const [key, starter] of started) {
      if (!ids.has(starter)) continue;
      chats++;
      if ((pairs.get(key) || new Set()).size === 2) answered++;
    }
    return {
      label,
      members: rows.length,
      new_7_days: rows.filter(since(7)).length,
      with_photo_percent: pct(rows.filter((m) => !!m.profile_photo_url).length, rows.length),
      active_7_days: rows.filter((m) => activeWithin(m.id, 7)).length,
      active_7_days_percent: pct(rows.filter((m) => activeWithin(m.id, 7)).length, rows.length),
      returning_percent: pct(settled.filter((m) => activeWithin(m.id, 7)).length, settled.length),
      returning_base: settled.length,
      messages_7_days: week.filter((x) => ids.has(x.sender_member_id)).length,
      chats_started: chats,
      reply_rate_percent: pct(answered, chats),
    };
  };
  const ranked = [...byCountryRows.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const by_country = ranked.slice(0, 8).map(([label, rows]) => countryRow(label, rows));
  const rest = ranked.slice(8).flatMap(([, rows]) => rows);
  if (rest.length) by_country.push(countryRow("Other countries", rest));

  return {
    by_country,
    members: {
      total: genuine.length,
      approved: genuine.filter((m) => m.approved === true).length,
      new_today: genuine.filter(since(1)).length,
      new_7_days: genuine.filter(since(7)).length,
      new_30_days: genuine.filter(since(30)).length,
      with_photo: genuine.filter((m) => !!m.profile_photo_url).length,
      joined_by_invite: genuine.filter((m) => !!m.invited_by).length,
      daily,
      gender: topCounts(genuine.map((m) => m.gender), 6),
      countries: topCounts(genuine.map((m) => m.location), 8),
      cities: topCounts(genuine.map((m) => m.city), 8),
    },
    messages: {
      total: real.length,
      last_7_days: week.length,
      active_senders_7_days: new Set(week.map((x) => x.sender_member_id)).size,
      conversations,
      two_way_conversations: twoWay,
      reply_rate_percent: conversations ? Math.round((twoWay / conversations) * 100) : null,
    },
    founding_spots_left: Math.max(0, FOUNDING_SPOTS - genuine.length),
  };
}
