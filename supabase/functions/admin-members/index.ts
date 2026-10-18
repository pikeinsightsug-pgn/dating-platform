import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isMemberPhotoPathOwnedByUser } from "../_shared/member-photo-path.js";

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
    status?: string; legacy_id?: string; is_test_account?: boolean; notes?: string;
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
      is_test_account: m.is_test_account === true, created_at: m.created_at,
    }));
    const authUsers = new Map<string, { email: string | null }>();
    for (let page = 1; ; page++) {
      const { data: authPage, error: authListError } = await db.auth.admin.listUsers({ page, perPage: 1000 });
      if (authListError) return json({ error: "Could not load registered account identifiers.", detail: authListError.message }, 500);
      for (const authUser of authPage.users) authUsers.set(authUser.id, { email: authUser.email ?? null });
      if (authPage.users.length < 1000) break;
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
        admin_photo_signed_url,
      };
    }));
    return json({
      members: identifiedRows,
      metrics: {
        total: rows.length,
        approved: rows.filter((m) => m.approved === true).length,
        pending: rows.filter((m) => m.approved !== true).length,
        linked: rows.filter((m) => !!m.user_id).length,
        test_accounts: rows.filter((m) => m.is_test_account).length,
        // The free founding-member allowance counts genuine members only.
        genuine_approved: rows.filter((m) => m.approved && !m.is_test_account && m.user_id && (m.age ?? 0) >= 18).length,
        unlinked: rows.filter((m) => !m.user_id).length,
        target: 100,
      },
    });
  }

  const uuid = /^[0-9a-f-]{36}$/i;

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
