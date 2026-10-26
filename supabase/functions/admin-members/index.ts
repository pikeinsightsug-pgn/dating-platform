import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isMemberPhotoPathOwnedByUser } from "../_shared/member-photo-path.js";
import { COUNTRIES } from "../_shared/countries.js";

// Bump when this function changes; the owner console compares it with the version it expects,
// so the owner can see whether the deployed function is current without opening Supabase.
const FUNCTION_VERSION = "2026-10-26";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const adminEmail = Deno.env.get("ADMIN_EMAIL")?.trim().toLowerCase();
  if (!url || !anonKey || !serviceKey || !adminEmail) {
    return json({ error: "Admin endpoint is not configured." }, 500);
  }

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token || token === authHeader) return json({ error: "Sign in required." }, 401);

  const authClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: authError } = await authClient.auth.getUser(token);
  if (authError || !user || !user.email || user.email.toLowerCase() !== adminEmail || !user.email_confirmed_at) {
    return json({ error: "Not authorized for owner actions." }, 403);
  }

  let body: {
    action?: string; member_id?: string; user_id?: string; identity_verified?: boolean;
    status?: string; legacy_id?: string; is_test_account?: boolean; is_official?: boolean; notes?: string; photo_id?: string;
    email?: string; consent?: boolean; redirect_to?: string; profile?: Record<string, unknown>;
  };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON." }, 400); }

  const db = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (body.action === "list") {
    const { data, error } = await db.from("members")
      // "*" keeps the console working before is_test_account exists; fields are picked below.
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) return json({ error: "Could not load registrations.", detail: error.message }, 500);
    const rows = (data || []).map((m) => ({
      id: m.id, user_id: m.user_id, first_name: m.first_name, age: m.age, gender: m.gender,
      location: m.location, city: m.city, relationship_goal: m.relationship_goal, bio: m.bio,
      interests: m.interests, partner_preference: m.partner_preference,
      profile_photo_url: m.profile_photo_url, approved: m.approved === true,
      is_test_account: m.is_test_account === true, is_official: m.is_official === true, created_at: m.created_at,
      seeking_gender: m.seeking_gender ?? null,
      preferred_age_min: m.preferred_age_min ?? null, preferred_age_max: m.preferred_age_max ?? null,
    }));
    const authUsers = new Map<string, { email: string | null; confirmed: boolean }>();
    for (let page = 1; ; page++) {
      const { data: authPage, error: authListError } = await db.auth.admin.listUsers({ page, perPage: 1000 });
      if (authListError) return json({ error: "Could not load registered account identifiers.", detail: authListError.message }, 500);
      for (const authUser of authPage.users) authUsers.set(authUser.id, { email: authUser.email ?? null, confirmed: !!authUser.email_confirmed_at });
      if (authPage.users.length < 1000) break;
    }
    // Members' extra photos, so the owner can remove an inappropriate one. Skipped quietly
    // until supabase/member_extra_photos.sql is applied.
    const extraByMember = new Map<string, Array<{ id: string; url: string | null }>>();
    const { data: extraRows, error: extraError } = await db.from("member_photos")
      .select("id, member_id, storage_path").order("created_at").limit(3000);
    if (!extraError && extraRows?.length) {
      const owners = new Map(rows.map((m) => [m.id, m.user_id]));
      const owned = extraRows.filter((p) => isMemberPhotoPathOwnedByUser(owners.get(p.member_id), p.storage_path));
      const urls = new Map<string, string>();
      try {
        const { data: signed } = await db.storage.from("profile-photos").createSignedUrls(owned.map((p) => p.storage_path), 300);
        (signed || []).forEach((item) => { if (item?.path && item.signedUrl && !item.error) urls.set(item.path, item.signedUrl); });
      } catch {
        // Previews are optional; the owner can still remove photos.
      }
      for (const p of owned) {
        const list = extraByMember.get(p.member_id) || [];
        list.push({ id: p.id, url: urls.get(p.storage_path) ?? null });
        extraByMember.set(p.member_id, list);
      }
    }
    const identifiedRows = await Promise.all(rows.map(async (member) => {
      let admin_photo_signed_url: string | null = null;
      const photoPath = member.profile_photo_url;
      const safeOwnedPath = isMemberPhotoPathOwnedByUser(member.user_id, photoPath);
      if (safeOwnedPath) {
        try {
          const { data: signedPhoto, error: signedPhotoError } = await db.storage.from("profile-photos")
            .createSignedUrl(photoPath, 300);
          if (!signedPhotoError) admin_photo_signed_url = signedPhoto?.signedUrl ?? null;
        } catch {
          // A photo preview failure must not prevent the owner from reviewing member records.
        }
      }
      return {
        ...member,
        account_email: member.user_id ? authUsers.get(member.user_id)?.email ?? null : null,
        account_confirmed: member.user_id ? authUsers.get(member.user_id)?.confirmed ?? false : false,
        admin_photo_signed_url,
        extra_photos: extraByMember.get(member.id) || [],
      };
    }));
    return json({
      function_version: FUNCTION_VERSION,
      members: identifiedRows,
      metrics: {
        total: rows.length,
        approved: rows.filter((m) => m.approved === true).length,
        pending: rows.filter((m) => m.approved !== true).length,
        linked: rows.filter((m) => !!m.user_id).length,
        test_accounts: rows.filter((m) => m.is_test_account).length,
        official_accounts: rows.filter((m) => m.is_official).length,
        // Genuine members only: the owner's test accounts and the official account are excluded.
        genuine_approved: rows.filter((m) => m.approved && !m.is_test_account && !m.is_official && m.user_id && (m.age ?? 0) >= 18).length,
        unlinked: rows.filter((m) => !m.user_id).length,
      },
    });
  }

  const uuid = /^[0-9a-f-]{36}$/i;

  // The owner registers someone who could not register themselves, or rescues someone who
  // registered but is stuck (for example their confirmation email never arrived). The owner
  // never sets or sees a password, and nobody is approved here: the owner still uses Approve.
  if (body.action === "add_member") {
    const email = String(body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json({ error: "Enter the person's email address." }, 400);
    if (body.consent !== true) return json({ error: "Tick the box to confirm this person asked you to register them." }, 400);
    const profile = memberProfileFrom(body.profile);

    let account: { id: string; email?: string; email_confirmed_at?: string | null } | null = null;
    for (let page = 1; !account; page++) {
      const { data: authPage, error: authListError } = await db.auth.admin.listUsers({ page, perPage: 1000 });
      if (authListError) return json({ error: "Could not check existing accounts.", detail: authListError.message }, 500);
      account = authPage.users.find((u) => (u.email || "").toLowerCase() === email) ?? null;
      if (authPage.users.length < 1000) break;
    }

    if (!account) {
      if (typeof profile === "string") return json({ error: profile }, 400);
      const redirectTo = typeof body.redirect_to === "string" && /^https?:\/\/[^\s]+$/.test(body.redirect_to) ? body.redirect_to : undefined;
      const { data: invited, error: inviteError } = await db.auth.admin.inviteUserByEmail(email, {
        data: { profile_type: "member_registration", ...profile },
        redirectTo,
      });
      if (inviteError || !invited?.user) {
        const limited = /rate limit|sending/i.test(inviteError?.message || "");
        return json({ error: limited
          ? "Supabase could not send the invitation email just now (email limit). Wait a few minutes and try again."
          : "Could not create the invitation.", detail: inviteError?.message }, 502);
      }
      const { data: member, error: insertError } = await db.from("members")
        .insert({ user_id: invited.user.id, ...profile, approved: false })
        .select("id, first_name, approved").single();
      if (insertError) return json({ error: "The invitation was sent, but the profile could not be saved.", detail: insertError.message }, 500);
      return json({ outcome: "invited", email, member });
    }

    let outcome = "already_registered";
    if (!account.email_confirmed_at) {
      // Their profile is created from their own signup answers by the database trigger.
      const { error: confirmError } = await db.auth.admin.updateUserById(account.id, { email_confirm: true });
      if (confirmError) return json({ error: "Could not confirm the person's email.", detail: confirmError.message }, 500);
      outcome = "confirmed";
    }
    const { data: existing, error: existingError } = await db.from("members")
      .select("id, first_name, approved").eq("user_id", account.id).maybeSingle();
    if (existingError) return json({ error: "Could not check the person's profile.", detail: existingError.message }, 500);
    if (existing) return json({ outcome, email, member: existing });
    if (typeof profile === "string") {
      return json({ outcome: outcome === "confirmed" ? "confirmed_needs_profile" : "needs_profile", email, error: profile }, outcome === "confirmed" ? 200 : 400);
    }
    const { data: member, error: insertError } = await db.from("members")
      .insert({ user_id: account.id, ...profile, approved: false })
      .select("id, first_name, approved").single();
    if (insertError) return json({ error: "Could not save the profile.", detail: insertError.message }, 500);
    return json({ outcome: outcome === "confirmed" ? "confirmed" : "profile_created", email, member });
  }

  // Removes one member's extra photo (for example an inappropriate picture): the record and
  // the file. Never touches the member's profile, main photo or approval.
  if (body.action === "remove_photo") {
    if (typeof body.photo_id !== "string" || !uuid.test(body.photo_id)) return json({ error: "A valid photo ID is required." }, 400);
    const { data, error } = await db.from("member_photos").delete().eq("id", body.photo_id)
      .select("id, storage_path").maybeSingle();
    if (error) return json({ error: "Could not remove the photo.", detail: error.message }, 500);
    if (!data) return json({ error: "Photo not found. Refresh the list." }, 404);
    const { error: fileError } = await db.storage.from("profile-photos").remove([data.storage_path]);
    return json({ removed: data.id, file_removed: !fileError });
  }

  if (body.action === "set_test_account") {
    if (typeof body.member_id !== "string" || !uuid.test(body.member_id) || typeof body.is_test_account !== "boolean") {
      return json({ error: "A valid member ID and test-account flag are required." }, 400);
    }
    const { data, error } = await db.from("members")
      .update({ is_test_account: body.is_test_account })
      .eq("id", body.member_id)
      .select("id, is_test_account")
      .maybeSingle();
    if (error) return json({ error: "Could not update the test-account flag. Apply supabase/discovery_messaging_safety.sql first.", detail: error.message }, 500);
    if (!data) return json({ error: "Member not found." }, 404);
    return json({ member: data });
  }

  // Marks the owner's own profile as the official P.K Connect account (✅ badge, kept out of
  // Discover as a dating profile, shown to members as the official contact). An official
  // account must be approved and linked, and is never a test account, so genuine members see it.
  if (body.action === "set_official_account") {
    if (typeof body.member_id !== "string" || !uuid.test(body.member_id) || typeof body.is_official !== "boolean") {
      return json({ error: "A valid member ID and official-account flag are required." }, 400);
    }
    if (body.is_official) {
      const { data: member, error: memberError } = await db.from("members")
        .select("id, user_id, approved").eq("id", body.member_id).maybeSingle();
      if (memberError) return json({ error: "Could not verify the profile." }, 500);
      if (!member) return json({ error: "Member not found." }, 404);
      if (!member.user_id || member.approved !== true) {
        return json({ error: "Approve this profile (with a linked, confirmed account) before making it the official account." }, 409);
      }
    }
    const update: Record<string, boolean> = { is_official: body.is_official };
    if (body.is_official) update.is_test_account = false;
    const { data, error } = await db.from("members")
      .update(update)
      .eq("id", body.member_id)
      .select("id, is_official, is_test_account")
      .maybeSingle();
    if (error) return json({ error: "Could not update the official-account flag. Apply supabase/official_account.sql first.", detail: error.message }, 500);
    if (!data) return json({ error: "Member not found." }, 404);
    return json({ member: data });
  }

  // Original Google Form / Airtable registrations archived by supabase/legacy_registrations.sql.
  // These actions never create, link, approve or edit member profiles.
  const LEGACY_STATUSES = ["unreviewed", "matched_profile", "needs_account", "needs_profile", "possible_duplicate", "ineligible", "incomplete", "linked", "declined"];
  if (body.action === "list_legacy") {
    const { data, error } = await db.from("legacy_registrations")
      .select("id, source, submitted_at, first_name, age, country, email_normalized, phone_normalized, referral_code, reconciliation_status, matched_member_id, owner_notes")
      .order("submitted_at", { ascending: true })
      .limit(500);
    if (error) return json({ error: "Original registrations are not archived yet. Apply supabase/legacy_registrations.sql and run the archive SQL first.", detail: error.message }, 500);
    return json({ registrations: data || [] });
  }

  if (body.action === "link_legacy") {
    if (typeof body.legacy_id !== "string" || !uuid.test(body.legacy_id) ||
        typeof body.member_id !== "string" || !uuid.test(body.member_id)) {
      return json({ error: "A valid original registration and member profile are required." }, 400);
    }
    if (body.identity_verified !== true) {
      return json({ error: "Confirm you verified this person (for example by WhatsApp) before linking." }, 400);
    }
    const { data: member, error: memberError } = await db.from("members").select("id").eq("id", body.member_id).maybeSingle();
    if (memberError) return json({ error: "Could not verify the member profile." }, 500);
    if (!member) return json({ error: "Member profile not found." }, 404);
    const { data, error } = await db.from("legacy_registrations")
      .update({ matched_member_id: body.member_id, reconciliation_status: "linked" })
      .eq("id", body.legacy_id)
      .is("matched_member_id", null)
      .select("id, matched_member_id, reconciliation_status")
      .maybeSingle();
    if (error) return json({ error: "Could not link the original registration.", detail: error.message }, 500);
    if (!data) return json({ error: "This original registration is already linked or no longer exists. Refresh and check." }, 409);
    return json({ registration: data });
  }

  if (body.action === "set_legacy_status") {
    if (typeof body.legacy_id !== "string" || !uuid.test(body.legacy_id) ||
        typeof body.status !== "string" || !LEGACY_STATUSES.includes(body.status) || body.status === "linked") {
      return json({ error: "A valid original registration and review status are required." }, 400);
    }
    const update: Record<string, unknown> = { reconciliation_status: body.status };
    if (typeof body.notes === "string") update.owner_notes = body.notes.slice(0, 1000);
    const { data, error } = await db.from("legacy_registrations")
      .update(update).eq("id", body.legacy_id)
      .select("id, reconciliation_status, owner_notes").maybeSingle();
    if (error) return json({ error: "Could not update the original registration.", detail: error.message }, 500);
    if (!data) return json({ error: "Original registration not found." }, 404);
    return json({ registration: data });
  }

  if (body.action === "list_reports") {
    const { data, error } = await db.from("member_reports")
      .select("id, reason, details, status, created_at, reporter:reporter_member_id(id, first_name), reported:reported_member_id(id, first_name, approved)")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return json({ error: "Could not load member reports. Apply supabase/discovery_messaging_safety.sql first.", detail: error.message }, 500);
    return json({ reports: data || [] });
  }

  if (body.action === "resolve_report") {
    const reportStatus = (body as { status?: string }).status;
    if (typeof body.member_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.member_id) ||
        (reportStatus !== "reviewed" && reportStatus !== "dismissed")) {
      return json({ error: "A valid report ID and outcome are required." }, 400);
    }
    const { data, error } = await db.from("member_reports")
      .update({ status: reportStatus })
      .eq("id", body.member_id)
      .select("id, status")
      .maybeSingle();
    if (error) return json({ error: "Could not update the report.", detail: error.message }, 500);
    if (!data) return json({ error: "Report not found." }, 404);
    return json({ report: data });
  }

  if (body.action === "list_unlinked_accounts") {
    const { data: linkedRows, error: linkedError } = await db.from("members")
      .select("user_id")
      .not("user_id", "is", null);
    if (linkedError) return json({ error: "Could not verify existing account links." }, 500);
    const linkedIds = new Set((linkedRows || []).map((row) => row.user_id));
    const accounts: Array<{ user_id: string; email: string }> = [];
    for (let page = 1; ; page++) {
      const { data: authPage, error: authListError } = await db.auth.admin.listUsers({ page, perPage: 1000 });
      if (authListError) return json({ error: "Could not load confirmed account choices." }, 500);
      for (const account of authPage.users) {
        if (account.email && account.email_confirmed_at && !linkedIds.has(account.id)) {
          accounts.push({ user_id: account.id, email: account.email });
        }
      }
      if (authPage.users.length < 1000) break;
    }
    return json({ accounts });
  }

  if (body.action === "link_verified_profile") {
    if (typeof body.member_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.member_id) ||
        typeof body.user_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.user_id)) {
      return json({ error: "A valid profile and confirmed account are required." }, 400);
    }
    if (body.identity_verified !== true) {
      return json({ error: "The owner must verify this person's identity using original registration information before linking." }, 400);
    }

    const { data: member, error: memberError } = await db.from("members")
      .select("id, user_id, age, approved")
      .eq("id", body.member_id)
      .maybeSingle();
    if (memberError) return json({ error: "Could not verify the selected profile." }, 500);
    if (!member) return json({ error: "Profile not found." }, 404);
    if (member.user_id) return json({ error: "This profile is already linked. No change was made." }, 409);

    const { data: accountResult, error: accountError } = await db.auth.admin.getUserById(body.user_id);
    if (accountError || !accountResult.user?.email || !accountResult.user.email_confirmed_at) {
      return json({ error: "Choose an existing email-confirmed account. No profile was changed." }, 409);
    }
    const { data: existingLink, error: existingLinkError } = await db.from("members")
      .select("id")
      .eq("user_id", body.user_id)
      .maybeSingle();
    if (existingLinkError) return json({ error: "Could not verify whether the account is already linked." }, 500);
    if (existingLink) return json({ error: "This account already has a member profile. No change was made." }, 409);

    const { data: linkedProfile, error: linkError } = await db.from("members")
      .update({ user_id: body.user_id })
      .eq("id", body.member_id)
      .is("user_id", null)
      .select("id, user_id, approved")
      .maybeSingle();
    if (linkError) return json({ error: "Could not link the verified profile. No other profile fields were changed.", detail: linkError.message }, 409);
    if (!linkedProfile) return json({ error: "The profile changed while you were reviewing it. Refresh and verify again." }, 409);
    return json({ member: linkedProfile, linked_email: accountResult.user.email });
  }

  if (body.action === "approve" || body.action === "reject") {
    if (typeof body.member_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.member_id)) {
      return json({ error: "A valid member ID is required." }, 400);
    }
    const approved = body.action === "approve";
    if (approved) {
      const { data: member, error: memberError } = await db.from("members")
        .select("user_id, age")
        .eq("id", body.member_id)
        .maybeSingle();
      if (memberError) return json({ error: "Could not verify the member account." }, 500);
      if (!member) return json({ error: "Member not found." }, 404);
      if (!member.user_id) {
        return json({ error: "This profile has no linked account and cannot be approved for discovery." }, 409);
      }
      if (typeof member.age !== "number" || member.age < 18) {
        return json({ error: "Only a profile verified as age 18 or older can be approved." }, 409);
      }
      const { data: linkedAccount, error: linkedAccountError } = await db.auth.admin.getUserById(member.user_id);
      if (linkedAccountError || !linkedAccount.user || !linkedAccount.user.email_confirmed_at) {
        return json({ error: "This profile has no confirmed linked account and cannot be approved for discovery." }, 409);
      }
    }
    const { data, error } = await db.from("members")
      .update({ approved })
      .eq("id", body.member_id)
      .select("id, first_name, approved")
      .maybeSingle();
    if (error) return json({ error: "Could not update member approval.", detail: error.message }, 500);
    if (!data) return json({ error: "Member not found." }, 404);
    return json({ member: data });
  }

  return json({ error: "Unsupported action." }, 400);
});

