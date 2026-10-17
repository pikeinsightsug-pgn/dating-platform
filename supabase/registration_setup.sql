-- Safe additive setup for the expanded registration form.
-- This does not delete or overwrite existing member records.
alter table public.members
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists location text,
  add column if not exists relationship_goal text,
  add column if not exists bio text,
  add column if not exists interests text,
  add column if not exists partner_preference text,
  add column if not exists profile_photo_url text,
  add column if not exists approved boolean not null default false;

-- Keep one account linked to at most one member profile.
create unique index if not exists members_user_id_unique
  on public.members(user_id) where user_id is not null;

-- Keep uploaded photos private. The website uploads to this exact bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-photos', 'profile-photos', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = false,
    file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

-- The unauthenticated signup form may create a member registration only.
alter table public.members enable row level security;
drop policy if exists "public can register members" on public.members;
create policy "public can register members"
on public.members for insert
to anon, authenticated
with check (
  age >= 18
  and age <= 120
  and first_name is not null
  and length(trim(first_name)) > 0
  and approved = false
  and ((auth.uid() is null and user_id is null) or user_id = auth.uid())
);

grant insert on table public.members to anon, authenticated;

-- Restrict anonymous uploads to the dedicated private photo bucket.
drop policy if exists "public can upload registration photos" on storage.objects;
create policy "public can upload registration photos"
on storage.objects for insert
to anon, authenticated
with check (bucket_id = 'profile-photos');

-- No public SELECT or DELETE policy is created for member photos.
