-- Add authenticated member discovery and secure private profile photos.
-- Apply after reviewing the live schema and running registration_setup.sql plus launch_features_secure.sql.
-- This migration preserves all existing member rows and changes no member approval state.
begin;

do $preflight$
begin
  if to_regclass('public.members') is null then
    raise exception 'Expected public.members table was not found; no changes applied';
  end if;
  if not exists (select 1 from information_schema.columns
      where table_schema='public' and table_name='members' and column_name='user_id')
     or not exists (select 1 from information_schema.columns
      where table_schema='public' and table_name='members' and column_name='profile_photo_url')
     or not exists (select 1 from information_schema.columns
      where table_schema='public' and table_name='members' and column_name='approved') then
    raise exception 'Run the checked-in registration and secure setup first; no changes applied';
  end if;
end;
$preflight$;

-- Keep photos private, with a 5 MiB limit and browser-friendly image formats.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-photos', 'profile-photos', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = false,
    file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

create or replace function public.can_read_member_photo(object_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.members m
    where m.profile_photo_url = object_name
      and m.user_id is not null
      and (
        m.user_id = auth.uid()
        or (
          m.approved = true and m.age >= 18
          and public.current_approved_member_id() is not null
        )
      )
  )
$$;
revoke all on function public.can_read_member_photo(text) from public, anon;
grant execute on function public.can_read_member_photo(text) to authenticated;

-- Revoke the older anonymous bucket-wide upload policy from the setup scripts.
drop policy if exists "public can upload registration photos" on storage.objects;
drop policy if exists "members can upload own profile photos" on storage.objects;
drop policy if exists "members can view approved profile photos" on storage.objects;
drop policy if exists "members can replace own profile photos" on storage.objects;
drop policy if exists "members can remove own profile photos" on storage.objects;

create policy "members can upload own profile photos"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'profile-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);
create policy "members can view approved profile photos"
on storage.objects for select to authenticated
using (
  bucket_id = 'profile-photos'
  and public.can_read_member_photo(name)
);
create policy "members can remove own profile photos"
on storage.objects for delete to authenticated
using (
  bucket_id = 'profile-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- Let each signed-in member change only their own photo reference.
grant update (profile_photo_url) on public.members to authenticated;

create or replace function public.validate_member_photo_reference()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.profile_photo_url is distinct from old.profile_photo_url
     and new.profile_photo_url is not null
     and (
       auth.uid() is null
       or new.user_id is distinct from auth.uid()
       or (storage.foldername(new.profile_photo_url))[1] is distinct from auth.uid()::text
     ) then
    raise exception 'Profile photos must reference a file in your private folder';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_member_photo_reference() from public, anon, authenticated;
drop trigger if exists validate_member_photo_reference on public.members;
create trigger validate_member_photo_reference
before update of profile_photo_url on public.members
for each row execute function public.validate_member_photo_reference();

-- Return only fields intended for approved member discovery. Partner preferences and
-- account identifiers remain private. Discovery opens as soon as there are profiles.
drop function if exists public.browse_approved_profiles();
create function public.browse_approved_profiles()
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
