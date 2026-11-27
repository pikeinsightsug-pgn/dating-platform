-- "🆕 Just joined" on Discover (November 2026). Apply after discovery_messaging_safety.sql and
-- official_account.sql. Additive and safe to rerun: one read-only function; no table, column,
-- member, photo or message is changed.
--
-- just_joined_members() lists genuine approved members who joined in the last 7 days and who
-- fit the signed-in member BOTH ways:
--   * the newcomer is someone the viewer wants to meet ("I would like to meet": Men, Women or
--     Everyone; no answer means everyone), and
--   * the viewer is someone the newcomer wants to meet.
-- So James (a man looking for women) is shown to women looking for men or for everyone, and
-- never to people he did not ask to meet. Blocked pairs, the official account, test accounts,
-- paused and banned members never appear. Newcomers with a photo come first.
begin;

do $preflight$
begin
  if to_regprocedure('public.require_approved_member()') is null
     or to_regprocedure('public.members_are_blocked(uuid, uuid)') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public'
                      and table_name = 'members' and column_name = 'seeking_gender')
     or not exists (select 1 from information_schema.columns where table_schema = 'public'
                      and table_name = 'members' and column_name = 'is_official') then
    raise exception 'Apply discovery_messaging_safety.sql and official_account.sql first; no changes applied';
  end if;
end;
$preflight$;

-- True when someone whose "I would like to meet" answer is p_seeking wants to meet p_gender.
create or replace function public.seeks_gender(p_seeking text, p_gender text)
returns boolean language sql immutable set search_path = ''
as $$
  select p_seeking is null or p_seeking = 'Everyone'
      or (p_seeking = 'Men' and lower(coalesce(p_gender, '')) in ('man', 'male'))
      or (p_seeking = 'Women' and lower(coalesce(p_gender, '')) in ('woman', 'female'));
$$;
revoke all on function public.seeks_gender(text, text) from public, anon;
grant execute on function public.seeks_gender(text, text) to authenticated;

create or replace function public.just_joined_members(p_limit integer default 6)
returns table (id uuid, first_name text, age integer, gender text, location text, city text,
               relationship_goal text, bio text, profile_photo_path text, joined_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me uuid := public.require_approved_member();
  my public.members%rowtype;
begin
  select * into my from public.members where public.members.id = me;
  return query
  select m.id, m.first_name, m.age, m.gender, m.location, m.city, m.relationship_goal, m.bio,
         case when m.profile_photo_url is not null
               and (storage.foldername(m.profile_photo_url))[1] = m.user_id::text
              then m.profile_photo_url end as photo_path,
         m.created_at
  from public.members m
  where m.approved = true and m.age >= 18 and m.user_id is not null and m.id <> me
    and m.is_official = false
    and coalesce((to_jsonb(m) ->> 'is_test_account')::boolean, false) = false
    and coalesce((to_jsonb(m) ->> 'banned')::boolean, false) = false
    and m.created_at > now() - interval '7 days'
    and not public.members_are_blocked(me, m.id)
    and public.seeks_gender(my.seeking_gender, m.gender)
    and public.seeks_gender(m.seeking_gender, my.gender)
  order by (m.profile_photo_url is not null) desc, m.created_at desc, m.id
  limit least(12, greatest(1, coalesce(p_limit, 6)));
end;
$$;
revoke all on function public.just_joined_members(integer) from public, anon;
grant execute on function public.just_joined_members(integer) to authenticated;

commit;