// The same rules the signup form and database use. Returns the profile, or a message saying
// what is missing.
function memberProfileFrom(input: unknown): Record<string, string | number | null> | string {
  const p = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const text = (key: string) => String(p[key] ?? "").trim();
  const age = Number(text("age"));
  const profile = {
    first_name: text("first_name"), age, gender: text("gender"), location: text("location"), city: text("city"),
    relationship_goal: text("relationship_goal"), bio: text("bio"),
    seeking_gender: ["Men", "Women", "Everyone"].includes(text("seeking_gender")) ? text("seeking_gender") : null,
  };
  if (!profile.first_name || profile.first_name.length > 80) return "Enter the person's first name.";
  if (!Number.isInteger(age) || age < 18 || age > 120) return "Enter an age of 18 or over.";
  if (!["Woman", "Man", "Non-binary", "Prefer not to say"].includes(profile.gender)) return "Choose the person's gender.";
  if (!COUNTRIES.includes(profile.location)) return "Choose the country the person lives in.";
  if (!profile.city || profile.city.length > 100) return "Enter the person's city or town.";
  if (!["Serious relationship", "Marriage", "Friendship", "Exploring connections"].includes(profile.relationship_goal)) return "Choose what the person is looking for.";
  if (!profile.bio || profile.bio.length > 500) return "Write a short bio (up to 500 characters).";
  return profile;
}
