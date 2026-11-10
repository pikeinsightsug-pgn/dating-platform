-- Instant approval: a new member profile is approved the moment it is created, so new members
-- can browse and message straight away instead of waiting for the owner.
--
-- How: after a profile row is inserted, if it belongs to a real, email-confirmed account
-- (user_id set), it is marked approved. Nothing else changes:
--   * the approved column and every approval check stay in place;
--   * members still cannot change their own approval (no column grant), so a member the owner
--     returns to pending (approved = false) stays hidden until the owner approves them again;
--   * this runs only when a profile is first created, never on later updates;
--   * rows with no linked account (old Google Form records), profiles the owner adds for
--     people who have not yet accepted their invitation, and sign-ups using a name reserved for
--     the official account (e.g. "Admin", "Founder") stay pending for the owner to review.
-- Apply after the earlier setup files. Safe to rerun. No existing member row is changed; to also
-- approve members who are already waiting, the owner can do that in the approval console.
-- To go back to manual approval, run:  drop trigger if exists approve_new_member_profile on public.members;
begin;

do $preflight$
begin
  if to_regclass('public.members') is null
     or to_regprocedure('public.create_member_profile_from_auth_user()') is null
     or to_regprocedure('public.is_reserved_member_name(text)') is null then
    raise exception 'Apply the earlier checked-in setup files first; no changes applied';
  end if;
end;
$preflight$;

create or replace function public.approve_new_member_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.user_id is not null and new.approved = false
     and exists (select 1 from auth.users u where u.id = new.user_id and u.email_confirmed_at is not null)
     and not public.is_reserved_member_name(new.first_name) then
    update public.members set approved = true where id = new.id;
  end if;
  return null;
end;
$$;
revoke all on function public.approve_new_member_profile() from public, anon, authenticated;

drop trigger if exists approve_new_member_profile on public.members;
create trigger approve_new_member_profile
  after insert on public.members
  for each row execute function public.approve_new_member_profile();

commit;
