-- Worldwide membership: members can register from any country in the list below, not only
-- Uganda and Botswana. Apply after discovery_messaging_safety.sql (and official_account.sql).
-- Additive and safe to rerun: no table, column or member row is dropped, deleted, approved or
-- overwritten. Existing Uganda and Botswana members are unaffected; every other rule (18+,
-- owner approval, private profiles, field limits) stays exactly as before.
-- The country list matches assets/member-core.js and supabase/functions/_shared/countries.js.
begin;

do $preflight$
begin
  if to_regclass('public.members') is null
     or to_regprocedure('public.create_member_profile_from_auth_user()') is null
     or to_regprocedure('public.browse_member_profiles(text, integer, integer, text, text, integer, integer)') is null then
    raise exception 'Apply the earlier checked-in setup files first; no changes applied';
  end if;
end;
$preflight$;

create or replace function public.is_supported_country(p_country text)
returns boolean language sql immutable set search_path = ''
as $$
  select p_country is not null and p_country = any (array[
    'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Antigua and Barbuda', 'Argentina', 'Armenia',
    'Australia', 'Austria', 'Azerbaijan', 'Bahamas', 'Bahrain', 'Bangladesh', 'Barbados', 'Belarus',
    'Belgium', 'Belize', 'Benin', 'Bhutan', 'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil',
    'Brunei', 'Bulgaria', 'Burkina Faso', 'Burundi', 'Cabo Verde', 'Cambodia', 'Cameroon', 'Canada',
    'Central African Republic', 'Chad', 'Chile', 'China', 'Colombia', 'Comoros', 'Congo (Brazzaville)',
    'Congo (DRC)', 'Costa Rica', 'Côte d''Ivoire', 'Croatia', 'Cuba', 'Cyprus', 'Czechia', 'Denmark',
    'Djibouti', 'Dominica', 'Dominican Republic', 'Ecuador', 'Egypt', 'El Salvador', 'Equatorial Guinea',
    'Eritrea', 'Estonia', 'Eswatini', 'Ethiopia', 'Fiji', 'Finland', 'France', 'Gabon', 'Gambia', 'Georgia',
    'Germany', 'Ghana', 'Greece', 'Grenada', 'Guatemala', 'Guinea', 'Guinea-Bissau', 'Guyana', 'Haiti',
    'Honduras', 'Hong Kong', 'Hungary', 'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel',
    'Italy', 'Jamaica', 'Japan', 'Jordan', 'Kazakhstan', 'Kenya', 'Kiribati', 'Kosovo', 'Kuwait',
    'Kyrgyzstan', 'Laos', 'Latvia', 'Lebanon', 'Lesotho', 'Liberia', 'Libya', 'Liechtenstein', 'Lithuania',
    'Luxembourg', 'Madagascar', 'Malawi', 'Malaysia', 'Maldives', 'Mali', 'Malta', 'Marshall Islands',
    'Mauritania', 'Mauritius', 'Mexico', 'Micronesia', 'Moldova', 'Monaco', 'Mongolia', 'Montenegro',
    'Morocco', 'Mozambique', 'Myanmar', 'Namibia', 'Nauru', 'Nepal', 'Netherlands', 'New Zealand',
    'Nicaragua', 'Niger', 'Nigeria', 'North Korea', 'North Macedonia', 'Norway', 'Oman', 'Pakistan', 'Palau',
    'Palestine', 'Panama', 'Papua New Guinea', 'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal',
    'Qatar', 'Romania', 'Russia', 'Rwanda', 'Saint Kitts and Nevis', 'Saint Lucia',
    'Saint Vincent and the Grenadines', 'Samoa', 'San Marino', 'São Tomé and Príncipe', 'Saudi Arabia',
    'Senegal', 'Serbia', 'Seychelles', 'Sierra Leone', 'Singapore', 'Slovakia', 'Slovenia',
    'Solomon Islands', 'Somalia', 'South Africa', 'South Korea', 'South Sudan', 'Spain', 'Sri Lanka',
    'Sudan', 'Suriname', 'Sweden', 'Switzerland', 'Syria', 'Taiwan', 'Tajikistan', 'Tanzania', 'Thailand',
    'Timor-Leste', 'Togo', 'Tonga', 'Trinidad and Tobago', 'Tunisia', 'Türkiye', 'Turkmenistan', 'Tuvalu',
    'Uganda', 'Ukraine', 'United Arab Emirates', 'United Kingdom', 'United States', 'Uruguay', 'Uzbekistan',
    'Vanuatu', 'Vatican City', 'Venezuela', 'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe'
  ]::text[])
$$;
revoke all on function public.is_supported_country(text) from public;
grant execute on function public.is_supported_country(text) to anon, authenticated, service_role;

-- Signup and profile rules: identical to launch_features_secure.sql except the country check.
drop policy if exists "public can register members" on public.members;
create policy "public can register members"
on public.members for insert to anon, authenticated
with check (
  age >= 18 and age <= 120
  and first_name is not null and length(trim(first_name)) between 1 and 80
  and gender in ('Woman', 'Man', 'Non-binary', 'Prefer not to say')
  and public.is_supported_country(location)
  and city is not null and length(trim(city)) between 1 and 100
  and relationship_goal in ('Serious relationship', 'Marriage', 'Friendship', 'Exploring connections')
  and bio is not null and length(trim(bio)) between 1 and 500
  and (interests is null or length(interests) <= 300)
  and (partner_preference is null or length(partner_preference) <= 500)
  and approved = false
  and ((auth.uid() is null and user_id is null) or user_id = auth.uid())
);

