-- Behavioural tests for supabase/photo_reminder_emails.sql (synthetic data only).
\set ON_ERROR_STOP 1
\set QUIET 1
delete from net.sent;
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
 ('22222222-0000-4000-8000-0000000000b1', 'nophoto-old@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Thato","age":29,"gender":"Woman","location":"Botswana","city":"Maun","relationship_goal":"Marriage","bio":"x"}'),
 ('22222222-0000-4000-8000-0000000000b2', 'nophoto-new@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Newbie","age":29,"gender":"Man","location":"Botswana","city":"Maun","relationship_goal":"Marriage","bio":"x"}'),
 ('22222222-0000-4000-8000-0000000000b3', 'hasphoto@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Photo","age":29,"gender":"Man","location":"Botswana","city":"Maun","relationship_goal":"Marriage","bio":"x"}');
update members set approved = true, profile_photo_url = null
 where user_id in ('22222222-0000-4000-8000-0000000000b1','22222222-0000-4000-8000-0000000000b2','22222222-0000-4000-8000-0000000000b3');
-- Photo paths are normally checked against the signed-in member; skip that check for test setup.
set session_replication_role = replica;
update members set profile_photo_url = user_id::text || '/existing.jpg' where profile_photo_url is null and user_id is not null
  and user_id::text not like '22222222-%';  -- isolate from earlier tests
update members set created_at = now() - interval '3 days'
 where user_id in ('22222222-0000-4000-8000-0000000000b1','22222222-0000-4000-8000-0000000000b3');
update members set profile_photo_url = user_id::text || '/photo.jpg' where user_id = '22222222-0000-4000-8000-0000000000b3';
\set old_id `echo "(select id from members where user_id = '22222222-0000-4000-8000-0000000000b1')"`

select t_assert(send_photo_reminder_emails() = 1, 'one reminder: only the member without a photo who joined over a day ago');
select t_assert((select body->'to'->0->>'email' from net.sent order by id desc limit 1) = 'nophoto-old@test.invalid', 'sent to that member');
select t_assert((select body->>'htmlContent' like '%dashboard.html#photo-title%' and body->>'htmlContent' like '%unsubscribe.html?t=%' from net.sent order by id desc limit 1), 'email links to photo upload and unsubscribe');
select t_assert(send_photo_reminder_emails() = 0, 'no second reminder within 5 days');
update unread_email_state set last_photo_reminder_at = now() - interval '6 days' where member_id = :old_id;
select t_assert(send_photo_reminder_emails() = 1, 'second reminder after 5 days');
update unread_email_state set last_photo_reminder_at = now() - interval '6 days' where member_id = :old_id;
select t_assert(send_photo_reminder_emails() = 0, 'never more than 2 reminders');
update unread_email_state set photo_reminders_sent = 0, last_photo_reminder_at = null where member_id = :old_id;
update members set profile_photo_url = user_id::text || '/now.jpg' where id = :old_id;
select t_assert(send_photo_reminder_emails() = 0, 'no reminder once a photo is uploaded');
update members set profile_photo_url = null where id = :old_id;
update unread_email_state set unsubscribed = true where member_id = :old_id;
select t_assert(send_photo_reminder_emails() = 0, 'unsubscribed members get no photo reminders');
set role anon;
select t_denied('select public.send_photo_reminder_emails()', 'visitors cannot trigger photo reminders');
reset role;
select t_assert((select count(*) = 1 from cron.job where jobname = 'pk-photo-reminder-emails' and schedule = '40 8 * * *'), 'one daily photo-reminder job, even after rerunning the file');
