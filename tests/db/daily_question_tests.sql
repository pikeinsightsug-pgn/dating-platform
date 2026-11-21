-- Question of the Day tests. Runs after rls_tests.sql on the same synthetic data:
-- A, B and E are approved; C was returned to pending. Never run against the live project.
\set ON_ERROR_STOP 1
\set QUIET 1
select id as a_id from members where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' \gset
select id as b_id from members where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' \gset
select id as e_id from members where user_id = 'eeeeeeee-0000-4000-8000-000000000005' \gset
delete from member_blocks;

select t_assert((select count(*) >= 50 from daily_questions), 'the question list is seeded');
select t_assert((select count(*) = 1 from daily_question_for(date '2026-11-21')), 'exactly one question each day');
select t_assert((select q1.id <> q2.id from daily_question_for(date '2026-11-21') q1, daily_question_for(date '2026-11-22') q2), 'the question changes the next day');

begin; set local role anon;
select t_denied('select * from public.todays_question()', 'visitors cannot see the question');
select t_denied('select public.answer_daily_question(''hi'')', 'visitors cannot answer');
select t_denied('select * from public.daily_answers', 'visitors cannot read answers');
commit;

-- A answers before anyone else.
begin; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true); set local role authenticated;
select t_assert((select my_answer is null and answer_count = 0 from todays_question()), 'A has not answered yet');
select t_denied('select * from public.daily_answers', 'members cannot read the answers table directly');
select t_denied('insert into public.daily_answers values (gen_random_uuid(), current_date, 1, ''x'')', 'members cannot write the answers table directly');
select t_denied('select public.answer_daily_question(''   '')', 'blank answers are refused');
select t_denied(format('select public.answer_daily_question(%L)', repeat('x', 151)), 'answers over 150 characters are refused');
select t_assert(answer_daily_question('  Pap,   always  '), 'A answers');
select t_assert((select my_answer = 'Pap, always' and answer_count = 1 from todays_question()), 'the answer is tidied and counted');
select t_assert(answer_daily_question('Rice, actually'), 'A changes the answer');
select t_assert((select my_answer = 'Rice, actually' and answer_count = 1 from todays_question()), 'changing the answer does not count twice');
select t_assert((select count(*) = 0 from todays_answers()), 'no other answers yet');
commit;

-- B must answer before seeing A's answer.
begin; select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000002', true); set local role authenticated;
select t_assert((select count(*) = 0 from todays_answers()), 'B sees no answers before answering');
select t_assert(answer_daily_question('Pap with seswaa'), 'B answers');
select t_assert((select count(*) = 1 and bool_and(answer = 'Rice, actually') from todays_answers()), 'B now sees A''s answer');
select t_assert((select bool_and(member_id <> :'b_id'::uuid) from todays_answers()), 'B never sees their own answer in the list');
commit;

-- Pending C cannot take part.
begin; select set_config('request.jwt.claim.sub', 'cccccccc-0000-4000-8000-000000000003', true); set local role authenticated;
select t_denied('select * from public.todays_question()', 'a pending member cannot see the question');
select t_denied('select public.answer_daily_question(''hello'')', 'a pending member cannot answer');
commit;

-- Blocking hides answers both ways.
begin; select set_config('request.jwt.claim.sub', 'eeeeeeee-0000-4000-8000-000000000005', true); set local role authenticated;
select t_assert(answer_daily_question('Both!'), 'E answers');
select t_assert((select count(*) = 2 from todays_answers()), 'E sees A and B');
select block_member(:'a_id'::uuid);
select t_assert((select count(*) = 1 and bool_and(member_id = :'b_id'::uuid) from todays_answers()), 'E no longer sees A after blocking');
commit;
begin; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true); set local role authenticated;
select t_assert((select count(*) = 1 and bool_and(member_id = :'b_id'::uuid) from todays_answers()), 'A no longer sees E either');
commit;

-- Answers from a member later returned to pending disappear.
update members set approved = false where id = :'b_id';
begin; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true); set local role authenticated;
select t_assert((select count(*) = 0 from todays_answers()), 'answers from members under review are hidden');
commit;
update members set approved = true where id = :'b_id';
delete from member_blocks;
delete from daily_answers;
