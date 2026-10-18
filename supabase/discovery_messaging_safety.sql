-- Filtered member discovery, profile details, private messaging, blocking and reporting.
-- Apply after registration_setup.sql, launch_features_secure.sql and member_discovery_photos.sql.
-- Additive only: no table, column or member row is dropped, deleted, approved or overwritten.
-- Payments, paid messaging and referral commissions are not introduced.
begin;

do $preflight$
begin
  if to_regclass('public.members') is null or to_regclass('public.member_messages') is null
     or to_regprocedure('public.current_approved_member_id()') is null
     or to_regprocedure('public.can_read_member_photo(text)') is null then
    raise exception 'Apply the earlier checked-in setup files first; no changes applied';
  end if;
end;
$preflight$;

-- A malformed signup must never block Auth from creating or confirming the account.
-- Invalid metadata now skips profile creation (the member sees the recovery guidance)
-- instead of raising and failing the whole Auth request.
create or replace function public.create_member_profile_from_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $member_profile_trigger$
declare
  profile jsonb := new.raw_user_meta_data;
  profile_age integer;
  profile_first_name text;
  profile_gender text;
  profile_location text;
  profile_city text;
  profile_goal text;
  profile_bio text;
  profile_interests text;
  profile_preference text;
begin
  if new.email_confirmed_at is null
     or coalesce(profile->>'profile_type', '') <> 'member_registration'
     or not (profile ? 'first_name') then
    return new;
  end if;

  if coalesce(profile->>'age', '') !~ '^[0-9]{1,3}$' then
    raise warning 'Skipped member profile for auth user %: invalid age', new.id;
    return new;
  end if;
  profile_age := (profile->>'age')::integer;
  profile_first_name := nullif(trim(profile->>'first_name'), '');
  profile_gender := profile->>'gender';
  profile_location := profile->>'location';
  profile_city := nullif(trim(profile->>'city'), '');
  profile_goal := profile->>'relationship_goal';
  profile_bio := nullif(trim(profile->>'bio'), '');
  profile_interests := nullif(trim(coalesce(profile->>'interests', '')), '');
  profile_preference := nullif(trim(coalesce(profile->>'partner_preference', '')), '');

  if profile_age < 18 or profile_age > 120
     or profile_first_name is null or length(profile_first_name) > 80
     or profile_gender is null or profile_gender not in ('Woman', 'Man', 'Non-binary', 'Prefer not to say')
     or profile_location is null or profile_location not in ('Uganda', 'Botswana')
     or profile_city is null or length(profile_city) > 100
     or profile_goal is null or profile_goal not in ('Serious relationship', 'Marriage', 'Friendship', 'Exploring connections')
     or profile_bio is null or length(profile_bio) > 500
     or (profile_interests is not null and length(profile_interests) > 300)
     or (profile_preference is not null and length(profile_preference) > 500) then
    raise warning 'Skipped member profile for auth user %: invalid registration fields', new.id;
    return new;
  end if;

  insert into public.members (
    user_id, first_name, age, gender, location, city,
    relationship_goal, bio, interests, partner_preference, approved
  ) values (
    new.id, profile_first_name, profile_age, profile_gender, profile_location, profile_city,
    profile_goal, profile_bio, profile_interests, profile_preference, false
  )
  on conflict (user_id) where user_id is not null do nothing;

  return new;
end;
$member_profile_trigger$;
revoke all on function public.create_member_profile_from_auth_user() from public, anon, authenticated;

create index if not exists members_discovery_idx
  on public.members(approved, location, age, created_at desc);
create index if not exists member_messages_pair_created_idx
  on public.member_messages(sender_member_id, recipient_member_id, created_at desc);
create index if not exists member_messages_unread_idx
  on public.member_messages(recipient_member_id) where read_at is null;

create table if not exists public.member_blocks (
  blocker_member_id uuid not null references public.members(id) on delete cascade,
  blocked_member_id uuid not null references public.members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_member_id, blocked_member_id),
  constraint member_blocks_no_self_block check (blocker_member_id <> blocked_member_id)
);
create index if not exists member_blocks_blocked_idx on public.member_blocks(blocked_member_id);

create table if not exists public.member_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_member_id uuid not null references public.members(id) on delete cascade,
  reported_member_id uuid not null references public.members(id) on delete cascade,
  reason text not null check (reason in ('Fake profile', 'Under 18', 'Harassment', 'Scam or payment request', 'Inappropriate content', 'Other')),
  details text check (details is null or length(details) <= 1000),
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now(),
  constraint member_reports_no_self_report check (reporter_member_id <> reported_member_id)
);
create index if not exists member_reports_status_idx on public.member_reports(status, created_at desc);

