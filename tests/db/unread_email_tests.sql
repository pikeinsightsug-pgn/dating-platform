-- Behavioural tests for supabase/unread_message_emails.sql (synthetic data only).
\set ON_ERROR_STOP 1
\set QUIET 1
update member_messages set read_at = now() where read_at is null;  -- isolate from earlier tests
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
 ('11111111-0000-4000-8000-0000000000a1', 'mail-sender@test.invalid', now(), '{"profile_type":"member_registration","first_name":"<b>Naledi</b>","age":27,"gender":"Woman","location":"Botswana","city":"Gaborone","relationship_goal":"Marriage","bio":"x"}'),
 ('11111111-0000-4000-8000-0000000000a2', 'mail-reader@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Moses","age":33,"gender":"Man","location":"Botswana","city":"Gaborone","relationship_goal":"Marriage","bio":"x"}'),
 ('11111111-0000-4000-8000-0000000000a3', 'mail-fresh@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Fresh","age":30,"gender":"Man","location":"Uganda","city":"Gulu","relationship_goal":"Marriage","bio":"x"}');
update members set approved = true where user_id in ('11111111-0000-4000-8000-0000000000a1','11111111-0000-4000-8000-0000000000a2','11111111-0000-4000-8000-0000000000a3');
\set s_id `echo "(select id from members where user_id = '11111111-0000-4000-8000-0000000000a1')"`
\set r_id `echo "(select id from members where user_id = '11111111-0000-4000-8000-0000000000a2')"`
\set f_id `echo "(select id from members where user_id = '11111111-0000-4000-8000-0000000000a3')"`
insert into member_messages (sender_member_id, recipient_member_id, body, created_at) values
 (:s_id, :r_id, 'SECRET-MESSAGE-TEXT', now() - interval '2 hours'),
 (:s_id, :f_id, 'too new', now() - interval '10 minutes');

select t_assert(send_unread_message_emails() = 0 and not exists (select 1 from net.sent), 'nothing is sent before the Brevo key is stored');
insert into vault.decrypted_secrets values ('brevo_api_key', 'test-key');
select t_assert(send_unread_message_emails() = 1, 'one email for the message unread over an hour; none for the 10-minute-old one');
select t_assert((select body->'to'->0->>'email' from net.sent order by id desc limit 1) = 'mail-reader@test.invalid', 'sent to the recipient''s email');
select t_assert((select headers->>'api-key' from net.sent order by id desc limit 1) = 'test-key', 'uses the stored key');
select t_assert((select body::text not like '%SECRET-MESSAGE-TEXT%' from net.sent order by id desc limit 1), 'message text is never in the email');
select t_assert((select body::text not like '%Naledi%' from net.sent order by id desc limit 1), 'sender names are never in the email');
select t_assert((select body->>'subject' = 'You have 1 unread message on P.K Connect 💌' from net.sent order by id desc limit 1), 'subject uses the real unread count');
select t_assert((select body->>'htmlContent' like '%Hi Moses 💕%' and body->>'htmlContent' like '%Someone took the time to reach out to you.%'
  and body->>'htmlContent' like '%Read your messages now%' and body->>'htmlContent' like '%Pike – Founder, P.K Connect%' from net.sent order by id desc limit 1), 'email uses the founder''s text');
select t_assert((select body->>'textContent' like '%Tip: Tap "Allow" for message alerts%' from net.sent order by id desc limit 1), 'plain-text version has the same text');
select t_assert((select body->>'htmlContent' like '%unsubscribe.html?t=%' from net.sent order by id desc limit 1), 'email has an unsubscribe link');
select t_assert((select count(*) = 1 and min(unread_count) = 1 from unread_nudge_log where kind = 'email' and member_id = :r_id), 'the email is counted as a nudge');
select t_assert(send_unread_message_emails() = 0, 'no second email straight away');
-- A new message 21 hours later still waits: at most one email a day.
update unread_email_state set last_emailed_at = now() - interval '21 hours';
insert into member_messages (sender_member_id, recipient_member_id, body, created_at) values (:s_id, :r_id, 'still today', now() - interval '90 minutes');
select t_assert(send_unread_message_emails() = 0, 'no second email within 24 hours, even for a new message');
update member_messages set read_at = now() where body = 'still today';
-- A day later: the same old unread message must not be emailed about again.
update unread_email_state set last_emailed_at = now() - interval '25 hours';
update member_messages set created_at = created_at - interval '25 hours' where recipient_member_id = :r_id;
select t_assert(send_unread_message_emails() = 0, 'no repeat email for messages already emailed about');
insert into member_messages (sender_member_id, recipient_member_id, body, created_at) values (:s_id, :r_id, 'again', now() - interval '90 minutes');
select t_assert(send_unread_message_emails() = 1, 'a newer unread message after 24 hours sends again');
select t_assert((select body->>'subject' = 'You have 2 unread messages on P.K Connect 💌' from net.sent order by id desc limit 1), 'the count includes every unread message, not only the new one');
select t_assert((select last_emailed_at = date_trunc('hour', now()) from unread_email_state where member_id = :r_id), 'send time is kept to the hour so tomorrow''s hourly run is not skipped');
update member_messages set read_at = now() where recipient_member_id = :r_id;
update unread_email_state set last_emailed_at = now() - interval '25 hours';
insert into member_messages (sender_member_id, recipient_member_id, body, created_at) values (:s_id, :r_id, 'read one', now() - interval '2 hours');
update member_messages set read_at = now() where body = 'read one';
select t_assert(send_unread_message_emails() = 0, 'read messages never trigger an email');

