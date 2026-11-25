-- "You have unread messages" reminder emails and the unread-nudge log (November 2026).
-- Apply after push_notifications.sql and smart_discovery.sql. Additive and safe to rerun: no
-- member row or message is changed, and nothing is sent until the Brevo key is stored.
-- Rerunning this file is also how the newer email text, limits and nudge counts are switched on;
-- it replaces the earlier version of the same email instead of adding a second one.
--
-- Sends through Brevo (brevo.com), where pkconnectonline.com is already authenticated, never
-- through Supabase's own email (that is kept for sign-up and password emails only).
-- One-time setup (see supabase/ADMIN_APPROVAL_SETUP.md, "Unread-message emails"):
--   1. In Brevo, check Senders, Domains & Dedicated IPs: pkconnectonline.com is authenticated
--      and no-reply@pkconnectonline.com is listed as a sender (add it if not).
--   2. In Brevo, SMTP & API -> API keys -> Generate a new API key, and store it in Supabase
--      Vault, never here:
--        select vault.create_secret('PASTE-BREVO-API-KEY', 'brevo_api_key');
--      Then close that query tab without saving it.
--   3. Run this file in the Supabase SQL Editor.
--
-- What it does, once an hour:
--   * Finds approved members who have a message that has stayed unread for over an hour
--     (and is less than 7 days old), and emails them "You have 3 unread messages on
--     P.K Connect 💌" with their real unread count and a button to messages.html. Message
--     text and sender names are never put in the email (privacy).
--   * At most one email per member per day (24 hours), only when a message arrived since the
--     last email, at most 80 an hour and at most 140 in any 24 hours. Brevo's free plan allows
--     300 a day, shared with the photo reminders (at most 150 a day), so the two together stay
--     under it. When the limit is reached, women are emailed first.
--   * Every email has a one-tap unsubscribe link (unsubscribe.html). Unsubscribed members,
--     unconfirmed email addresses, banned members, blocked senders and the official account
--     are skipped.
--   * Every email, and the first "You have unread messages" banner a member sees each day
--     after logging in, is written to unread_nudge_log (who, when, how many unread) so the
--     owner console can show how many nudges went out and how many members replied after.
--   * Any sending problem is logged as a warning and skipped; messaging is never affected.
-- To switch it off:  select cron.unschedule('pk-unread-message-emails');
begin;

do $preflight$
begin
  if to_regclass('public.member_messages') is null
     or to_regprocedure('public.members_are_blocked(uuid, uuid)') is null
     or to_regprocedure('public.require_approved_member()') is null
     or not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'members' and column_name = 'is_official') then
    raise exception 'Apply the earlier checked-in setup files first; no changes applied';
  end if;
end;
$preflight$;

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- Who was emailed when, and each member's private unsubscribe token.
create table if not exists public.unread_email_state (
  member_id uuid primary key references public.members(id) on delete cascade,
  token uuid not null unique default gen_random_uuid(),
  last_emailed_at timestamptz,
  unsubscribed boolean not null default false,
  unsubscribed_at timestamptz
);
alter table public.unread_email_state enable row level security;
revoke all on public.unread_email_state from public, anon, authenticated;

-- One row per unread nudge: an email, or the login banner (at most one banner row a day).
-- Holds no message text, names or email addresses. Only the owner function reads it.
create table if not exists public.unread_nudge_log (
  id bigserial primary key,
  member_id uuid not null references public.members(id) on delete cascade,
  kind text not null check (kind in ('email', 'banner')),
  unread_count integer not null default 0,
  sent_at timestamptz not null default now()
);
create index if not exists unread_nudge_log_sent_idx on public.unread_nudge_log (sent_at);
create index if not exists unread_nudge_log_member_idx on public.unread_nudge_log (member_id, kind, sent_at desc);
alter table public.unread_nudge_log enable row level security;
revoke all on public.unread_nudge_log from public, anon, authenticated;
grant select on public.unread_nudge_log to service_role;

