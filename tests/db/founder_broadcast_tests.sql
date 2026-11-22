-- Behavioural tests for supabase/founder_broadcast.sql (synthetic data only).
\set ON_ERROR_STOP 1
\set QUIET 1
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
 ('55555555-0000-4000-8000-0000000000e1', 'b-founder@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Founder","age":40,"gender":"Man","location":"Botswana","city":"Gaborone","relationship_goal":"Marriage","bio":"x"}'),
 ('55555555-0000-4000-8000-0000000000e2', 'b-one@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Lerato Grace","age":28,"gender":"Woman","location":"Botswana","city":"Gaborone","relationship_goal":"Marriage","bio":"x"}'),
 ('55555555-0000-4000-8000-0000000000e3', 'b-pending@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Pending","age":28,"gender":"Woman","location":"Botswana","city":"Gaborone","relationship_goal":"Marriage","bio":"x"}');
set session_replication_role = replica;
update members set is_official = false where is_official;
update members set approved = true where user_id in ('55555555-0000-4000-8000-0000000000e1','55555555-0000-4000-8000-0000000000e2');
update members set approved = false where user_id = '55555555-0000-4000-8000-0000000000e3';
update members set is_official = true, created_at = now() - interval '400 days' where user_id = '55555555-0000-4000-8000-0000000000e1';
set session_replication_role = origin;
select set_config('t.founder', (select id::text from members where user_id = '55555555-0000-4000-8000-0000000000e1'), false);
select set_config('t.one', (select id::text from members where user_id = '55555555-0000-4000-8000-0000000000e2'), false);
select set_config('t.expected', (select count(*)::text from members where approved and not is_official and user_id is not null and not coalesce(is_test_account, false)), false);

select t_assert(send_founder_broadcast('test-install', 'Hi {first_name} 👋 Add the app! [INSTALL-APP]') = current_setting('t.expected')::integer, 'every approved member gets the founder message');
select t_assert((select body = 'Hi Lerato 👋 Add the app! [INSTALL-APP]' from member_messages where sender_member_id = current_setting('t.founder')::uuid and recipient_member_id = current_setting('t.one')::uuid), 'first name is filled in');
select t_assert((select count(*) = 0 from member_messages mm join members m on m.id = mm.recipient_member_id where mm.sender_member_id = current_setting('t.founder')::uuid and (not m.approved or m.is_official)), 'no message to pending members or the founder itself');
select t_assert(send_founder_broadcast('test-install', 'again') = 0, 'running it again sends nothing twice');
set session_replication_role = replica;
update members set approved = true where user_id = '55555555-0000-4000-8000-0000000000e3';
set session_replication_role = origin;
select t_assert(send_founder_broadcast('test-install', 'Hi {first_name}') = 1, 'rerunning later reaches only newly approved members');
set role authenticated;
select t_denied('select public.send_founder_broadcast(''x'', ''spam'')', 'members cannot send broadcasts');
reset role;
set role anon;
select t_denied('select public.send_founder_broadcast(''x'', ''spam'')', 'visitors cannot send broadcasts');
reset role;