drop policy if exists "member registration constraints" on public.members;
create policy "member registration constraints"
on public.members as restrictive for insert to anon, authenticated
with check (
  age >= 18 and age <= 120
  and first_name is not null and length(trim(first_name)) between 1 and 80
  and gender in ('Woman', 'Man', 'Non-binary', 'Prefer not to say')
  and public.is_supported_country(location)
  and city is not null and length(trim(city)) between 1 and 100
  and relationship_goal in ('Serious relationship', 'Marriage', 'Friendship', 'Exploring connections')
  and bio is not null and length(trim(bio)) between 1 and 500
  and (interests is null or length(interests) <= 300)
  and (partner_preference is null or length(partner_preference) <= 500)
  and approved = false
  and ((auth.uid() is null and user_id is null) or user_id = auth.uid())
);

drop policy if exists "members can update own profile" on public.members;
create policy "members can update own profile"
on public.members for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid() and age >= 18 and age <= 120
  and gender in ('Woman', 'Man', 'Non-binary', 'Prefer not to say')
  and public.is_supported_country(location)
  and city is not null and length(trim(city)) between 1 and 100
  and relationship_goal in ('Serious relationship', 'Marriage', 'Friendship', 'Exploring connections')
  and bio is not null and length(trim(bio)) between 1 and 500
  and (interests is null or length(interests) <= 300)
  and (partner_preference is null or length(partner_preference) <= 500));

drop policy if exists "private member profile update boundary" on public.members;
create policy "private member profile update boundary"
on public.members as restrictive for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid() and age >= 18 and age <= 120
  and gender in ('Woman', 'Man', 'Non-binary', 'Prefer not to say')
  and public.is_supported_country(location)
  and city is not null and length(trim(city)) between 1 and 100
  and relationship_goal in ('Serious relationship', 'Marriage', 'Friendship', 'Exploring connections')
  and bio is not null and length(trim(bio)) between 1 and 500
  and (interests is null or length(interests) <= 300)
  and (partner_preference is null or length(partner_preference) <= 500));

-- The email-confirmation trigger, identical to discovery_messaging_safety.sql except that it
-- accepts any supported country.
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
  profile_seeking text;
  profile_age_min integer;
  profile_age_max integer;
begin
  if new.email_confirmed_at is null
     or coalesce(profile->>'profile_type', '') <> 'member_registration'
     or not (profile ? 'first_name') then
    return new;
  end if;

  if coalesce(profile->>'age', '') !~ '^[0-9]{1,3}$' then
    raise warning 'Skipped member profile for auth user %: invalid age', new.id;
    return new;
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
  -- Optional preferences: anything unexpected is stored as "not given" rather than rejected.
  profile_seeking := case when profile->>'seeking_gender' in ('Men', 'Women', 'Everyone') then profile->>'seeking_gender' end;
  if coalesce(profile->>'preferred_age_min', '') ~ '^[0-9]{2,3}$' and coalesce(profile->>'preferred_age_max', '') ~ '^[0-9]{2,3}$'
     and (profile->>'preferred_age_min')::integer between 18 and 120
     and (profile->>'preferred_age_max')::integer between (profile->>'preferred_age_min')::integer and 120 then
    profile_age_min := (profile->>'preferred_age_min')::integer;
    profile_age_max := (profile->>'preferred_age_max')::integer;
  end if;

  if profile_age < 18 or profile_age > 120
     or profile_first_name is null or length(profile_first_name) > 80
     or profile_gender is null or profile_gender not in ('Woman', 'Man', 'Non-binary', 'Prefer not to say')
     or not public.is_supported_country(profile_location)
     or profile_city is null or length(profile_city) > 100
     or profile_goal is null or profile_goal not in ('Serious relationship', 'Marriage', 'Friendship', 'Exploring connections')
     or profile_bio is null or length(profile_bio) > 500
     or (profile_interests is not null and length(profile_interests) > 300)
     or (profile_preference is not null and length(profile_preference) > 500) then
    raise warning 'Skipped member profile for auth user %: invalid registration fields', new.id;
    return new;
  end if;

  -- A database rule rejecting the row (for example an older NOT NULL column) must not
  -- fail the person's signup or email confirmation. The sign-in page retries and shows
  -- a clear message if the profile still cannot be saved.
  begin
    insert into public.members (
      user_id, first_name, age, gender, location, city,
      relationship_goal, bio, interests, partner_preference,
      seeking_gender, preferred_age_min, preferred_age_max, approved
    ) values (
      new.id, profile_first_name, profile_age, profile_gender, profile_location, profile_city,
      profile_goal, profile_bio, profile_interests, profile_preference,
      profile_seeking, profile_age_min, profile_age_max, false
    )
    on conflict (user_id) where user_id is not null do nothing;
  exception when others then
    raise warning 'Skipped member profile for auth user %: % (%)', new.id, sqlerrm, sqlstate;
  end;

  return new;
end;
$member_profile_trigger$;
revoke all on function public.create_member_profile_from_auth_user() from public, anon, authenticated;

commit;