-- Members interact with these tables only through the functions below.
alter table public.member_blocks enable row level security;
alter table public.member_reports enable row level security;
revoke all on public.member_blocks, public.member_reports from public, anon, authenticated;
-- Messages are written only through send_member_message, which enforces blocks and rate limits.
revoke insert, update, delete on public.member_messages from public, anon, authenticated;

create or replace function public.members_are_blocked(member_a uuid, member_b uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.member_blocks b
    where (b.blocker_member_id = member_a and b.blocked_member_id = member_b)
       or (b.blocker_member_id = member_b and b.blocked_member_id = member_a)
  )
$$;
revoke all on function public.members_are_blocked(uuid, uuid) from public, anon, authenticated;

create or replace function public.require_approved_member()
returns uuid language plpgsql stable security definer set search_path = ''
as $$
declare me uuid := public.current_approved_member_id();
begin
  if me is null then
    raise exception 'Only approved adult members can use member features' using errcode = '42501';
  end if;
  return me;
end;
$$;
revoke all on function public.require_approved_member() from public, anon, authenticated;

-- Only fields intended for approved members. No user_id, email, phone, partner
-- preferences or approval data is returned.
create or replace function public.browse_member_profiles(
  p_country text default null,
  p_min_age integer default 18,
  p_max_age integer default 120,
  p_relationship_goal text default null,
  p_gender text default null,
  p_limit integer default 24,
  p_offset integer default 0
)
returns table (
  id uuid, first_name text, age integer, gender text, location text, city text,
  relationship_goal text, bio text, interests text, profile_photo_path text,
  created_at timestamptz, total_count bigint
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me uuid := public.require_approved_member();
  min_age integer := greatest(18, coalesce(p_min_age, 18));
  max_age integer := least(120, coalesce(p_max_age, 120));
  page_size integer := least(50, greatest(1, coalesce(p_limit, 24)));
  page_offset integer := greatest(0, coalesce(p_offset, 0));
begin
  return query
  select m.id, m.first_name, m.age, m.gender, m.location, m.city,
         m.relationship_goal, m.bio, m.interests,
         case
           when m.profile_photo_url is not null
            and (storage.foldername(m.profile_photo_url))[1] = m.user_id::text
           then m.profile_photo_url
         end,
         m.created_at,
         count(*) over ()
  from public.members m
  where m.approved = true and m.age >= 18 and m.user_id is not null
    and m.id <> me
    and m.age between min_age and max_age
    and (nullif(p_country, '') is null or m.location = p_country)
    and (nullif(p_relationship_goal, '') is null or m.relationship_goal = p_relationship_goal)
    and (nullif(p_gender, '') is null or m.gender = p_gender)
    and not public.members_are_blocked(me, m.id)
  order by m.created_at desc, m.id
  limit page_size offset page_offset;
end;
$$;

create or replace function public.get_member_profile(p_member_id uuid)
returns table (
  id uuid, first_name text, age integer, gender text, location text, city text,
  relationship_goal text, bio text, interests text, profile_photo_path text,
  created_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
declare me uuid := public.require_approved_member();
begin
  return query
  select m.id, m.first_name, m.age, m.gender, m.location, m.city,
         m.relationship_goal, m.bio, m.interests,
         case
           when m.profile_photo_url is not null
            and (storage.foldername(m.profile_photo_url))[1] = m.user_id::text
           then m.profile_photo_url
         end,
         m.created_at
  from public.members m
  where m.id = p_member_id and m.id <> me
    and m.approved = true and m.age >= 18 and m.user_id is not null
    and not public.members_are_blocked(me, m.id);
end;
$$;

create or replace function public.send_member_message(p_recipient_member_id uuid, p_body text)
returns table (id uuid, created_at timestamptz)
language plpgsql volatile security definer set search_path = ''
as $$
declare
  me uuid := public.require_approved_member();
  clean_body text := trim(coalesce(p_body, ''));
begin
  if p_recipient_member_id is null or p_recipient_member_id = me
     or not public.is_approved_member_profile(p_recipient_member_id) then
    raise exception 'This member cannot receive messages' using errcode = '42501';
  end if;
  if public.members_are_blocked(me, p_recipient_member_id) then
    raise exception 'This member cannot receive messages' using errcode = '42501';
  end if;
  if length(clean_body) < 1 or length(clean_body) > 2000 then
    raise exception 'Messages must be between 1 and 2000 characters' using errcode = '22023';
  end if;
  if (select count(*) from public.member_messages mm
      where mm.sender_member_id = me and mm.created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'You are sending messages too quickly. Please wait a few minutes.' using errcode = '54000';
  end if;
  return query
  insert into public.member_messages (sender_member_id, recipient_member_id, body)
  values (me, p_recipient_member_id, clean_body)
  returning member_messages.id, member_messages.created_at;
end;
$$;

create or replace function public.list_my_conversations()
returns table (
  other_member_id uuid, first_name text, age integer, location text,
  profile_photo_path text, last_body text, last_at timestamptz,
  last_from_me boolean, unread_count bigint
)
language plpgsql stable security definer set search_path = ''
as $$
declare me uuid := public.require_approved_member();
begin
  return query
  with mine as (
    select case when mm.sender_member_id = me then mm.recipient_member_id else mm.sender_member_id end as other_id,
           mm.body, mm.created_at, mm.sender_member_id = me as from_me,
           (mm.recipient_member_id = me and mm.read_at is null) as unread
    from public.member_messages mm
    where mm.sender_member_id = me or mm.recipient_member_id = me
  ), latest as (
    select distinct on (other_id) other_id, body, created_at, from_me
    from mine order by other_id, created_at desc
  )
  select l.other_id, m.first_name, m.age, m.location,
         case
           when m.profile_photo_url is not null
            and (storage.foldername(m.profile_photo_url))[1] = m.user_id::text
           then m.profile_photo_url
         end,
         l.body, l.created_at, l.from_me,
         (select count(*) from mine u where u.other_id = l.other_id and u.unread)
  from latest l
  join public.members m on m.id = l.other_id
  where m.approved = true and not public.members_are_blocked(me, l.other_id)
  order by l.created_at desc;
end;
$$;

create or replace function public.get_conversation(p_other_member_id uuid, p_limit integer default 200)
returns table (id uuid, from_me boolean, body text, created_at timestamptz, read_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
declare me uuid := public.require_approved_member();
begin
  return query
  select * from (
    select mm.id, mm.sender_member_id = me, mm.body, mm.created_at, mm.read_at
    from public.member_messages mm
    where (mm.sender_member_id = me and mm.recipient_member_id = p_other_member_id)
       or (mm.sender_member_id = p_other_member_id and mm.recipient_member_id = me)
    order by mm.created_at desc
    limit least(500, greatest(1, coalesce(p_limit, 200)))
  ) recent
  order by recent.created_at;
end;
$$;

create or replace function public.mark_conversation_read(p_other_member_id uuid)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  me uuid := public.require_approved_member();
  changed integer;
begin
  update public.member_messages mm set read_at = now()
  where mm.recipient_member_id = me and mm.sender_member_id = p_other_member_id and mm.read_at is null;
  get diagnostics changed = row_count;
  return changed;
end;
$$;

create or replace function public.block_member(p_member_id uuid)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare me uuid := public.require_approved_member();
begin
  if p_member_id is null or p_member_id = me
     or not exists (select 1 from public.members m where m.id = p_member_id) then
    raise exception 'Member not found' using errcode = '22023';
  end if;
  insert into public.member_blocks (blocker_member_id, blocked_member_id)
  values (me, p_member_id) on conflict do nothing;
end;
$$;

create or replace function public.unblock_member(p_member_id uuid)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare me uuid := public.require_approved_member();
begin
  delete from public.member_blocks
  where blocker_member_id = me and blocked_member_id = p_member_id;
end;
$$;

create or replace function public.report_member(p_member_id uuid, p_reason text, p_details text default null)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  me uuid := public.require_approved_member();
  report_id uuid;
begin
  if p_member_id is null or p_member_id = me
     or not exists (select 1 from public.members m where m.id = p_member_id) then
    raise exception 'Member not found' using errcode = '22023';
  end if;
  if (select count(*) from public.member_reports r
      where r.reporter_member_id = me and r.created_at > now() - interval '1 day') >= 20 then
    raise exception 'Too many reports today. Please contact support.' using errcode = '54000';
  end if;
  insert into public.member_reports (reporter_member_id, reported_member_id, reason, details)
  values (me, p_member_id, p_reason, nullif(trim(coalesce(p_details, '')), ''))
  returning id into report_id;
  return report_id;
end;
$$;

do $grants$
declare fn text;
begin
  foreach fn in array array[
    'public.browse_member_profiles(text, integer, integer, text, text, integer, integer)',
    'public.get_member_profile(uuid)',
    'public.send_member_message(uuid, text)',
    'public.list_my_conversations()',
    'public.get_conversation(uuid, integer)',
    'public.mark_conversation_read(uuid)',
    'public.block_member(uuid)',
    'public.unblock_member(uuid)',
    'public.report_member(uuid, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$grants$;

commit;
