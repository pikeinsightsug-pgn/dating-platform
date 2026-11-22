-- Behavioural tests for supabase/question_of_the_day.sql (synthetic data only).
\set ON_ERROR_STOP 1
\set QUIET 1
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
 ('33333333-0000-4000-8000-0000000000c1', 'q-one@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Ama","age":28,"gender":"Woman","location":"Kenya","city":"Nairobi","relationship_goal":"Marriage","bio":"x"}'),
 ('33333333-0000-4000-8000-0000000000c2', 'q-two@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Kofi","age":31,"gender":"Man","location":"Kenya","city":"Nairobi","relationship_goal":"Marriage","bio":"x"}'),
 ('33333333-0000-4000-8000-0000000000c3', 'q-pending@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Wait","age":31,"gender":"Man","location":"Kenya","city":"Nairobi","relationship_goal":"Marriage","bio":"x"}');
update members set approved = true where user_id in ('33333333-0000-4000-8000-0000000000c1','33333333-0000-4000-8000-0000000000c2');
update members set approved = false where user_id = '33333333-0000-4000-8000-0000000000c3';
select set_config('t.one', (select id::text from members where user_id = '33333333-0000-4000-8000-0000000000c1'), false);
select set_config('t.two', (select id::text from members where user_id = '33333333-0000-4000-8000-0000000000c2'), false);

select t_assert((select count(*) = 60 from daily_questions), '60 questions loaded');
select t_assert((select count(distinct pk_question_for(d::date)) = 60 from generate_series(date '2026-11-22', date '2027-01-20', interval '1 day') d), 'a different question every day for 60 days');
select t_assert(pk_question_for(date '2026-11-22') = pk_question_for(date '2027-01-21'), 'the list starts again after 60 days');

begin; select set_config('request.jwt.claim.sub', '33333333-0000-4000-8000-0000000000c1', true); set local role authenticated;
select t_assert((select my_answer is null and total_answers = 0 and cardinality(options) = 4 from today_question()), 'a member sees today''s question, not yet answered');
select answer_today_question(2);
select t_assert((select my_answer = 2 and total_answers = 1 and answer_percents = array[0,0,100,0] from today_question()), 'after answering: own answer and 100% shown');
select answer_today_question(1);
select t_assert((select my_answer = 1 and total_answers = 1 from today_question()), 'a member can change their answer the same day (still one answer)');
select t_denied('select answer_today_question(7)', 'an answer that does not exist is refused');
select t_denied('select * from daily_answers', 'members cannot read other members'' raw answers');
commit;

begin; select set_config('request.jwt.claim.sub', '33333333-0000-4000-8000-0000000000c2', true); set local role authenticated;
select t_assert((select count(*) = 0 from member_today_answer(current_setting('t.one')::uuid) where my_answer is not null), 'before answering, no "both picked" match');
select answer_today_question(1);
select t_assert((select their_answer = my_answer from member_today_answer(current_setting('t.one')::uuid)), 'profile shows "you both picked the same answer"');
select t_assert((select total_answers = 2 and answer_percents[2] = 100 from today_question()), 'percentages count every answer');
select block_member(current_setting('t.one')::uuid);
select t_assert((select count(*) = 0 from member_today_answer(current_setting('t.one')::uuid)), 'blocked members'' answers are hidden');
select unblock_member(current_setting('t.one')::uuid);
commit;

begin; select set_config('request.jwt.claim.sub', '33333333-0000-4000-8000-0000000000c3', true); set local role authenticated;
select t_denied('select * from today_question()', 'members waiting for approval cannot see the question');
commit;
set role anon;
select t_denied('select * from public.today_question()', 'visitors cannot see the question');
reset role;
