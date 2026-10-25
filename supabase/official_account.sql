-- Official founder account ("Pike – Founder ✅").
-- Apply after discovery_messaging_safety.sql (and member_extra_photos.sql if used).
-- Additive and safe to rerun: no table, column or member row is dropped, deleted, approved
-- or overwritten. Every member keeps is_official = false until the owner marks an account
-- in /admin/.
--
-- What it does:
--   * members.is_official: owner-only marker (members cannot set it; no column grant).
--   * The official account is kept out of Discover Members, so it never appears as someone
--     to date. Approved members find it through list_official_accounts() instead, which the
--     site shows as a pinned "Official P.K Connect account" card with a ✅ badge.
--   * The official account may send welcome messages faster than the normal 30 per 10 minutes.
--   * Members cannot give themselves names such as "Official", "Founder", "Admin" or
--     "P.K Connect", so nobody can pose as the official account.
begin;

do $preflight$
begin
  if to_regprocedure('public.members_share_audience(uuid, uuid)') is null
     or to_regprocedure('public.require_approved_member()') is null
     or to_regprocedure('public.members_are_blocked(uuid, uuid)') is null then
    raise exception 'Apply supabase/discovery_messaging_safety.sql first; no changes applied';
  end if;
end;
$preflight$;

alter table public.members add column if not exists is_official boolean not null default false;
-- Members can read their own flag (table-level select) but never change it.
revoke update (is_official) on public.members from public, anon, authenticated;

-- Names reserved for the official account. Checked only for changes made by members
-- themselves (the website), so the signup trigger, the owner console and the SQL editor are
-- never blocked, and an unchanged name never stops a member from saving their profile.
create or replace function public.is_reserved_member_name(p_name text)
returns boolean language sql immutable set search_path = ''
as $$
  select coalesce(p_name, '') ~* '(\m(official|founder|admin|administrator|moderator|support)\M|p\W*k\W*connect)'
$$;
revoke all on function public.is_reserved_member_name(text) from public, anon;
grant execute on function public.is_reserved_member_name(text) to authenticated;

create or replace function public.protect_official_member_names()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon')
     and coalesce(new.is_official, false) = false
     and (tg_op = 'INSERT' or new.first_name is distinct from old.first_name)
     and public.is_reserved_member_name(new.first_name) then
    raise exception 'This name is reserved for the official P.K Connect account. Please use your own first name.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.protect_official_member_names() from public, anon, authenticated;
drop trigger if exists protect_official_member_names on public.members;
create trigger protect_official_member_names
  before insert or update of first_name on public.members
  for each row execute function public.protect_official_member_names();

-- The official account(s) an approved member can contact. Same audience and block rules as
-- every other member feature: test accounts only see test officials, and a member who
-- blocked the official account no longer sees it.
create or replace function public.list_official_accounts()
returns table (
  id uuid, first_name text, location text, city text, bio text, profile_photo_path text
)
language plpgsql stable security definer set search_path = ''
as $$
declare me uuid := public.require_approved_member();
begin
  return query
  select m.id, m.first_name, m.location, m.city, m.bio,
         case
           when m.profile_photo_url is not null
            and (storage.foldername(m.profile_photo_url))[1] = m.user_id::text
           then m.profile_photo_url
         end
  from public.members m
  where m.is_official = true and m.approved = true and m.user_id is not null
    and m.id <> me
    and public.members_share_audience(me, m.id)
    and not public.members_are_blocked(me, m.id)
  order by m.created_at;
end;
$$;

