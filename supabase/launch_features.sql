-- Additive launch foundation for Find Your Person.
-- Run in Supabase SQL Editor after reviewing the deployment checklist.
-- This does NOT delete existing members, enable payments, or approve anyone automatically.

begin;

alter table public.members
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists interests text,
  add column if not exists partner_preference text,
  add column if not exists approved boolean not null default false;

create unique index if not exists members_user_id_unique
  on public.members(user_id) where user_id is not null;
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

alter table public.members enable row level security;
alter table public.member_messages enable row level security;

-- SECURITY DEFINER helpers avoid recursive RLS checks and prevent client-side
-- queries from needing broad SELECT access to the underlying members table.
create or replace function public.current_approved_member_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select m.id
  from public.members m
  where m.user_id = auth.uid() and m.approved = true and m.age >= 18
  limit 1
$$;

create or replace function public.is_approved_member_profile(profile_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
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

-- This safe projection deliberately excludes user_id and any contact details.
-- The view owner reads the underlying table; clients receive only these columns.
create or replace view public.approved_member_profiles
with (security_barrier = true)
as
select id, first_name, age, gender, location, relationship_goal, bio,
       interests, partner_preference, profile_photo_url, created_at
from public.members
where approved = true and age >= 18;

revoke all on public.approved_member_profiles from public, anon, authenticated;
grant select on public.approved_member_profiles to authenticated;
revoke all on public.members from anon, authenticated;

-- Keep public registration inserts possible under the existing validation policy.
grant insert on public.members to anon, authenticated;

drop policy if exists "approved members can view approved profiles" on public.members;
drop policy if exists "approved members can send messages" on public.member_messages;
drop policy if exists "participants can read their messages" on public.member_messages;
drop policy if exists "recipients can mark messages read" on public.member_messages;

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

-- No client-side update/delete policy: message contents cannot be edited after sending.
-- No client-side policy can approve members or change user_id.
-- Existing records remain unapproved until reviewed and linked through a trusted owner-only process.

commit();
