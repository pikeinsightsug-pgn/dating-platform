-- Behavioural tests for supabase/likes_and_matches.sql (synthetic data only).
\set ON_ERROR_STOP 1
\set QUIET 1
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
 ('66666666-0000-4000-8000-0000000000f1', 'l-man@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Tumelo","age":32,"gender":"Man","location":"Botswana","city":"Gaborone","relationship_goal":"Marriage","bio":"x","interests":"Music, Travel, Cooking"}'),
 ('66666666-0000-4000-8000-0000000000f2', 'l-woman@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Rudo","age":29,"gender":"Woman","location":"Zimbabwe","city":"Harare","relationship_goal":"Marriage","bio":"x","interests":"travel, reading"}'),
 ('66666666-0000-4000-8000-0000000000f3', 'l-man2@test.invalid', now(), '{"profile_type":"member_registration","first_name":"OtherMan","age":30,"gender":"Man","location":"Botswana","city":"Gaborone","relationship_goal":"Marriage","bio":"x"}'),
 ('66666666-0000-4000-8000-0000000000f4', 'l-old@test.invalid', now(), '{"profile_type":"member_registration","first_name":"TooOld","age":70,"gender":"Woman","location":"Kenya","city":"Nairobi","relationship_goal":"Marriage","bio":"x"}');
update members set approved = true where user_id::text like '66666666-%';
update members set seeking_gender = 'Women', preferred_age_min = 25, preferred_age_max = 45 where user_id = '66666666-0000-4000-8000-0000000000f1';
select set_config('t.man', (select id::text from members where user_id = '66666666-0000-4000-8000-0000000000f1'), false);
select set_config('t.woman', (select id::text from members where user_id = '66666666-0000-4000-8000-0000000000f2'), false);
select set_config('t.man2', (select id::text from members where user_id = '66666666-0000-4000-8000-0000000000f3'), false);
select set_config('t.old', (select id::text from members where user_id = '66666666-0000-4000-8000-0000000000f4'), false);

begin; select set_config('request.jwt.claim.sub', '66666666-0000-4000-8000-0000000000f1', true); set local role authenticated;
create temp table dm on commit drop as select * from daily_matches(10);
select t_assert(exists (select 1 from dm where id = current_setting('t.woman')::uuid), 'daily matches include a member from another country and city');
select t_assert(not exists (select 1 from dm where id = current_setting('t.man2')::uuid), 'daily matches respect who the member wants to meet');
select t_assert(not exists (select 1 from dm where id = current_setting('t.old')::uuid), 'daily matches respect the preferred age range');
select t_assert((select 'Also looking for marriage' = any(reasons) and 'You both like travel' = any(reasons) from dm where id = current_setting('t.woman')::uuid), 'reasons show what they have in common');
select t_assert(not exists (select 1 from dm, unnest(reasons) r where r ilike '%harare%' or r ilike '%gaborone%' or r ilike '%city%'), 'city is never used as a reason');
select t_assert((select matched = false from like_member(current_setting('t.woman')::uuid)), 'a one-way like is not a match');
select t_assert(not exists (select 1 from daily_matches(10) where id = current_setting('t.woman')::uuid), 'people already liked are not suggested again');
select t_denied('select * from member_likes', 'members cannot read the likes table');
select t_denied('select like_member(''' || current_setting('t.man') || '''::uuid)', 'nobody can like themselves');
commit;

begin; select set_config('request.jwt.claim.sub', '66666666-0000-4000-8000-0000000000f2', true); set local role authenticated;
select t_assert((select count(*) = 1 from list_likes('liked_me') where id = current_setting('t.man')::uuid), 'the liked member sees who liked them');
select t_assert((select liked_me and not i_liked from like_status(array[current_setting('t.man')::uuid])), 'like status shows they liked me');
select t_assert((select likes_me from daily_matches(10) where id = current_setting('t.man')::uuid), 'someone who liked you is suggested with "Already likes you"');
select t_assert((select matched from like_member(current_setting('t.man')::uuid)), 'liking back makes a match');
select t_assert((select count(*) = 1 from list_likes('matches') where id = current_setting('t.man')::uuid), 'the match is listed');
select t_assert((select count(*) = 0 from list_likes('liked_me')), 'a match is no longer in "liked you"');
commit;

begin; select set_config('request.jwt.claim.sub', '66666666-0000-4000-8000-0000000000f1', true); set local role authenticated;
select t_assert((select count(*) = 1 from list_likes('matches') where id = current_setting('t.woman')::uuid), 'both people see the match');
select block_member(current_setting('t.woman')::uuid);
select t_assert((select count(*) = 0 from list_likes('matches')), 'blocking hides the match');
select t_denied('select like_member(''' || current_setting('t.woman') || '''::uuid)', 'blocked members cannot be liked');
select unblock_member(current_setting('t.woman')::uuid);
select unlike_member(current_setting('t.woman')::uuid);
select t_assert((select count(*) = 0 from list_likes('matches')), 'unliking removes the match');
commit;

set role anon;
select t_denied('select * from public.daily_matches()', 'visitors cannot see matches');
select t_denied('select * from public.like_member(gen_random_uuid())', 'visitors cannot like');
reset role;
