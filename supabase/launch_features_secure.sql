-- Secure launch foundation for Find Your Person.
-- Additive only: preserves existing member records and does not enable payments.
-- Run this file in the Supabase SQL Editor after reviewing it.
-- Existing public registrations remain possible; existing rows stay unapproved and unlinked.

begin;

alter table public.members
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists city text,
  add column if not exists bio text,
  add column if not exists interests text,
  add column if not exists partner_preference text,
  add column if not exists profile_photo_url text,
  add column if not exists approved boolean not null default false;

create unique index if not exists members_user_id_unique
  on public.members(user_id) where user_id is not null;


-- Save a profile at email confirmation without trusting an ID supplied by the browser.
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
drop trigger if exists create_member_profile_after_auth_confirmation on auth.users;
create trigger create_member_profile_after_auth_confirmation
after insert or update of email_confirmed_at on auth.users
for each row
when (new.email_confirmed_at is not null)
execute function public.create_member_profile_from_auth_user();
create index if not exists members_approved_location_idx
  on public.members(approved, location);

create table if not exists public.member_messages (
  id uuid primary key default gen_random_uuid(),
  sender_member_id uuid not null references public.members(id) on delete cascade,
  recipient_member_id uuid not null references public.members(id) on delete cascade,
  body text not null check (length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint member_messages_no_self_message check (sender_member_id <> recipient_member_id)
);
create index if not exists member_messages_sender_created_idx
  on public.member_messages(sender_member_id, created_at desc);
create index if not exists member_messages_recipient_created_idx
  on public.member_messages(recipient_member_id, created_at desc);

-- Private profile-photo storage, matching the website's bucket name.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-photos', 'profile-photos', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = false,
    file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

alter table public.members enable row level security;
alter table public.member_messages enable row level security;

create or replace function public.current_approved_member_id()
returns uuid language sql stable security definer set search_path = ''
as $$
  select m.id from public.members m
  where m.user_id = auth.uid() and m.approved = true and m.age >= 18
  limit 1
$$;

create or replace function public.is_approved_member_profile(profile_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.id = profile_id and m.approved = true and m.age >= 18
  )
$$;

revoke all on function public.current_approved_member_id() from public, anon;
revoke all on function public.is_approved_member_profile(uuid) from public, anon;
grant execute on function public.current_approved_member_id() to authenticated;
grant execute on function public.is_approved_member_profile(uuid) to authenticated;

create or replace function public.browse_approved_profiles()
returns table (
  id uuid, first_name text, age integer, gender text, location text,
  relationship_goal text, bio text, interests text, partner_preference text,
  created_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if public.current_approved_member_id() is null then
    raise exception 'Only approved adult members can browse profiles';
  end if;
  return query
  select m.id, m.first_name, m.age, m.gender, m.location,
         m.relationship_goal, m.bio, m.interests, m.partner_preference, m.created_at
  from public.members m
  where m.approved = true and m.age >= 18
    and m.id <> public.current_approved_member_id()
  order by m.created_at desc;
end;
$$;
revoke all on function public.browse_approved_profiles() from public, anon;
grant execute on function public.browse_approved_profiles() to authenticated;

revoke all on public.members from public, anon, authenticated;

-- Clear any legacy per-column client grants before restoring only the intended profile access.
do $member_grants$
declare
  member_columns text;
begin
  select string_agg(format('%I', column_name), ', ')
    into member_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'members';

  if member_columns is not null then
    execute format('revoke select (%s) on table public.members from public, anon, authenticated', member_columns);
    execute format('revoke insert (%s) on table public.members from public, anon, authenticated', member_columns);
    execute format('revoke update (%s) on table public.members from public, anon, authenticated', member_columns);
  end if;
end;
$member_grants$;

grant insert on public.members to anon, authenticated;
grant select on public.members to authenticated;
grant update (first_name, age, gender, location, city, relationship_goal, bio, interests, partner_preference)
  on public.members to authenticated;

-- Public registration inserts only unapproved, unlinked registrations.
drop policy if exists "public can register members" on public.members;
create policy "public can register members"
on public.members for insert to anon, authenticated
with check (
  age >= 18 and age <= 120
  and first_name is not null and length(trim(first_name)) between 1 and 80
  and gender in ('Woman', 'Man', 'Non-binary', 'Prefer not to say')
  and location in ('Uganda', 'Botswana')
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
  and location in ('Uganda', 'Botswana')
  and city is not null and length(trim(city)) between 1 and 100
  and relationship_goal in ('Serious relationship', 'Marriage', 'Friendship', 'Exploring connections')
  and bio is not null and length(trim(bio)) between 1 and 500
  and (interests is null or length(interests) <= 300)
  and (partner_preference is null or length(partner_preference) <= 500)
  and approved = false
  and ((auth.uid() is null and user_id is null) or user_id = auth.uid())
);

drop policy if exists "members can read own profile" on public.members;
create policy "members can read own profile"
on public.members for select to authenticated
using (user_id = auth.uid());

-- Restrictive boundaries also constrain any older permissive policies left on the table.
drop policy if exists "private member profile read boundary" on public.members;
create policy "private member profile read boundary"
on public.members as restrictive for select to authenticated
using (user_id = auth.uid());

drop policy if exists "members can update own profile" on public.members;
create policy "members can update own profile"
on public.members for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid() and age >= 18 and age <= 120
  and gender in ('Woman', 'Man', 'Non-binary', 'Prefer not to say')
  and location in ('Uganda', 'Botswana')
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
  and location in ('Uganda', 'Botswana')
  and city is not null and length(trim(city)) between 1 and 100
  and relationship_goal in ('Serious relationship', 'Marriage', 'Friendship', 'Exploring connections')
  and bio is not null and length(trim(bio)) between 1 and 500
  and (interests is null or length(interests) <= 300)
  and (partner_preference is null or length(partner_preference) <= 500));

-- Anonymous registration uploads are restricted to this private bucket.
drop policy if exists "public can upload registration photos" on storage.objects;
create policy "public can upload registration photos"
on storage.objects for insert to anon, authenticated
with check (bucket_id = 'profile-photos');

drop policy if exists "approved members can send messages" on public.member_messages;
drop policy if exists "participants can read their messages" on public.member_messages;
create policy "approved members can send messages"
on public.member_messages for insert to authenticated
with check (
  sender_member_id = public.current_approved_member_id()
  and public.is_approved_member_profile(recipient_member_id)
);
create policy "participants can read their messages"
on public.member_messages for select to authenticated
using (
  sender_member_id = public.current_approved_member_id()
  or recipient_member_id = public.current_approved_member_id()
);
grant select, insert on public.member_messages to authenticated;

-- Existing records remain unapproved and unlinked until manually reviewed.
-- Payments remain disabled; no member is automatically approved.
commit;
