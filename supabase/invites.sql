-- Invite-a-friend links. Additive and safe to rerun: two new columns, two member functions.
-- Each member gets a short private code (pkconnectonline.com/?invite=CODE). When someone opens
-- that link and joins, their profile remembers who invited them (once, within 7 days of joining,
-- never themselves). Members only ever see their own code and how many friends joined.
-- Run once in the Supabase SQL Editor.
begin;

alter table public.members add column if not exists invite_code text;
alter table public.members add column if not exists invited_by uuid references public.members(id) on delete set null;

update public.members
set invite_code = lower(substr(md5(id::text || clock_timestamp()::text), 1, 8))
where invite_code is null;

alter table public.members alter column invite_code set default lower(substr(md5(gen_random_uuid()::text), 1, 8));
create unique index if not exists members_invite_code_key on public.members(invite_code);
create index if not exists members_invited_by_idx on public.members(invited_by);

-- Members can never set or change these themselves; only the functions below do.
revoke update (invite_code, invited_by) on public.members from public, anon, authenticated;

create or replace function public.my_invite()
returns table (invite_code text, friends_joined integer)
language sql stable security definer set search_path = ''
as $$
  select m.invite_code,
         (select count(*)::integer from public.members f where f.invited_by = m.id)
  from public.members m
  where m.user_id = auth.uid()
  limit 1;
$$;

create or replace function public.claim_invite(p_code text)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  me public.members%rowtype;
  inviter uuid;
begin
  select * into me from public.members where user_id = auth.uid() limit 1;
  if me.id is null or me.invited_by is not null or me.created_at < now() - interval '7 days' then
    return false;
  end if;
  select id into inviter from public.members
  where invite_code = lower(trim(coalesce(p_code, ''))) and id <> me.id
  limit 1;
  if inviter is null then
    return false;
  end if;
  update public.members set invited_by = inviter where id = me.id and invited_by is null;
  return true;
end;
$$;

revoke all on function public.my_invite() from public, anon;
revoke all on function public.claim_invite(text) from public, anon;
grant execute on function public.my_invite() to authenticated;
grant execute on function public.claim_invite(text) to authenticated;

commit;
