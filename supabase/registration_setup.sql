-- Safe additive setup for the expanded registration form.
-- This does not delete or overwrite existing member records.
alter table public.members
  add column if not exists location text,
  add column if not exists relationship_goal text,
  add column if not exists bio text,
  add column if not exists interests text,
  add column if not exists partner_preference text,
  add column if not exists photo_path text;

-- Keep uploaded photos private. The website uploads to the existing
-- profile-photos bucket, so the bucket name must match index.html exactly.
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
);

grant insert on table public.members to anon, authenticated;

-- Restrict anonymous uploads to the dedicated private photo bucket.
drop policy if exists "public can upload registration photos" on storage.objects;
create policy "public can upload registration photos"
on storage.objects for insert
to anon, authenticated
with check (bucket_id = 'profile-photos');

-- Permit cleanup of an uploaded photo if the corresponding member insert fails.
drop policy if exists "public can clean up registration photos" on storage.objects;
create policy "public can clean up registration photos"
on storage.objects for delete
to anon, authenticated
using (bucket_id = 'profile-photos');