-- Discovery, unchanged except that official accounts are left out (they are not dating
-- profiles). Same signature as in discovery_messaging_safety.sql.
create or replace function public.browse_member_profiles(
  p_country text default null,
  p_min_age integer default 18,
  p_max_age integer default 120,
  p_relationship_goal text default null,
  p_gender text default null,
  p_limit integer default 24,
  p_offset integer default 0
)
returns table (
  id uuid, first_name text, age integer, gender text, location text, city text,
  relationship_goal text, bio text, interests text, profile_photo_path text,
  created_at timestamptz, total_count bigint
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me uuid := public.require_approved_member();
  min_age integer := greatest(18, coalesce(p_min_age, 18));
  max_age integer := least(120, coalesce(p_max_age, 120));
  page_size integer := least(50, greatest(1, coalesce(p_limit, 24)));
  page_offset integer := greatest(0, coalesce(p_offset, 0));
begin
  return query
  select m.id, m.first_name, m.age, m.gender, m.location, m.city,
         m.relationship_goal, m.bio, m.interests,
         case
           when m.profile_photo_url is not null
            and (storage.foldername(m.profile_photo_url))[1] = m.user_id::text
           then m.profile_photo_url
         end,
         m.created_at,
         count(*) over ()
  from public.members m
  where m.approved = true and m.age >= 18 and m.user_id is not null
    and m.id <> me
    and m.is_official = false
    and public.members_share_audience(me, m.id)
    and m.age between min_age and max_age
    and (nullif(p_country, '') is null or m.location = p_country)
    and (nullif(p_relationship_goal, '') is null or m.relationship_goal = p_relationship_goal)
    and (nullif(p_gender, '') is null or m.gender = p_gender)
    and not public.members_are_blocked(me, m.id)
  order by m.created_at desc, m.id
  limit page_size offset page_offset;
end;
$$;

create or replace function public.browse_approved_profiles()
returns table (
  id uuid, first_name text, age integer, gender text, location text, city text,
  relationship_goal text, bio text, interests text, profile_photo_path text,
  created_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
declare me uuid := public.current_approved_member_id();
begin
  if me is null then
    raise exception 'Only approved adult members can browse profiles';
  end if;
  return query
  select m.id, m.first_name, m.age, m.gender, m.location, m.city,
         m.relationship_goal, m.bio, m.interests,
         case
           when m.profile_photo_url is not null
            and (storage.foldername(m.profile_photo_url))[1] = m.user_id::text
           then m.profile_photo_url
         end,
         m.created_at
  from public.members m
  where m.approved = true and m.age >= 18 and m.user_id is not null
    and m.id <> me
    and m.is_official = false
    and public.members_share_audience(me, m.id)
    and not public.members_are_blocked(me, m.id)
  order by m.created_at desc;
end;
$$;

-- Messaging, unchanged except for a higher sending limit for the official account so the
-- founder can welcome new members. Every other rule (approval, blocks, audience, length)
-- still applies to it.
create or replace function public.send_member_message(p_recipient_member_id uuid, p_body text)
returns table (id uuid, created_at timestamptz)
language plpgsql volatile security definer set search_path = ''
as $$
declare
  me uuid := public.require_approved_member();
  clean_body text := trim(coalesce(p_body, ''));
  send_limit integer := case
    when exists (select 1 from public.members o where o.id = me and o.is_official) then 300 else 30 end;
begin
  if p_recipient_member_id is null or p_recipient_member_id = me
     or not public.is_approved_member_profile(p_recipient_member_id) then
    raise exception 'This member cannot receive messages' using errcode = '42501';
  end if;
  if public.members_are_blocked(me, p_recipient_member_id)
     or not public.members_share_audience(me, p_recipient_member_id) then
    raise exception 'This member cannot receive messages' using errcode = '42501';
  end if;
  if length(clean_body) < 1 or length(clean_body) > 2000 then
    raise exception 'Messages must be between 1 and 2000 characters' using errcode = '22023';
  end if;
  if (select count(*) from public.member_messages mm
      where mm.sender_member_id = me and mm.created_at > now() - interval '10 minutes') >= send_limit then
    raise exception 'You are sending messages too quickly. Please wait a few minutes.' using errcode = '54000';
  end if;
  return query
  insert into public.member_messages (sender_member_id, recipient_member_id, body)
  values (me, p_recipient_member_id, clean_body)
  returning member_messages.id, member_messages.created_at;
end;
$$;

do $grants$
declare fn text;
begin
  foreach fn in array array[
    'public.list_official_accounts()',
    'public.browse_member_profiles(text, integer, integer, text, text, integer, integer)',
    'public.browse_approved_profiles()',
    'public.send_member_message(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$grants$;

commit;
