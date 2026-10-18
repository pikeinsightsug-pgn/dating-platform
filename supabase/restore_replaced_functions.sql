-- RESTORE the two functions that discovery_messaging_safety.sql replaces, exactly as they
-- were installed by launch_features_secure.sql and member_discovery_photos.sql.
-- Use only if the repair must be undone. It changes no member record, deletes nothing,
-- and leaves the new (empty) tables, columns and member functions in place, unused by
-- the live site. Prefer the definitions you saved from production with
-- pg_get_functiondef if they differ from these.
begin;

create or replace function public.create_member_profile_from_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $member_profile_trigger$
declare
  profile jsonb := new.raw_user_meta_data;
  profile_age integer;
  profile_first_name text;
  profile_gender text;
  profile_location text;
  profile_city text;
  profile_goal text;
  profile_bio text;
  profile_interests text;
  profile_preference text;
begin
  if new.email_confirmed_at is null
     or coalesce(profile->>'profile_type', '') <> 'member_registration'
     or not (profile ? 'first_name') then
    return new;
  end if;

  if coalesce(profile->>'age', '') !~ '^[0-9]{1,3}$' then
    raise exception 'A valid adult age is required to create the member profile';
  end if;
  profile_age := (profile->>'age')::integer;
  profile_first_name := nullif(trim(profile->>'first_name'), '');
  profile_gender := profile->>'gender';
  profile_location := profile->>'location';
  profile_city := nullif(trim(profile->>'city'), '');
  profile_goal := profile->>'relationship_goal';
  profile_bio := nullif(trim(profile->>'bio'), '');
  profile_interests := nullif(trim(coalesce(profile->>'interests', '')), '');
  profile_preference := nullif(trim(coalesce(profile->>'partner_preference', '')), '');

  if profile_age < 18 or profile_age > 120
     or profile_first_name is null or length(profile_first_name) > 80
     or profile_gender not in ('Woman', 'Man', 'Non-binary', 'Prefer not to say')
     or profile_location not in ('Uganda', 'Botswana')
     or profile_city is null or length(profile_city) > 100
     or profile_goal not in ('Serious relationship', 'Marriage', 'Friendship', 'Exploring connections')
     or profile_bio is null or length(profile_bio) > 500
     or (profile_interests is not null and length(profile_interests) > 300)
     or (profile_preference is not null and length(profile_preference) > 500) then
    raise exception 'Registration profile fields are invalid';
  end if;

  insert into public.members (
    user_id, first_name, age, gender, location, city,
    relationship_goal, bio, interests, partner_preference, approved
  ) values (
    new.id, profile_first_name, profile_age, profile_gender, profile_location, profile_city,
    profile_goal, profile_bio, profile_interests, profile_preference, false
  )
  on conflict (user_id) where user_id is not null do nothing;

  return new;
end;
$member_profile_trigger$;
revoke all on function public.create_member_profile_from_auth_user() from public, anon, authenticated;

create or replace function public.browse_approved_profiles()
returns table (
  id uuid, first_name text, age integer, gender text, location text, city text,
  relationship_goal text, bio text, interests text, profile_photo_path text,
  created_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if public.current_approved_member_id() is null then
    raise exception 'Only approved adult members can browse profiles';
  end if;
  return query
  select m.id, m.first_name, m.age, m.gender, m.location, m.city,
         m.relationship_goal, m.bio, m.interests,
         case
           when m.profile_photo_url is not null
            and (storage.foldername(m.profile_photo_url))[1] = m.user_id::text
           then m.profile_photo_url
           else null
         end,
         m.created_at
  from public.members m
  where m.approved = true and m.age >= 18
    and m.id <> public.current_approved_member_id()
  order by m.created_at desc;
end;
$$;
revoke all on function public.browse_approved_profiles() from public, anon;
grant execute on function public.browse_approved_profiles() to authenticated;

commit;
