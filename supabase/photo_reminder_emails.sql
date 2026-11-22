-- "Add your photo" reminder emails (November 2026).
-- Apply after unread_message_emails.sql (it reuses the Brevo key, the email-state table and the
-- one-tap unsubscribe link). Additive and safe to rerun; no member row is changed.
--
-- Once a day (08:40 UTC = 10:40 in Botswana) it emails approved members who still have no
-- profile photo and joined at least a day ago: "Naledi, add your photo to get more replies 📸",
-- with a button straight to the photo upload. Each member gets at most 2 of these, at least
-- 5 days apart, and none after uploading a photo. Unsubscribed members, unconfirmed emails,
-- test accounts and the official account are skipped. At most 150 a day (Brevo free: 300/day,
-- shared with the unread-message emails).
-- To switch it off:  select cron.unschedule('pk-photo-reminder-emails');
begin;

do $preflight$
begin
  if to_regclass('public.unread_email_state') is null
     or to_regprocedure('public.send_unread_message_emails()') is null then
    raise exception 'Apply supabase/unread_message_emails.sql first; no changes applied';
  end if;
end;
$preflight$;

alter table public.unread_email_state add column if not exists photo_reminders_sent integer not null default 0;
alter table public.unread_email_state add column if not exists last_photo_reminder_at timestamptz;

create or replace function public.send_photo_reminder_emails()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  api_key text;
  r record;
  member_token uuid;
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
    select m.id as mid, m.first_name, u.email, coalesce(st.photo_reminders_sent, 0) as sent_before
    from public.members m
    join auth.users u on u.id = m.user_id
    left join public.unread_email_state st on st.member_id = m.id
    where m.approved = true
      and m.is_official = false
      and coalesce(m.is_test_account, false) = false
      and nullif(trim(coalesce(m.profile_photo_url, '')), '') is null
      and m.created_at < now() - interval '1 day'
      and u.email is not null
      and u.email_confirmed_at is not null
      and coalesce(st.unsubscribed, false) = false
      and coalesce(st.photo_reminders_sent, 0) < 2
      and (st.last_photo_reminder_at is null or st.last_photo_reminder_at < now() - interval '5 days')
    order by m.created_at desc
    limit 150
  loop
    begin
      insert into public.unread_email_state (member_id) values (r.mid) on conflict (member_id) do nothing;
      select st.token into member_token from public.unread_email_state st where st.member_id = r.mid;
      greeting := coalesce(nullif(trim(r.first_name), ''), 'there');
      unsubscribe_url := 'https://pkconnectonline.com/unsubscribe.html?t=' || member_token::text;

      html :=
        '<div style="margin:0;padding:24px 12px;background:#fff8fb;font-family:Arial,Helvetica,sans-serif;color:#241b23">'
        || '<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:20px;padding:28px 24px;border:1px solid #f0dfe7">'
        || '<p style="margin:0 0 4px;font-size:22px;font-weight:900">P.K <span style="color:#b32663">CONNECT</span> ❤️</p>'
        || '<p style="margin:0 0 22px;font-size:12px;font-weight:700;color:#75666e">Find Your Person</p>'
        || '<p style="margin:0 0 12px;font-size:17px">Hi ' || public.pk_html_escape(greeting) || ',</p>'
        || '<p style="margin:0 0 14px;font-size:17px;line-height:1.5">Your P.K Connect profile <b>doesn''t have a photo yet</b>, '
        || 'so other members can''t see who you are. 📸</p>'
        || '<p style="margin:0 0 20px;font-size:16px;line-height:1.5;color:#3d3039">Profiles with a clear, friendly photo '
        || 'are <b>shown first</b> on Discover and get <b>many more messages and replies</b>. It takes less than a minute.</p>'
        || '<p style="margin:0 0 24px;text-align:center"><a href="https://pkconnectonline.com/dashboard.html#photo-title" '
        || 'style="display:inline-block;padding:14px 28px;border-radius:999px;background:#b32663;color:#ffffff;'
        || 'font-weight:800;font-size:16px;text-decoration:none">📸 Add my photo</a></p>'
        || '<p style="margin:0 0 8px;font-size:13px;color:#75666e;line-height:1.5">🔒 Your photos are private: only approved, '
        || 'signed-in members can see them.</p>'
        || '<p style="margin:0;font-size:12px;color:#9a8a93;line-height:1.5">Don''t want reminder emails? '
        || '<a href="' || unsubscribe_url || '" style="color:#9a8a93">Unsubscribe</a>.</p>'
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
          'subject', regexp_replace(greeting, '[\r\n]+', ' ', 'g') || ', add your photo to get more replies 📸',
          'htmlContent', html,
          'textContent', 'Hi ' || greeting || ', your P.K Connect profile has no photo yet. Profiles with a photo are '
                  || 'shown first and get many more replies. Add yours: https://pkconnectonline.com/dashboard.html#photo-title'
                  || E'\n\nUnsubscribe: ' || unsubscribe_url,
          'headers', jsonb_build_object('List-Unsubscribe', '<' || unsubscribe_url || '>'),
          'tags', jsonb_build_array('photo-reminder')
        )
      );

      update public.unread_email_state
         set photo_reminders_sent = photo_reminders_sent + 1, last_photo_reminder_at = now()
       where member_id = r.mid;
      queued := queued + 1;
    exception when others then
      raise warning 'Photo reminder email skipped: %', sqlerrm;
    end;
  end loop;
  return queued;
end;
$$;
revoke all on function public.send_photo_reminder_emails() from public, anon, authenticated;

-- Once a day at 08:40 UTC (10:40 in Botswana). Rerunning this file just updates the same job.
select cron.schedule('pk-photo-reminder-emails', '40 8 * * *', 'select public.send_photo_reminder_emails()');

commit;
