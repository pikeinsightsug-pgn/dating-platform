-- Phone pop-up notifications for new messages (OneSignal web push).
-- Additive and safe to rerun: no table, column or member row is changed. Sending a message
-- never fails because of a notification: any problem is logged as a warning and skipped.
--
-- One-time setup, in the Supabase SQL Editor:
--   1. Store the OneSignal REST API key in Supabase Vault (never in this repository):
--        select vault.create_secret('PASTE-ONESIGNAL-REST-API-KEY', 'onesignal_rest_api_key');
--      Then close that query tab without saving it.
--      To replace the key later:
--        select vault.update_secret(id, 'NEW-KEY') from vault.secrets where name = 'onesignal_rest_api_key';
--   2. Run this file.
--
-- What it does:
--   * After a message is saved, asks OneSignal to show "<Name> sent you a message 💬" on the
--     recipient's phone. Tapping it opens that conversation on messages.html.
--   * The message text itself is never sent to OneSignal (privacy).
--   * At most one pop-up per conversation every 10 minutes, so a fast chat is not noisy.
--   * Members who never tapped "Allow" simply get nothing; the website's unread badge still works.
-- To switch it off:  drop trigger if exists notify_new_message_push on public.member_messages;
begin;

create extension if not exists pg_net with schema extensions;

create or replace function public.notify_new_message_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rest_key text;
  sender_name text;
begin
  begin
    select ds.decrypted_secret into rest_key
    from vault.decrypted_secrets ds
    where ds.name = 'onesignal_rest_api_key'
    limit 1;
    if rest_key is null then
      return new;
    end if;

    if exists (
      select 1 from public.member_messages mm
      where mm.sender_member_id = new.sender_member_id
        and mm.recipient_member_id = new.recipient_member_id
        and mm.id <> new.id
        and mm.created_at > new.created_at - interval '10 minutes'
    ) then
      return new;
    end if;

    select coalesce(nullif(trim(m.first_name), ''), 'Someone') into sender_name
    from public.members m
    where m.id = new.sender_member_id;

    perform net.http_post(
      url := 'https://api.onesignal.com/notifications?c=push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Key ' || rest_key
      ),
      body := jsonb_build_object(
        'app_id', '8e44de4a-0ae7-4a62-b9fb-099b24a6b81c',
        'target_channel', 'push',
        'include_aliases', jsonb_build_object('external_id', jsonb_build_array(new.recipient_member_id::text)),
        'headings', jsonb_build_object('en', 'P.K Connect'),
        'contents', jsonb_build_object('en', coalesce(sender_name, 'Someone') || ' sent you a message 💬'),
        'url', 'https://pkconnectonline.com/messages.html?member=' || new.sender_member_id::text,
        'web_push_topic', 'pk-msg-' || new.sender_member_id::text
      )
    );
  exception when others then
    raise warning 'Message notification skipped: %', sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.notify_new_message_push() from public, anon, authenticated;

drop trigger if exists notify_new_message_push on public.member_messages;
create trigger notify_new_message_push
after insert on public.member_messages
for each row execute function public.notify_new_message_push();

commit;
