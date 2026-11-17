-- Founding-member counter for the homepage and sign-up page ("Only 25 of 100 free founding
-- spots left"). Additive and safe to rerun. It returns one number and nothing else: no names,
-- no rows, no member details. Test accounts and the official founder account do not count.
-- Run once in the Supabase SQL Editor. To hide the counter: drop function public.founding_spots_left();
create or replace function public.founding_spots_left()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(0, 100 - count(*))::integer
  from public.members m
  where coalesce(m.is_test_account, false) = false
    and coalesce(m.is_official, false) = false;
$$;

revoke all on function public.founding_spots_left() from public;
grant execute on function public.founding_spots_left() to anon, authenticated;
