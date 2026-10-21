-- Explicit Data API permissions for the owner console's server-side function.
--
-- From 30 October 2026 Supabase no longer grants Data API permissions automatically on new
-- tables in the public schema. Existing tables keep the permissions they already have, so
-- this file changes nothing that works today: it only writes down, explicitly, the minimum
-- access the admin-members Edge Function (service_role) needs, so the owner console keeps
-- working on a rebuilt project or after any table is recreated.
--
-- GRANT statements only. Nothing is revoked, dropped, deleted or changed: no member, message,
-- photo, approval or referral record is touched. Safe to run more than once.
-- Visitors (anon) and members (authenticated) are NOT given anything here; their access is
-- set in the setup files and runs through Row Level Security and the member functions.
begin;

do $grants$
begin
  -- Owner console: list profiles, approve/reject, link verified accounts, mark test accounts.
  if to_regclass('public.members') is not null then
    grant select, update on public.members to service_role;
  end if;
  -- Owner console: report queue (read, mark reviewed/dismissed).
  if to_regclass('public.member_reports') is not null then
    grant select, update on public.member_reports to service_role;
  end if;
  -- Owner console: original registrations archive (read, record the owner's review).
  if to_regclass('public.legacy_registrations') is not null then
    grant select, update on public.legacy_registrations to service_role;
  end if;
end;
$grants$;

commit;
