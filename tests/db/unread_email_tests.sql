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

select t_assert(send_unread_message_emails() = 0 and not exists (select 1 from net.sent), 'nothing is sent before the Resend key is stored');
insert into vault.decrypted_secrets values ('resend_api_key', 'test-key');
select t_assert(send_unread_message_emails() = 1, 'one email for the message unread over an hour; none for the 10-minute-old one');
select t_assert((select body->'to'->>0 from net.sent order by id desc limit 1) = 'mail-reader@test.invalid', 'sent to the recipient''s email');
select t_assert((select headers->>'Authorization' from net.sent order by id desc limit 1) = 'Bearer test-key', 'uses the stored key');
select t_assert((select body::text not like '%SECRET-MESSAGE-TEXT%' from net.sent order by id desc limit 1), 'message text is never in the email');
select t_assert((select body->>'html' like '%&lt;b&gt;Naledi&lt;/b&gt;%' and body->>'html' not like '%<b><b>Naledi%' from net.sent order by id desc limit 1), 'sender names are HTML-escaped');
select t_assert((select body->>'html' like '%unsubscribe.html?t=%' from net.sent order by id desc limit 1), 'email has an unsubscribe link');
select t_assert(send_unread_message_emails() = 0, 'no second email within 20 hours');
-- A day later: the same old unread message must not be emailed about again.
update unread_email_state set last_emailed_at = now() - interval '21 hours';
update member_messages set created_at = created_at - interval '21 hours' where recipient_member_id = :r_id;
select t_assert(send_unread_message_emails() = 0, 'no repeat email for messages already emailed about');
insert into member_messages (sender_member_id, recipient_member_id, body, created_at) values (:s_id, :r_id, 'again', now() - interval '90 minutes');
select t_assert(send_unread_message_emails() = 1, 'a newer unread message after 20 hours sends again');
update member_messages set read_at = now() where recipient_member_id = :r_id;
update unread_email_state set last_emailed_at = now() - interval '21 hours';
insert into member_messages (sender_member_id, recipient_member_id, body, created_at) values (:s_id, :r_id, 'read one', now() - interval '2 hours');
update member_messages set read_at = now() where body = 'read one';
select t_assert(send_unread_message_emails() = 0, 'read messages never trigger an email');
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
