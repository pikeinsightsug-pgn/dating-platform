-- Behavioural tests for supabase/just_joined.sql (synthetic data only).
\set ON_ERROR_STOP 1
\set QUIET 1
-- Members from earlier test files joined long ago here, so only these people count as new.
update members set created_at = now() - interval '60 days';
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
 ('7a7a7a7a-0000-4000-8000-000000000001', 'jj-james@test.invalid', now(), '{"profile_type":"member_registration","first_name":"James","age":31,"gender":"Man","location":"Uganda","city":"Kampala","relationship_goal":"Marriage","bio":"x"}'),
 ('7a7a7a7a-0000-4000-8000-000000000002', 'jj-grace@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Grace","age":28,"gender":"Woman","location":"Uganda","city":"Kampala","relationship_goal":"Marriage","bio":"x"}'),
 ('7a7a7a7a-0000-4000-8000-000000000003', 'jj-kofi@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Kofi","age":30,"gender":"Man","location":"Uganda","city":"Gulu","relationship_goal":"Friendship","bio":"x"}'),
 ('7a7a7a7a-0000-4000-8000-000000000004', 'jj-ama@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Ama","age":27,"gender":"Woman","location":"Botswana","city":"Maun","relationship_goal":"Friendship","bio":"x"}'),
 ('7a7a7a7a-0000-4000-8000-000000000005', 'jj-sam@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Sam","age":33,"gender":"Non-binary","location":"Kenya","city":"Nairobi","relationship_goal":"Friendship","bio":"x"}'),
 ('7a7a7a7a-0000-4000-8000-000000000006', 'jj-eve@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Eve","age":35,"gender":"Woman","location":"Kenya","city":"Nairobi","relationship_goal":"Friendship","bio":"x"}'),
 ('7a7a7a7a-0000-4000-8000-000000000007', 'jj-old@test.invalid', now(), '{"profile_type":"member_registration","first_name":"OldTimer","age":40,"gender":"Man","location":"Uganda","city":"Kampala","relationship_goal":"Marriage","bio":"x"}'),
 ('7a7a7a7a-0000-4000-8000-000000000008', 'jj-tom@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Tom","age":29,"gender":"Man","location":"Uganda","city":"Jinja","relationship_goal":"Marriage","bio":"x"}'),
 ('7a7a7a7a-0000-4000-8000-000000000009', 'jj-blocked@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Blocked","age":29,"gender":"Man","location":"Uganda","city":"Jinja","relationship_goal":"Marriage","bio":"x"}'),
 ('7a7a7a7a-0000-4000-8000-00000000000a', 'jj-test@test.invalid', now(), '{"profile_type":"member_registration","first_name":"TestAcct","age":29,"gender":"Man","location":"Uganda","city":"Jinja","relationship_goal":"Marriage","bio":"x"}');
update members set approved = true where user_id::text like '7a7a7a7a-%';
-- Grace was here before the others joined, so she is not "new" herself.
update members set created_at = now() - interval '30 days' where user_id = '7a7a7a7a-0000-4000-8000-000000000002';
update members set seeking_gender = 'Women' where user_id::text in ('7a7a7a7a-0000-4000-8000-000000000001', '7a7a7a7a-0000-4000-8000-000000000007', '7a7a7a7a-0000-4000-8000-000000000008', '7a7a7a7a-0000-4000-8000-000000000009', '7a7a7a7a-0000-4000-8000-00000000000a');
update members set seeking_gender = 'Men' where user_id::text in ('7a7a7a7a-0000-4000-8000-000000000002', '7a7a7a7a-0000-4000-8000-000000000003');
update members set seeking_gender = 'Women' where user_id = '7a7a7a7a-0000-4000-8000-000000000004';
update members set seeking_gender = 'Everyone' where user_id::text in ('7a7a7a7a-0000-4000-8000-000000000005', '7a7a7a7a-0000-4000-8000-000000000006');
-- James uploads his own photo (members can only point their profile at their own files).
begin; select set_config('request.jwt.claim.sub', '7a7a7a7a-0000-4000-8000-000000000001', true); set local role authenticated;
insert into storage.objects (bucket_id, name) values ('profile-photos', '7a7a7a7a-0000-4000-8000-000000000001/a.jpg');
update members set profile_photo_url = '7a7a7a7a-0000-4000-8000-000000000001/a.jpg' where user_id = auth.uid();
commit;
update members set created_at = now() - interval '2 days' where user_id = '7a7a7a7a-0000-4000-8000-000000000001';
update members set created_at = now() - interval '10 days' where user_id = '7a7a7a7a-0000-4000-8000-000000000007';
update members set is_test_account = true where user_id = '7a7a7a7a-0000-4000-8000-00000000000a';
select set_config('t.james', (select id::text from members where user_id = '7a7a7a7a-0000-4000-8000-000000000001'), false);
select set_config('t.grace', (select id::text from members where user_id = '7a7a7a7a-0000-4000-8000-000000000002'), false);
select set_config('t.kofi', (select id::text from members where user_id = '7a7a7a7a-0000-4000-8000-000000000003'), false);
select set_config('t.ama', (select id::text from members where user_id = '7a7a7a7a-0000-4000-8000-000000000004'), false);
select set_config('t.sam', (select id::text from members where user_id = '7a7a7a7a-0000-4000-8000-000000000005'), false);
select set_config('t.eve', (select id::text from members where user_id = '7a7a7a7a-0000-4000-8000-000000000006'), false);
select set_config('t.old', (select id::text from members where user_id = '7a7a7a7a-0000-4000-8000-000000000007'), false);
select set_config('t.tom', (select id::text from members where user_id = '7a7a7a7a-0000-4000-8000-000000000008'), false);
select set_config('t.blocked', (select id::text from members where user_id = '7a7a7a7a-0000-4000-8000-000000000009'), false);
select set_config('t.test', (select id::text from members where user_id = '7a7a7a7a-0000-4000-8000-00000000000a'), false);

