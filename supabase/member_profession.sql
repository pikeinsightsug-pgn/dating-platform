-- Profession: members can say what they do (optional, up to 80 characters). It is shown to
-- approved members on profiles in Discover, like city and relationship goal.
-- Apply after discovery_messaging_safety.sql. Additive and safe to rerun: adds one optional
-- column and one read function; copies professions people already gave when signing up.
-- No member, photo, message, approval or referral record is otherwise changed.
begin;

do $preflight$
begin
  if to_regclass('public.members') is null
     or to_regprocedure('public.get_member_profile(uuid)') is null then
    raise exception 'Apply supabase/discovery_messaging_safety.sql first; no changes applied';
  end if;
end;
$preflight$;

alter table public.members add column if not exists profession text;
do $constraint$
begin
  if not exists (select 1 from pg_constraint where conname = 'members_profession_length') then
    alter table public.members add constraint members_profession_length
      check (profession is null or length(profession) <= 80) not valid;
  end if;
end;
$constraint$;

-- Members may edit their own profession (row access is still limited by RLS to their own row).
grant update (profession) on public.members to authenticated;

-- Professions given on the join form before this file was applied are kept in the person's
-- own signup answers; copy them onto profiles that do not have one yet.
update public.members m
set profession = left(trim(u.raw_user_meta_data->>'profession'), 80)
from auth.users u
where u.id = m.user_id
  and m.profession is null
  and nullif(trim(coalesce(u.raw_user_meta_data->>'profession', '')), '') is not null;

-- Professions for the profiles a member is allowed to open (same rules as get_member_profile:
-- approved viewer, approved adult profile, not blocked, same audience).
create or replace function public.member_professions(p_member_ids uuid[])
returns table (id uuid, profession text)
language plpgsql stable security definer set search_path = ''
as $$
declare member_id uuid;
begin
  if public.current_approved_member_id() is null then
    return;
  end if;
  foreach member_id in array coalesce(p_member_ids[1:50], array[]::uuid[]) loop
    if exists (select 1 from public.get_member_profile(member_id)) then
      return query
        select m.id, m.profession from public.members m
        where m.id = member_id and nullif(trim(coalesce(m.profession, '')), '') is not null;
    end if;
  end loop;
end;
$$;
revoke all on function public.member_professions(uuid[]) from public, anon;
grant execute on function public.member_professions(uuid[]) to authenticated;

commit;
