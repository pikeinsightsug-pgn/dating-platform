-- Scam protection and safety (November 2026). Apply after likes_and_matches.sql.
-- This file replaces send_member_message: rerun it after rerunning official_account.sql or
-- discovery_messaging_safety.sql.
-- Additive and safe to rerun. No message text is ever shown to the owner: the database only
-- checks each message for warning signs and records counts.
--
--   * Auto-hide: a profile reported by 3 different members is paused (hidden from everyone and
--     unable to message) until the owner reviews it. The official account is never paused.
--   * Contact details: phone numbers, WhatsApp/Telegram and email addresses can be shared only
--     after both people have each sent 5 messages in the chat, or once they have liked each other.
--   * Money words: messages asking for money still arrive (the receiver sees a warning), but a
--     member who sends money words to 2 or more different people within 7 days is flagged for the
--     owner.
--   * Copy-paste spam: the same long message (40+ characters) can go to at most 8 different
--     people a day; the 8th copy flags the member for the owner and further copies are refused.
--   * New accounts (under 24 hours old) can start at most 15 new conversations a day.
--   * Banned members stay hidden; the owner console also blocks their login.
begin;

do $preflight$
begin
  if to_regprocedure('public.require_approved_member()') is null
     or to_regprocedure('public.members_are_blocked(uuid, uuid)') is null
     or to_regclass('public.member_reports') is null
     or to_regclass('public.member_likes') is null
     or not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'members' and column_name = 'is_official') then
    raise exception 'Apply discovery_messaging_safety.sql, official_account.sql and likes_and_matches.sql first; no changes applied';
  end if;
end;
$preflight$;

-- Owner-only markers. Members have no column grant to change them.
alter table public.members add column if not exists safety_hold boolean not null default false;
alter table public.members add column if not exists safety_hold_at timestamptz;
alter table public.members add column if not exists banned boolean not null default false;

-- 'money' when a message contained money words. Never the text itself.
alter table public.member_messages add column if not exists safety_flag text;
create index if not exists member_messages_safety_flag_idx
  on public.member_messages(sender_member_id, created_at desc) where safety_flag is not null;

