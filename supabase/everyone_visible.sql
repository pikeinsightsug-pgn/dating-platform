-- Everyone visible: approved members always see and can message every other approved member.
-- The owner's "test account" marker no longer hides anyone; it only keeps an account out of
-- the member totals in the owner console. Apply once in the SQL Editor (safe to rerun).
-- Functions only: no member, photo, message, approval or referral record is changed.
-- Pending (unapproved) members, blocked pairs and the official account's pinned placement
-- are unchanged.
begin;

do $preflight$
begin
  if to_regprocedure('public.members_share_audience(uuid, uuid)') is null then
    raise exception 'Apply supabase/discovery_messaging_safety.sql first; no changes applied';
  end if;
end;
$preflight$;

create or replace function public.members_share_audience(member_a uuid, member_b uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.members a where a.id = member_a)
     and exists (select 1 from public.members b where b.id = member_b)
$$;
revoke all on function public.members_share_audience(uuid, uuid) from public, anon, authenticated;

commit;
