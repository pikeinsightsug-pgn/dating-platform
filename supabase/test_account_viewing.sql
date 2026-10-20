-- Lets the owner's test accounts see genuine approved members in Discover Members, so the
-- owner can check what real members look like. Genuine members still never see test
-- accounts, and messaging stays separated in both directions: a test account cannot message
-- a genuine member and a genuine member cannot message a test account.
-- Apply after discovery_messaging_safety.sql (and again if that file is ever rerun).
-- Functions only: no table, column, policy, member row, message or photo is changed.
begin;

do $preflight$
begin
  if to_regprocedure('public.members_share_audience(uuid, uuid)') is null
     or to_regprocedure('public.browse_member_profiles(text, integer, integer, text, text, integer, integer)') is null then
    raise exception 'Apply supabase/discovery_messaging_safety.sql first; no changes applied';
  end if;
end;
$preflight$;

-- Who may see whom: members of the same audience, plus test accounts looking at genuine members.
create or replace function public.member_can_view(viewer uuid, target uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  -- Only a genuine member looking at a test account is refused.
  select coalesce((select a.is_test_account or not b.is_test_account
                   from public.members a, public.members b
                   where a.id = viewer and b.id = target), false)
$$;
revoke all on function public.member_can_view(uuid, uuid) from public, anon, authenticated;

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
    and public.member_can_view(me, m.id)
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
    and public.member_can_view(me, m.id)
    and not public.members_are_blocked(me, m.id)
  order by m.created_at desc;
end;
$$;

create or replace function public.get_member_profile(p_member_id uuid)
returns table (
  id uuid, first_name text, age integer, gender text, location text, city text,
  relationship_goal text, bio text, interests text, profile_photo_path text,
  created_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
declare me uuid := public.require_approved_member();
begin
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
  where m.id = p_member_id and m.id <> me
    and public.member_can_view(me, m.id)
    and m.approved = true and m.age >= 18 and m.user_id is not null
    and not public.members_are_blocked(me, m.id);
end;
$$;

-- Lets the page show or hide "Send a private message" using the same rule as sending.
create or replace function public.can_message_member(p_member_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select p_member_id <> me
       and public.is_approved_member_profile(p_member_id)
       and public.members_share_audience(me, p_member_id)
       and not public.members_are_blocked(me, p_member_id)
    from (select public.current_approved_member_id() as me) s
    where s.me is not null), false)
$$;
revoke all on function public.can_message_member(uuid) from public, anon;
grant execute on function public.can_message_member(uuid) to authenticated;

commit;
