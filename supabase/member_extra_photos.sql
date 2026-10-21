-- Extra profile photos: each member can add up to 6 more photos to their profile.
-- They follow the main photo's rules: files live in the member's own private folder of the
-- profile-photos bucket, and only signed-in approved members can see them, through the same
-- visibility rules as the profile itself (get_member_profile), so pending members, blocked
-- members and the owner's test accounts are kept apart exactly as today.
-- Apply after discovery_messaging_safety.sql. If member_discovery_photos.sql is ever rerun,
-- rerun this file afterwards (it extends can_read_member_photo).
-- Additive only: creates one table and adds functions. No member, photo, message, approval or
-- referral record is changed. Payments stay disabled.
begin;

do $preflight$
begin
  if to_regclass('public.members') is null
     or to_regprocedure('public.get_member_profile(uuid)') is null
     or to_regprocedure('public.can_read_member_photo(text)') is null then
    raise exception 'Apply supabase/discovery_messaging_safety.sql first; no changes applied';
  end if;
end;
$preflight$;

create table if not exists public.member_photos (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  storage_path text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists member_photos_member_created_idx on public.member_photos(member_id, created_at);

-- Members use this table only through the functions below; the owner console's server-side
-- function (service_role) lists photos and removes inappropriate ones. Permissions are granted
-- explicitly (Supabase stops granting them automatically on new tables from 30 October 2026).
alter table public.member_photos enable row level security;
revoke all on public.member_photos from public, anon, authenticated;
grant select, delete on public.member_photos to service_role;

-- The signed-in member's own profile id (approved or not), or null.
create or replace function public.current_member_id()
returns uuid language sql stable security definer set search_path = ''
as $$
  select m.id from public.members m where m.user_id = auth.uid() and auth.uid() is not null limit 1
$$;
revoke all on function public.current_member_id() from public, anon, authenticated;

-- Adds an uploaded file from the member's own folder to their extra photos (at most 6).
create or replace function public.add_member_photo(p_storage_path text)
returns uuid language plpgsql volatile security definer set search_path = ''
as $$
declare
  me uuid := public.current_member_id();
  new_id uuid;
begin
  if me is null then
    raise exception 'Save your profile before adding photos' using errcode = '42501';
  end if;
  if p_storage_path is null
     or p_storage_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$'
     or (storage.foldername(p_storage_path))[1] is distinct from auth.uid()::text
     or not exists (select 1 from storage.objects o where o.bucket_id = 'profile-photos' and o.name = p_storage_path) then
    raise exception 'Photos must be uploaded to your own private folder first' using errcode = '42501';
  end if;
  perform 1 from public.members m where m.id = me for update; -- one add at a time per member
  if exists (select 1 from public.members m where m.id = me and m.profile_photo_url = p_storage_path) then
    raise exception 'This photo is already your main profile photo' using errcode = '23505';
  end if;
  if (select count(*) from public.member_photos mp where mp.member_id = me) >= 6 then
    raise exception 'You can add up to 6 extra photos. Remove one to add another.' using errcode = '54000';
  end if;
  insert into public.member_photos (member_id, storage_path) values (me, p_storage_path)
  returning id into new_id;
  return new_id;
end;
$$;

-- Removes one of the member's own extra photos and returns its file path, so the page can
-- delete the file from the member's own folder.
create or replace function public.remove_member_photo(p_photo_id uuid)
returns text language plpgsql volatile security definer set search_path = ''
as $$
declare
  me uuid := public.current_member_id();
  removed text;
begin
  if me is null then
    raise exception 'Sign in to manage your photos' using errcode = '42501';
  end if;
  delete from public.member_photos mp where mp.id = p_photo_id and mp.member_id = me
  returning mp.storage_path into removed;
  return removed;
end;
$$;

create or replace function public.list_my_photos()
returns table (id uuid, storage_path text, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select mp.id, mp.storage_path, mp.created_at
  from public.member_photos mp
  where mp.member_id = public.current_member_id()
  order by mp.created_at, mp.id
$$;

-- Another member's extra photos, only when that profile may be opened (same rules as the
-- profile itself: approved viewer, approved adult profile, not blocked, same audience).
create or replace function public.get_member_photos(p_member_id uuid)
returns table (id uuid, storage_path text)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.get_member_profile(p_member_id)) then
    return;
  end if;
  return query
  select mp.id, mp.storage_path
  from public.member_photos mp
  join public.members m on m.id = mp.member_id
  where mp.member_id = p_member_id
    and (storage.foldername(mp.storage_path))[1] = m.user_id::text
  order by mp.created_at, mp.id;
end;
$$;

do $grants$
declare fn text;
begin
  foreach fn in array array[
    'public.add_member_photo(text)', 'public.remove_member_photo(uuid)',
    'public.list_my_photos()', 'public.get_member_photos(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$grants$;

-- Photo files: the existing rule (main photo of an approved profile, or your own) plus your
-- own private folder and the extra photos of approved adult profiles.
create or replace function public.can_read_member_photo(object_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select (storage.foldername(object_name))[1] = auth.uid()::text
    or exists (
      select 1
      from public.members m
      where m.profile_photo_url = object_name
        and m.user_id is not null
        and (
          m.user_id = auth.uid()
          or (m.approved = true and m.age >= 18 and public.current_approved_member_id() is not null)
        )
    )
    or exists (
      select 1
      from public.member_photos mp
      join public.members m on m.id = mp.member_id
      where mp.storage_path = object_name
        and m.user_id is not null
        and m.approved = true and m.age >= 18
        and public.current_approved_member_id() is not null
    )
$$;
revoke all on function public.can_read_member_photo(text) from public, anon;
grant execute on function public.can_read_member_photo(text) to authenticated;

commit;