-- Grace: a woman who wants to meet men.
begin; select set_config('request.jwt.claim.sub', '7a7a7a7a-0000-4000-8000-000000000002', true); set local role authenticated;
select block_member(current_setting('t.blocked')::uuid);
create temp table jj on commit drop as select * from just_joined_members(12);
select t_assert(exists (select 1 from jj where id = current_setting('t.james')::uuid), 'JUST JOINED: a new man who wants to meet women is shown to a woman who wants to meet men');
select t_assert(not exists (select 1 from jj where id = current_setting('t.kofi')::uuid), 'JUST JOINED: a new man who only wants to meet men is not shown to her');
select t_assert(not exists (select 1 from jj where id = current_setting('t.ama')::uuid), 'JUST JOINED: a new woman is not shown to someone who wants to meet men');
select t_assert(not exists (select 1 from jj where id = current_setting('t.old')::uuid), 'JUST JOINED: members who joined over 7 days ago are not new');
select t_assert(not exists (select 1 from jj where id = current_setting('t.blocked')::uuid), 'JUST JOINED: blocked members never appear');
select t_assert(not exists (select 1 from jj where id = current_setting('t.test')::uuid), 'JUST JOINED: test accounts never appear');
select t_assert((select array_position(array_agg(o.id order by o.n), current_setting('t.james')::uuid)
                       < array_position(array_agg(o.id order by o.n), current_setting('t.tom')::uuid)
                  from (select r.id, row_number() over () as n from just_joined_members(12) r) o),
  'JUST JOINED: a newcomer with a photo comes before a newer one without');
select t_assert((select profile_photo_path from jj where id = current_setting('t.james')::uuid) = '7a7a7a7a-0000-4000-8000-000000000001/a.jpg', 'JUST JOINED: the photo path is returned');
select unblock_member(current_setting('t.blocked')::uuid);
commit;

-- James: a man who wants to meet women.
begin; select set_config('request.jwt.claim.sub', '7a7a7a7a-0000-4000-8000-000000000001', true); set local role authenticated;
create temp table jj on commit drop as select * from just_joined_members(12);
select t_assert(not exists (select 1 from jj where id = current_setting('t.grace')::uuid), 'JUST JOINED: long-standing members are not listed as new');
select t_assert(exists (select 1 from jj where id = current_setting('t.eve')::uuid), 'JUST JOINED: a new woman open to everyone is shown to him');
select t_assert(not exists (select 1 from jj where id = current_setting('t.ama')::uuid), 'JUST JOINED: a new woman who only wants to meet women is not shown to him');
select t_assert(not exists (select 1 from jj where id = current_setting('t.james')::uuid), 'JUST JOINED: members never see themselves');
commit;

-- Sam: non-binary, open to everyone.
begin; select set_config('request.jwt.claim.sub', '7a7a7a7a-0000-4000-8000-000000000005', true); set local role authenticated;
create temp table jj on commit drop as select * from just_joined_members(12);
select t_assert(exists (select 1 from jj where id = current_setting('t.eve')::uuid), 'JUST JOINED: two people open to everyone see each other');
select t_assert(not exists (select 1 from jj where id = current_setting('t.tom')::uuid), 'JUST JOINED: someone who only wants women is not shown to a non-binary member');
commit;

-- The official account is pinned elsewhere on Discover and is never listed as a new member.
update members set is_official = true where user_id = '7a7a7a7a-0000-4000-8000-000000000006';
begin; select set_config('request.jwt.claim.sub', '7a7a7a7a-0000-4000-8000-000000000005', true); set local role authenticated;
select t_assert(not exists (select 1 from just_joined_members(12) where id = current_setting('t.eve')::uuid), 'JUST JOINED: the official account never appears');
commit;
update members set is_official = false where user_id = '7a7a7a7a-0000-4000-8000-000000000006';

update members set approved = false where user_id = '7a7a7a7a-0000-4000-8000-000000000008';
begin; select set_config('request.jwt.claim.sub', '7a7a7a7a-0000-4000-8000-000000000002', true); set local role authenticated;
select t_assert(not exists (select 1 from just_joined_members(12) where id = current_setting('t.tom')::uuid), 'JUST JOINED: paused or unapproved members never appear');
commit;

set role anon;
select t_denied('select * from public.just_joined_members()', 'JUST JOINED: visitors cannot see new members');
reset role;
