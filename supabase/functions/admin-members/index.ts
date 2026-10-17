import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

  let body: { action?: string; member_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON." }, 400); }

  const db = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (body.action === "list") {
    const { data, error } = await db.from("members")
      .select("id, user_id, first_name, age, gender, location, city, relationship_goal, bio, interests, partner_preference, profile_photo_url, approved, created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return json({ error: "Could not load registrations.", detail: error.message }, 500);
    const rows = data || [];
    const authUsers = new Map<string, { email: string | null }>();
    for (let page = 1; ; page++) {
      const { data: authPage, error: authListError } = await db.auth.admin.listUsers({ page, perPage: 1000 });
      if (authListError) return json({ error: "Could not load registered account identifiers.", detail: authListError.message }, 500);
      for (const authUser of authPage.users) authUsers.set(authUser.id, { email: authUser.email ?? null });
      if (authPage.users.length < 1000) break;
    }
    const identifiedRows = rows.map((member) => ({
      ...member,
      account_email: member.user_id ? authUsers.get(member.user_id)?.email ?? null : null,
    }));
    return json({
      members: identifiedRows,
      metrics: {
        total: rows.length,
        approved: rows.filter((m) => m.approved === true).length,
        pending: rows.filter((m) => m.approved !== true).length,
        target: 100,
      },
    });
  }

  if (body.action === "approve" || body.action === "reject") {
    if (typeof body.member_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.member_id)) {
      return json({ error: "A valid member ID is required." }, 400);
    }
    const approved = body.action === "approve";
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