create table if not exists public.safety_alerts (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  kind text not null check (kind in ('money_words', 'copy_paste')),
  hits integer not null default 1,
  people integer not null default 1,
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists safety_alerts_one_open_idx
  on public.safety_alerts(member_id, kind) where status = 'open';
alter table public.safety_alerts enable row level security;
revoke all on public.safety_alerts from public, anon, authenticated;
grant select, update on public.safety_alerts to service_role;
grant select on public.member_reports to service_role;

-- Warning-sign checks. Kept in step with the same lists in messages.html.
create or replace function public.pk_has_money_words(p_body text)
returns boolean language sql immutable set search_path = ''
as $$
  select lower(coalesce(p_body, '')) ~ (
    '\m(send (me )?(some )?money|send (me )?(some )?cash|western union|moneygram|world ?remit|gift ?cards?|itunes|'
    || 'steam card|bitcoin|btc|crypto|usdt|forex|investment|invest with me|transport (money|fare)|'
    || 'send (me )?airtime|mobile money|momo|ecocash|orange money|myzaka|bank account|account number|'
    || 'customs fee|clearance fee|loan)\M')
$$;

create or replace function public.pk_has_contact_details(p_body text)
returns boolean language plpgsql immutable set search_path = ''
as $$
declare
  b text := lower(coalesce(p_body, ''));
  chunk text;
begin
  if b ~ '(whats ?app|whatsap|watsap|watsapp|wa\.me|telegram|t\.me/)' then return true; end if;
  if b ~ '[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}' then return true; end if;
  -- A phone number: 7 or more digits, allowing spaces, dashes, dots, brackets and a leading +.
  for chunk in select (regexp_matches(b, '\+?[0-9][0-9 ().-]{5,}[0-9]', 'g'))[1] loop
    if length(regexp_replace(chunk, '[^0-9]', '', 'g')) >= 7 then return true; end if;
  end loop;
  return false;
end;
$$;

-- Contact details are allowed once both people have each sent 5 messages, or they liked each other.
create or replace function public.pk_contact_sharing_open(me uuid, other uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.members o where o.id in (me, other) and o.is_official)
      or (exists (select 1 from public.member_likes a where a.liker_id = me and a.liked_id = other)
          and exists (select 1 from public.member_likes b where b.liker_id = other and b.liked_id = me))
      or ((select count(*) from public.member_messages mm
           where mm.sender_member_id = me and mm.recipient_member_id = other) >= 5
          and (select count(*) from public.member_messages mm
               where mm.sender_member_id = other and mm.recipient_member_id = me) >= 5)
$$;

create or replace function public.pk_raise_safety_alert(p_member_id uuid, p_kind text, p_hits integer, p_people integer)
returns void language sql volatile security definer set search_path = ''
as $$
  insert into public.safety_alerts (member_id, kind, hits, people)
  values (p_member_id, p_kind, p_hits, p_people)
  on conflict (member_id, kind) where status = 'open'
  do update set hits = greatest(public.safety_alerts.hits, excluded.hits),
                people = greatest(public.safety_alerts.people, excluded.people),
                updated_at = now()
$$;

do $revoke$
declare fn text;
begin
  foreach fn in array array[
    'public.pk_has_money_words(text)', 'public.pk_has_contact_details(text)',
    'public.pk_contact_sharing_open(uuid, uuid)',
    'public.pk_raise_safety_alert(uuid, text, integer, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
  end loop;
end;
$revoke$;

-- Messaging with every earlier rule (approval, blocks, audience, length, speed limit and the
-- official account's higher limit) plus the safety checks above.
create or replace function public.send_member_message(p_recipient_member_id uuid, p_body text)
returns table (id uuid, created_at timestamptz)
language plpgsql volatile security definer set search_path = ''
as $$
declare
  me uuid := public.require_approved_member();
  clean_body text := trim(coalesce(p_body, ''));
  i_am_official boolean := exists (select 1 from public.members o where o.id = me and o.is_official);
  send_limit integer := case when i_am_official then 300 else 30 end;
  normalized text;
  copies integer;
  flag text;
  people integer;
  hits integer;
begin
  if p_recipient_member_id is null or p_recipient_member_id = me
     or not public.is_approved_member_profile(p_recipient_member_id) then
    raise exception 'This member cannot receive messages' using errcode = '42501';
  end if;
  if public.members_are_blocked(me, p_recipient_member_id)
     or not public.members_share_audience(me, p_recipient_member_id) then
    raise exception 'This member cannot receive messages' using errcode = '42501';
  end if;
  if length(clean_body) < 1 or length(clean_body) > 2000 then
    raise exception 'Messages must be between 1 and 2000 characters' using errcode = '22023';
  end if;
  if (select count(*) from public.member_messages mm
      where mm.sender_member_id = me and mm.created_at > now() - interval '10 minutes') >= send_limit then
    raise exception 'You are sending messages too quickly. Please wait a few minutes.' using errcode = '54000';
  end if;

  if not i_am_official then
    -- Contact details only after the two people know each other a little.
    if public.pk_has_contact_details(clean_body)
       and not public.pk_contact_sharing_open(me, p_recipient_member_id) then
      raise exception 'For your safety, phone numbers, WhatsApp and email can be shared after you have each sent 5 messages, or once you have liked each other.'
        using errcode = '22023';
    end if;

    -- New accounts: at most 15 new conversations in their first day. A conversation counts as
    -- started by me when my first message to that person came before any message from them.
    if exists (select 1 from public.members m where m.id = me and m.created_at > now() - interval '24 hours')
       and not exists (select 1 from public.member_messages mm
                       where (mm.sender_member_id = me and mm.recipient_member_id = p_recipient_member_id)
                          or (mm.sender_member_id = p_recipient_member_id and mm.recipient_member_id = me))
       and (select count(*) from (
              select mm.recipient_member_id as other_id, min(mm.created_at) as first_at
              from public.member_messages mm where mm.sender_member_id = me
              group by mm.recipient_member_id) started
            where not exists (select 1 from public.member_messages theirs
                              where theirs.sender_member_id = started.other_id
                                and theirs.recipient_member_id = me
                                and theirs.created_at < started.first_at)) >= 15 then
      raise exception 'New members can start 15 new conversations on their first day. Please reply to your chats, or try again tomorrow.'
        using errcode = '54000';
    end if;

    -- The same long message pasted to many people: the 8th copy goes through and flags the
    -- member for the owner; later copies are refused.
    normalized := regexp_replace(lower(clean_body), '\s+', ' ', 'g');
    if length(normalized) >= 40 then
      select count(distinct mm.recipient_member_id) into copies
      from public.member_messages mm
      where mm.sender_member_id = me and mm.created_at > now() - interval '24 hours'
        and mm.recipient_member_id <> p_recipient_member_id
        and regexp_replace(lower(mm.body), '\s+', ' ', 'g') = normalized;
      if copies >= 8 then
        raise exception 'Please write a personal message. The same long message cannot be sent to many people.'
          using errcode = '54000';
      elsif copies = 7 then
        perform public.pk_raise_safety_alert(me, 'copy_paste', 8, 8);
      end if;
    end if;

    if public.pk_has_money_words(clean_body) then flag := 'money'; end if;
  end if;

  return query
  insert into public.member_messages (sender_member_id, recipient_member_id, body, safety_flag)
  values (me, p_recipient_member_id, clean_body, flag)
  returning member_messages.id, member_messages.created_at;

  if flag = 'money' then
    select count(distinct mm.recipient_member_id), count(*) into people, hits
    from public.member_messages mm
    where mm.sender_member_id = me and mm.safety_flag = 'money'
      and mm.created_at > now() - interval '7 days';
    if people >= 2 then
      perform public.pk_raise_safety_alert(me, 'money_words', hits, people);
    end if;
  end if;
end;
$$;
revoke all on function public.send_member_message(uuid, text) from public, anon;
grant execute on function public.send_member_message(uuid, text) to authenticated;

-- Auto-hide: 3 different members reporting the same profile (open reports) pause it.
create or replace function public.pause_profile_after_reports()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if (select count(distinct r.reporter_member_id) from public.member_reports r
      where r.reported_member_id = new.reported_member_id and r.status = 'open') >= 3 then
    update public.members m
       set approved = false, safety_hold = true, safety_hold_at = now()
     where m.id = new.reported_member_id and m.approved = true and m.is_official = false;
  end if;
  return null;
end;
$$;
revoke all on function public.pause_profile_after_reports() from public, anon, authenticated;

drop trigger if exists pause_profile_after_reports on public.member_reports;
create trigger pause_profile_after_reports
  after insert on public.member_reports
  for each row execute function public.pause_profile_after_reports();

commit;
