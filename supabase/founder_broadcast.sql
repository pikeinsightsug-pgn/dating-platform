-- Founder message to every member (November 2026).
-- Apply after official_account.sql. Additive and safe to rerun; sends nothing by itself.
--
-- Lets the owner send one private message from the official "Pike – Founder" account to every
-- approved member, from the Supabase SQL Editor only (members and visitors cannot call it):
--
--   select public.send_founder_broadcast('install-app-nov-2026',
--     'Hi {first_name} 👋 ... [INSTALL-APP]');
--
--   * {first_name} is replaced with each member's first name.
--   * [INSTALL-APP] shows as an "📲 Install P.K CONNECT" button in Messages (only in messages
--     from the official account).
--   * The first word is a name for this broadcast. Running it again with the same name only
--     reaches members who did not get it yet (for example people who joined since), so nobody
--     receives the same broadcast twice.
--   * Skips the official account itself, test accounts, members waiting for approval and
--     anyone who blocked the official account (or was blocked by it).
--   * Each message triggers the usual phone alert, and unread ones the usual email reminder.
-- Returns how many members were messaged.
begin;

do $preflight$
begin
  if to_regclass('public.member_messages') is null
     or to_regprocedure('public.members_are_blocked(uuid, uuid)') is null
     or not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'members' and column_name = 'is_official') then
    raise exception 'Apply the earlier checked-in setup files first; no changes applied';
  end if;
end;
$preflight$;

create table if not exists public.founder_broadcasts (
  broadcast_key text not null,
  member_id uuid not null references public.members(id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (broadcast_key, member_id)
);
alter table public.founder_broadcasts enable row level security;
revoke all on public.founder_broadcasts from public, anon, authenticated;

create or replace function public.send_founder_broadcast(p_key text, p_body text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  founder uuid;
  r record;
  sent integer := 0;
begin
  if nullif(trim(coalesce(p_key, '')), '') is null then
    raise exception 'Give this broadcast a short name, for example ''install-app-nov-2026''' using errcode = '22023';
  end if;
  if length(coalesce(p_body, '')) not between 1 and 2000 then
    raise exception 'The message must be between 1 and 2000 characters' using errcode = '22023';
  end if;
  select m.id into founder from public.members m
  where m.is_official = true and m.approved = true
  order by m.created_at limit 1;
  if founder is null then
    raise exception 'No approved official account found; mark the founder account as official first' using errcode = 'P0002';
  end if;

  for r in
    select m.id, coalesce(nullif(trim(split_part(m.first_name, ' ', 1)), ''), 'there') as first
    from public.members m
    where m.approved = true and m.is_official = false and m.user_id is not null
      and coalesce(m.is_test_account, false) = false
      and not public.members_are_blocked(founder, m.id)
      and not exists (select 1 from public.founder_broadcasts b
                      where b.broadcast_key = p_key and b.member_id = m.id)
    order by m.created_at
  loop
    insert into public.member_messages (sender_member_id, recipient_member_id, body)
    values (founder, r.id, left(replace(p_body, '{first_name}', r.first), 2000));
    insert into public.founder_broadcasts (broadcast_key, member_id) values (p_key, r.id);
    sent := sent + 1;
  end loop;
  return sent;
end;
$$;
revoke all on function public.send_founder_broadcast(text, text) from public, anon, authenticated;

commit;
