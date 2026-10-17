-- Secure launch foundation for Find Your Person.
-- Additive only: preserves existing member records and does not enable payments.
-- Review before running in Supabase SQL Editor. This installs database structures only;
-- a separate authenticated sign-in/profile-linking flow is still required in index.html.

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

-- Resolve the signed-in user's approved adult member record.
create or replace function public.current_approved_member_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select m.id
  from public.members m
  where m.user_id = auth.uid()
    and m.approved = true
    and m.age >= 18
  limit 1
$$;

create or replace function public.is_approved_member_profile(profile_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.members m
    where m.id = profile_id and m.approved = true and m.age >= 18
  )
$$;

revoke all on function public.current_approved_member_id() from public, anon;
revoke all on function public.is_approved_member_profile(uuid) from public, anon;
grant execute on function public.current_approved_member_id() to authenticated;
grant execute on function public.is_approved_member_profile(uuid) to authenticated;

-- Do not grant broad SELECT access to members or a view that bypasses member approval.
-- Approved adult members can browse a safe projection only through this gated function.
create or replace function public.browse_approved_profiles()
returns table (
  id uuid,
  first_name text,
  age integer,
  gender text,
  location text,
  relationship_goal text,
  bio text,
  interests text,
  partner_preference text,
  created_at timestamptz
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if public.current_approved_member_id() is null then
    raise exception 'Only approved adult members can browse profiles';
  end if;

  return query
  select m.id, m.first_name, m.age, m.gender, m.location,
         m.relationship_goal, m.bio, m.interests, m.partner_preference, m.created_at
  from public.members m
  where m.approved = true
    and m.age >= 18
    and m.id <> public.current_approved_member_id()
  order by m.created_at desc;
end;
$$;

revoke all on function public.browse_approved_profiles() from public, anon;
grant execute on function public.browse_approved_profiles() to authenticated;

revoke all on public.members from anon, authenticated;
grant insert on public.members to anon, authenticated;

-- Preserve registration-only insert policy; enforce unapproved status on public submissions.
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
);

-- Messaging is limited to approved adult members and approved adult recipients.
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

-- No client policy permits approving members, changing user_id, or deleting messages.
-- Photo object paths are deliberately excluded from profile browsing; photos stay private.
-- This migration does not create accounts, link existing registrations to accounts,
-- approve existing members, or activate payments.

commit();
