-- Additive launch foundation for Find Your Person.
-- Run in Supabase SQL Editor after reviewing the deployment checklist.
-- This does NOT delete existing members, enable payments, or approve anyone automatically.

begin;

-- Link a member profile to a Supabase Auth account when the member creates one.
alter table public.members
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists interests text,
  add column if not exists partner_preference text,
  add column if not exists approved boolean not null default false;

create unique index if not exists members_user_id_unique
  on public.members(user_id)
  where user_id is not null;

create index if not exists members_approved_location_idx
  on public.members(approved, location);

-- Private member-to-member messages. A message can only be read by its two participants.
create table if not exists public.member_messages (
  id uuid primary key default gen_random_uuid(),
  sender_member_id uuid not null references public.members(id) on delete cascade,
  recipient_member_id uuid not null references public.members(id) on delete cascade,
  body text not null check (length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint member_messages_no_self_message
    check (sender_member_id <> recipient_member_id)
);

create index if not exists member_messages_sender_created_idx
  on public.member_messages(sender_member_id, created_at desc);
create index if not exists member_messages_recipient_created_idx
  on public.member_messages(recipient_member_id, created_at desc);

alter table public.members enable row level security;
alter table public.member_messages enable row level security;

-- Only approved profiles are discoverable to signed-in users.
-- Contact information must never be added to the public profile projection.
drop policy if exists "approved members can view approved profiles" on public.members;
create policy "approved members can view approved profiles"
on public.members for select
to authenticated
using (
  approved = true
  and exists (
    select 1 from public.members me
    where me.user_id = auth.uid()
      and me.approved = true
  )
);

-- Signed-in approved members may send a message only as their own linked profile,
-- and only to another approved member. There is deliberately no public/anon policy.
drop policy if exists "approved members can send messages" on public.member_messages;
create policy "approved members can send messages"
on public.member_messages for insert
to authenticated
with check (
  exists (
    select 1 from public.members sender
    where sender.id = sender_member_id
      and sender.user_id = auth.uid()
      and sender.approved = true
      and sender.age >= 18
  )
  and exists (
    select 1 from public.members recipient
    where recipient.id = recipient_member_id
      and recipient.approved = true
      and recipient.age >= 18
  )
);

drop policy if exists "participants can read their messages" on public.member_messages;
create policy "participants can read their messages"
on public.member_messages for select
to authenticated
using (
  exists (
    select 1 from public.members me
    where me.user_id = auth.uid()
      and me.approved = true
      and me.id in (sender_member_id, recipient_member_id)
  )
);

-- Recipients may mark their own incoming messages as read, without changing message content.
drop policy if exists "recipients can mark messages read" on public.member_messages;
create policy "recipients can mark messages read"
on public.member_messages for update
to authenticated
using (
  exists (
    select 1 from public.members recipient
    where recipient.id = recipient_member_id
      and recipient.user_id = auth.uid()
      and recipient.approved = true
  )
)
with check (
  exists (
    select 1 from public.members recipient
    where recipient.id = recipient_member_id
      and recipient.user_id = auth.uid()
      and recipient.approved = true
  )
);

grant select on public.members to authenticated;
grant select, insert, update on public.member_messages to authenticated;

-- Intentionally no client-side policy can approve a member or change user_id.
-- Perform approvals and account/profile linking through a trusted owner-only process.
-- Existing records remain unapproved until explicitly reviewed by the owner.

commit();
