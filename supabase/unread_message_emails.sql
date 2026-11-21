-- "You have an unread message" reminder emails (November 2026).
-- Apply after push_notifications.sql and smart_discovery.sql. Additive and safe to rerun: no
-- member row or message is changed, and nothing is sent until the Brevo key is stored.
--
-- Sends through Brevo (brevo.com), where pkconnectonline.com is already authenticated.
-- One-time setup (see supabase/ADMIN_APPROVAL_SETUP.md, "Unread-message emails"):
--   1. In Brevo, check Senders, Domains & Dedicated IPs: pkconnectonline.com is authenticated
--      and noreply@pkconnectonline.com is listed as a sender (add it if not).
--   2. In Brevo, SMTP & API -> API keys -> Generate a new API key, and store it in Supabase
--      Vault, never here:
--        select vault.create_secret('PASTE-BREVO-API-KEY', 'brevo_api_key');
--      Then close that query tab without saving it.
--   3. Run this file in the Supabase SQL Editor.
--
-- What it does, once an hour:
--   * Finds approved members who have a message that has stayed unread for over an hour
--     (and is less than 7 days old), and emails them "Naledi sent you a message 💬" with a
--     button to messages.html. The message text itself is never put in the email (privacy).
--   * At most one email per member every 20 hours, only for messages newer than the last
--     email, and at most 80 emails an hour (Brevo's free plan allows 300 a day).
--   * Every email has a one-tap unsubscribe link (unsubscribe.html). Unsubscribed members,
--     unconfirmed email addresses, blocked senders and the official account are skipped.
--   * Any sending problem is logged as a warning and skipped; messaging is never affected.
-- To switch it off:  select cron.unschedule('pk-unread-message-emails');
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
  names text;
  subject text;
  greeting text;
  unsubscribe_url text;
  html text;
  queued integer := 0;
begin
  select ds.decrypted_secret into api_key
  from vault.decrypted_secrets ds where ds.name = 'brevo_api_key' limit 1;
  if api_key is null then
    return 0;
  end if;

  for r in
    with pending as (
      select mm.recipient_member_id as rid,
             count(*) as unread,
             min(mm.created_at) as first_at,
             array_agg(distinct coalesce(nullif(trim(s.first_name), ''), 'Someone')) as senders
      from public.member_messages mm
      join public.members s on s.id = mm.sender_member_id
      left join public.unread_email_state st on st.member_id = mm.recipient_member_id
      where mm.read_at is null
        and mm.created_at < now() - interval '1 hour'
        and mm.created_at > now() - interval '7 days'
        and mm.created_at > coalesce(st.last_emailed_at, '-infinity'::timestamptz)
        and s.approved = true
        and not public.members_are_blocked(mm.recipient_member_id, mm.sender_member_id)
      group by mm.recipient_member_id
    )
    select p.rid, p.unread, p.senders, m.first_name, u.email
    from pending p
    join public.members m on m.id = p.rid
    join auth.users u on u.id = m.user_id
    left join public.unread_email_state st on st.member_id = p.rid
    where m.approved = true
      and m.is_official = false
      and u.email is not null
      and u.email_confirmed_at is not null
      and coalesce(st.unsubscribed, false) = false
      and (st.last_emailed_at is null or st.last_emailed_at < now() - interval '20 hours')
    order by p.first_at
    limit 80
  loop
    begin
      insert into public.unread_email_state (member_id) values (r.rid) on conflict (member_id) do nothing;
      select st.token into member_token from public.unread_email_state st where st.member_id = r.rid;

      names := array_to_string(r.senders[1:3], ', ');
      if cardinality(r.senders) > 3 then names := names || ' and others'; end if;
      subject := case
        when cardinality(r.senders) = 1 and r.unread = 1 then r.senders[1] || ' sent you a message 💬'
        when cardinality(r.senders) = 1 then r.senders[1] || ' sent you ' || r.unread || ' messages 💬'
        else 'You have ' || r.unread || ' unread messages on P.K Connect 💬'
      end;
      subject := regexp_replace(subject, '[\r\n]+', ' ', 'g');
      greeting := coalesce(nullif(trim(r.first_name), ''), 'there');
      unsubscribe_url := 'https://pkconnectonline.com/unsubscribe.html?t=' || member_token::text;

      html :=
        '<div style="margin:0;padding:24px 12px;background:#fff8fb;font-family:Arial,Helvetica,sans-serif;color:#241b23">'
        || '<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:20px;padding:28px 24px;border:1px solid #f0dfe7">'
        || '<p style="margin:0 0 4px;font-size:22px;font-weight:900">P.K <span style="color:#b32663">CONNECT</span> ❤️</p>'
        || '<p style="margin:0 0 22px;font-size:12px;font-weight:700;color:#75666e">Find Your Person</p>'
        || '<p style="margin:0 0 12px;font-size:17px">Hi ' || public.pk_html_escape(greeting) || ',</p>'
        || '<p style="margin:0 0 20px;font-size:17px;line-height:1.5">You have <b>' || r.unread
        || ' unread message' || case when r.unread = 1 then '' else 's' end || '</b> from <b>'
        || public.pk_html_escape(names) || '</b>. Don''t keep them waiting!</p>'
        || '<p style="margin:0 0 24px;text-align:center"><a href="https://pkconnectonline.com/messages.html" '
        || 'style="display:inline-block;padding:14px 28px;border-radius:999px;background:#b32663;color:#ffffff;'
        || 'font-weight:800;font-size:16px;text-decoration:none">💬 Read your messages</a></p>'
        || '<p style="margin:0 0 8px;font-size:13px;color:#75666e;line-height:1.5">Tip: tap <b>Allow</b> when the website asks, '
        || 'and you will get a phone alert the moment someone messages you.</p>'
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
          'sender', jsonb_build_object('name', 'P.K Connect', 'email', 'noreply@pkconnectonline.com'),
          'to', jsonb_build_array(jsonb_build_object('email', r.email)),
          'replyTo', jsonb_build_object('email', 'pikeinsightsug@gmail.com'),
          'subject', subject,
          'htmlContent', html,
          'textContent', 'Hi ' || greeting || ', you have ' || r.unread || ' unread message(s) from ' || names
                  || ' on P.K Connect. Read them: https://pkconnectonline.com/messages.html'
                  || E'\n\nUnsubscribe: ' || unsubscribe_url,
          'headers', jsonb_build_object(
            'List-Unsubscribe', '<' || unsubscribe_url || '>'),
          'tags', jsonb_build_array('unread-message')
        )
      );

      update public.unread_email_state set last_emailed_at = now() where member_id = r.rid;
      queued := queued + 1;
    exception when others then
      raise warning 'Unread-message email skipped: %', sqlerrm;
    end;
  end loop;
  return queued;
end;
$$;
revoke all on function public.send_unread_message_emails() from public, anon, authenticated;

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