-- Daily limit (Brevo free plan, shared with photo reminders) and women first when it binds.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
 ('11111111-0000-4000-8000-0000000000a4', 'mail-woman@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Thandi","age":29,"gender":"Woman","location":"Botswana","city":"Gaborone","relationship_goal":"Marriage","bio":"x"}');
update members set approved = true where user_id = '11111111-0000-4000-8000-0000000000a4';
\set w_id `echo "(select id from members where user_id = '11111111-0000-4000-8000-0000000000a4')"`
insert into member_messages (sender_member_id, recipient_member_id, body, created_at) values
 (:r_id, :w_id, 'hi Thandi', now() - interval '2 hours'),
 (:s_id, :r_id, 'hi Moses', now() - interval '3 hours');
insert into unread_nudge_log (member_id, kind, sent_at) select :s_id, 'email', now() - interval '2 hours' from generate_series(1, 140);
select t_assert(send_unread_message_emails() = 0, 'nothing more once 140 emails went out in 24 hours');
delete from unread_nudge_log where id in (select id from unread_nudge_log where member_id = :s_id order by id
  limit (select count(*) - 139 from unread_nudge_log where kind = 'email' and sent_at > now() - interval '24 hours'));
select t_assert(send_unread_message_emails() = 1, 'the last email of the day is used');
select t_assert((select body->'to'->0->>'email' from net.sent order by id desc limit 1) = 'mail-woman@test.invalid', 'women are emailed first when the limit is reached');
delete from unread_nudge_log where member_id = :s_id;
update member_messages set read_at = now() where recipient_member_id in (:r_id, :w_id);
update unread_email_state set last_emailed_at = now() - interval '25 hours';

-- Login banner nudges: recorded at most once a day, only with real unread messages.
begin; select set_config('request.jwt.claim.sub', '11111111-0000-4000-8000-0000000000a2', true); set local role authenticated;
select t_assert(record_unread_banner() = false, 'no banner nudge without unread messages');
commit;
insert into member_messages (sender_member_id, recipient_member_id, body) values (:s_id, :r_id, 'banner time');
begin; select set_config('request.jwt.claim.sub', '11111111-0000-4000-8000-0000000000a2', true); set local role authenticated;
select t_assert(record_unread_banner() = true, 'the banner shown after login is counted as a nudge');
select t_assert(record_unread_banner() = false, 'only once a day');
select t_denied('select * from public.unread_nudge_log', 'members cannot read the nudge log');
commit;
select t_assert((select count(*) = 1 and min(unread_count) = 1 from unread_nudge_log where kind = 'banner' and member_id = :r_id), 'banner nudge stores the unread count');
set role service_role;
select t_assert((select count(*) >= 3 from public.unread_nudge_log), 'the owner function can read the nudge log');
reset role;
update member_messages set read_at = now() where recipient_member_id = :r_id;
update members set is_official = true where id = :r_id;
insert into member_messages (sender_member_id, recipient_member_id, body, created_at) values (:s_id, :r_id, 'to official', now() - interval '2 hours');
select t_assert(send_unread_message_emails() = 0, 'the official account is never emailed');
update members set is_official = false where id = :r_id;

select set_config('t.tok', (select token::text from unread_email_state where member_id = :r_id), false);
set role anon;
select t_denied('select public.send_unread_message_emails()', 'visitors cannot trigger the sender');
select t_denied('select * from public.unread_email_state', 'visitors cannot read tokens or email state');
select t_assert(unsubscribe_unread_emails(gen_random_uuid()) = false, 'a made-up token unsubscribes nobody');
select t_assert(unsubscribe_unread_emails(current_setting('t.tok')::uuid) = true, 'the email link unsubscribes without signing in');
reset role;
select t_assert(send_unread_message_emails() = 0, 'unsubscribed members get no more emails');
select t_assert((select count(*) = 1 from cron.job where jobname = 'pk-unread-message-emails' and schedule = '20 * * * *'), 'one hourly job, even after rerunning the file');
