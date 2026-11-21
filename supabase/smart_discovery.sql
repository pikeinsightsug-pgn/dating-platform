-- Smarter Discover Members ordering and "recently active" labels (November 2026).
-- Apply after official_account.sql, worldwide_members.sql, member_profession.sql and
-- everyone_visible.sql. Additive and safe to rerun: no table, column or member row is
-- dropped, deleted, approved or overwritten, and nobody new becomes visible.
--
-- What it does:
--   * browse_member_profiles keeps the same filters, visibility rules and returned columns,
--     but lists the best fits first instead of only the newest members:
--       1. members with a profile photo (always before members without one),
--       2. same city (ignoring capitals and a trailing "city", so "FRANCISTOWN" and
--          "Gulu city" match "Francistown" and "Gulu"), 3. same country,
--       4. recently active members, 5. newest members.
--   * member_activity(ids) returns only a coarse label ("Active today" / "Active this week")
--     for members the caller is already allowed to see. Exact sign-in or message times are
--     never returned.
begin;

do $preflight$
begin
  if to_regprocedure('public.browse_member_profiles(text, integer, integer, text, text, integer, integer)') is null
     or to_regprocedure('public.members_share_audience(uuid, uuid)') is null
     or to_regprocedure('public.require_approved_member()') is null
     or to_regprocedure('public.members_are_blocked(uuid, uuid)') is null
     or to_regprocedure('public.get_member_profile(uuid)') is null
     or to_regclass('public.member_messages') is null then
    raise exception 'Apply the earlier checked-in setup files first; no changes applied';
  end if;
end;
$preflight$;

-- "Gulu city", " gulu " and "GULU" all become "gulu".
create or replace function public.normalized_city(p_city text)
returns text language sql immutable set search_path = ''
as $$
  select nullif(regexp_replace(lower(trim(coalesce(p_city, ''))), '\s+city$', ''), '')
$$;
revoke all on function public.normalized_city(text) from public, anon;
grant execute on function public.normalized_city(text) to authenticated;

-- Latest sign-in or sent message. Owner-side helper only; members never call it directly.
create or replace function public.member_last_active(p_member_id uuid)
returns timestamptz language sql stable security definer set search_path = ''
as $$
  select greatest(
    (select u.last_sign_in_at from public.members m join auth.users u on u.id = m.user_id
      where m.id = p_member_id),
    (select max(mm.created_at) from public.member_messages mm
      where mm.sender_member_id = p_member_id))
$$;
revoke all on function public.member_last_active(uuid) from public, anon, authenticated;

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
  my_city text;
  my_country text;
begin
  select public.normalized_city(own.city), own.location into my_city, my_country
  from public.members own where own.id = me;

  return query
  with visible as (
    select m.id, m.first_name, m.age, m.gender, m.location, m.city,
           m.relationship_goal, m.bio, m.interests,
           case
             when m.profile_photo_url is not null
              and (storage.foldername(m.profile_photo_url))[1] = m.user_id::text
             then m.profile_photo_url
           end as photo_path,
           m.created_at,
           public.member_last_active(m.id) as last_active
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
  )
  select v.id, v.first_name, v.age, v.gender, v.location, v.city,
         v.relationship_goal, v.bio, v.interests, v.photo_path,
         v.created_at,
         count(*) over ()
  from visible v
  order by
    (v.photo_path is not null) desc,
    (my_city is not null and v.location = my_country
      and public.normalized_city(v.city) = my_city) desc,
    (v.location = my_country) desc,
    v.last_active desc nulls last,
    v.created_at desc,
    v.id
  limit page_size offset page_offset;
end;
$$;

create or replace function public.member_activity(p_member_ids uuid[])
returns table (id uuid, activity text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  member_id uuid;
  seen timestamptz;
begin
  if public.current_approved_member_id() is null then
    return;
  end if;
  foreach member_id in array coalesce(p_member_ids[1:50], array[]::uuid[]) loop
    -- Only members the caller may already see (approved, not blocked, not themselves).
    if exists (select 1 from public.get_member_profile(member_id)) then
      seen := public.member_last_active(member_id);
      if seen > now() - interval '1 day' then
        id := member_id; activity := 'Active today'; return next;
      elsif seen > now() - interval '7 days' then
        id := member_id; activity := 'Active this week'; return next;
      end if;
    end if;
  end loop;
end;
$$;

do $grants$
declare fn text;
begin
  foreach fn in array array[
    'public.browse_member_profiles(text, integer, integer, text, text, integer, integer)',
    'public.member_activity(uuid[])'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$grants$;

commit;