create or replace function public.pk_html_escape(p_text text)
returns text language sql immutable set search_path = ''
as $$
  select replace(replace(replace(replace(replace(coalesce(p_text, ''),
    '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;')
$$;
revoke all on function public.pk_html_escape(text) from public, anon, authenticated;

create or replace function public.send_unread_message_emails()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  api_key text;
  r record;
  member_token uuid;
  subject text;
  greeting text;
  messages_word text;
  unsubscribe_url text;
  html text;
  budget integer;
  queued integer := 0;
begin
  select ds.decrypted_secret into api_key
  from vault.decrypted_secrets ds where ds.name = 'brevo_api_key' limit 1;
  if api_key is null then
    return 0;
  end if;

  -- Daily budget: at most 140 of these in any 24 hours (photo reminders use up to 150 more).
  select 140 - count(*) into budget
  from public.unread_nudge_log l
  where l.kind = 'email' and l.sent_at > now() - interval '24 hours';
  budget := least(80, budget);
  if budget <= 0 then
    return 0;
  end if;

  for r in
    with unread as (
      select mm.recipient_member_id as rid, mm.created_at
      from public.member_messages mm
      join public.members s on s.id = mm.sender_member_id
      where mm.read_at is null
        and s.approved = true
        and not public.members_are_blocked(mm.recipient_member_id, mm.sender_member_id)
    ), pending as (
      -- unread = the member's real unread count; a message newer than the last email that has
      -- waited over an hour (and is under 7 days old) is what makes an email due.
      select u.rid,
             count(*) as unread,
             min(u.created_at) filter (where u.created_at < now() - interval '1 hour'
                                          and u.created_at > now() - interval '7 days'
                                          and u.created_at > coalesce(st.last_emailed_at, '-infinity'::timestamptz)) as first_at
      from unread u
      left join public.unread_email_state st on st.member_id = u.rid
      group by u.rid
    )
    select p.rid, p.unread, m.first_name, u.email
    from pending p
    join public.members m on m.id = p.rid
    join auth.users u on u.id = m.user_id
    left join public.unread_email_state st on st.member_id = p.rid
    where p.first_at is not null
      and m.approved = true
      and m.is_official = false
      and coalesce((to_jsonb(m) ->> 'banned')::boolean, false) = false
      and u.email is not null
      and u.email_confirmed_at is not null
      and coalesce(st.unsubscribed, false) = false
      and (st.last_emailed_at is null or st.last_emailed_at <= now() - interval '24 hours')
    order by (lower(trim(coalesce(m.gender, ''))) in ('woman', 'women', 'female')) desc, p.first_at
    limit budget
  loop
    begin
      insert into public.unread_email_state (member_id) values (r.rid) on conflict (member_id) do nothing;
      select st.token into member_token from public.unread_email_state st where st.member_id = r.rid;

      messages_word := case when r.unread = 1 then 'message' else 'messages' end;
      subject := 'You have ' || r.unread || ' unread ' || messages_word || ' on P.K Connect 💌';
      greeting := regexp_replace(coalesce(nullif(trim(r.first_name), ''), 'there'), '[\r\n]+', ' ', 'g');
      unsubscribe_url := 'https://pkconnectonline.com/unsubscribe.html?t=' || member_token::text;

      html :=
        '<div style="margin:0;padding:24px 12px;background:#fff8fb;font-family:Arial,Helvetica,sans-serif;color:#241b23">'
        || '<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:20px;padding:28px 24px;border:1px solid #f0dfe7">'
        || '<p style="margin:0 0 4px;font-size:22px;font-weight:900">P.K <span style="color:#b32663">CONNECT</span> ❤️</p>'
        || '<p style="margin:0 0 22px;font-size:12px;font-weight:700;color:#75666e">Find Your Person</p>'
        || '<p style="margin:0 0 12px;font-size:17px">Hi ' || public.pk_html_escape(greeting) || ' 💕</p>'
        || '<p style="margin:0 0 14px;font-size:17px;line-height:1.5">You have <b>' || r.unread || ' unread ' || messages_word
        || '</b> waiting for you on P.K Connect!</p>'
        || '<p style="margin:0 0 22px;font-size:16px;line-height:1.5;color:#3d3039">Someone took the time to reach out to you. '
        || 'Why not take a look and say hello? A simple reply could be the start of something special. ✨</p>'
        || '<p style="margin:0 0 24px;text-align:center"><a href="https://pkconnectonline.com/messages.html" '
        || 'style="display:inline-block;padding:14px 28px;border-radius:999px;background:#b32663;color:#ffffff;'
        || 'font-weight:800;font-size:16px;text-decoration:none">👉 Read your messages now</a></p>'
        || '<p style="margin:0 0 18px;font-size:13px;color:#75666e;line-height:1.5">Tip: Tap <b>"Allow"</b> for message alerts '
        || 'so you''ll know the moment someone writes to you.</p>'
        || '<p style="margin:0 0 18px;font-size:15px;line-height:1.5">With love,<br><b>Pike – Founder, P.K Connect</b></p>'
        || '<p style="margin:0;font-size:12px;color:#9a8a93;line-height:1.5">For your safety, never send money to anyone you meet online. '
        || 'Don''t want these emails? <a href="' || unsubscribe_url || '" style="color:#9a8a93">Unsubscribe</a>.</p>'
        || '</div></div>';

      perform net.http_post(
        url := 'https://api.brevo.com/v3/smtp/email',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Accept', 'application/json',
          'api-key', api_key
        ),
        body := jsonb_build_object(
          'sender', jsonb_build_object('name', 'P.K Connect', 'email', 'no-reply@pkconnectonline.com'),
          'to', jsonb_build_array(jsonb_build_object('email', r.email)),
          'replyTo', jsonb_build_object('email', 'pikeinsightsug@gmail.com'),
          'subject', subject,
          'htmlContent', html,
          'textContent', 'Hi ' || greeting || ' 💕' || E'\n'
                  || 'You have ' || r.unread || ' unread ' || messages_word || ' waiting for you on P.K Connect!' || E'\n'
                  || 'Someone took the time to reach out to you. Why not take a look and say hello? '
                  || 'A simple reply could be the start of something special. ✨' || E'\n'
                  || '👉 Read your messages now: https://pkconnectonline.com/messages.html' || E'\n'
                  || 'Tip: Tap "Allow" for message alerts so you''ll know the moment someone writes to you.' || E'\n'
                  || 'With love,' || E'\n' || 'Pike – Founder, P.K Connect'
                  || E'\n\nUnsubscribe: ' || unsubscribe_url,
          'headers', jsonb_build_object(
            'List-Unsubscribe', '<' || unsubscribe_url || '>'),
          'tags', jsonb_build_array('unread-message')
        )
      );

      -- Rounded down to the hour so the hourly job can send again exactly a day later.
      update public.unread_email_state set last_emailed_at = date_trunc('hour', now()) where member_id = r.rid;
      insert into public.unread_nudge_log (member_id, kind, unread_count) values (r.rid, 'email', r.unread);
      queued := queued + 1;
    exception when others then
      raise warning 'Unread-message email skipped: %', sqlerrm;
    end;
  end loop;
  return queued;
end;
$$;
revoke all on function public.send_unread_message_emails() from public, anon, authenticated;

-- Called by the website when it shows a signed-in member the "You have unread messages"
-- banner. Records at most one banner nudge per member a day, and only when they really have
-- unread messages. Returns whether a row was written. Never blocks the page.
create or replace function public.record_unread_banner()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := public.require_approved_member();
  unread integer;
begin
  if exists (select 1 from public.unread_nudge_log l
             where l.member_id = me and l.kind = 'banner' and l.sent_at > now() - interval '20 hours') then
    return false;
  end if;
  select count(*) into unread
  from public.member_messages mm
  join public.members s on s.id = mm.sender_member_id
  where mm.recipient_member_id = me
    and mm.read_at is null
    and s.approved = true
    and not public.members_are_blocked(me, mm.sender_member_id);
  if unread = 0 then
    return false;
  end if;
  insert into public.unread_nudge_log (member_id, kind, unread_count) values (me, 'banner', unread);
  return true;
end;
$$;
revoke all on function public.record_unread_banner() from public, anon;
grant execute on function public.record_unread_banner() to authenticated;

-- One-tap unsubscribe from the link in the email. Needs only the private token.
create or replace function public.unsubscribe_unread_emails(p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  found_member uuid;
begin
  update public.unread_email_state
     set unsubscribed = true, unsubscribed_at = coalesce(unsubscribed_at, now())
   where token = p_token
  returning member_id into found_member;
  return found_member is not null;
end;
$$;
revoke all on function public.unsubscribe_unread_emails(uuid) from public;
grant execute on function public.unsubscribe_unread_emails(uuid) to anon, authenticated;

-- Every hour at 20 minutes past. Rerunning this file just updates the same job.
select cron.schedule('pk-unread-message-emails', '20 * * * *', 'select public.send_unread_message_emails()');

commit;
