-- Behavioural tests for "active first" on Discover (supabase/smart_discovery.sql).
\set ON_ERROR_STOP 1
\set QUIET 1
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
 ('44444444-0000-4000-8000-0000000000d1', 'p-viewer@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Viewer","age":30,"gender":"Man","location":"Iceland","city":"Reykjavik","relationship_goal":"Marriage","bio":"x"}'),
 ('44444444-0000-4000-8000-0000000000d2', 'p-gone@test.invalid', now(), '{"profile_type":"member_registration","first_name":"GoneSameCity","age":30,"gender":"Woman","location":"Iceland","city":"Reykjavik","relationship_goal":"Marriage","bio":"x"}'),
 ('44444444-0000-4000-8000-0000000000d3', 'p-active@test.invalid', now(), '{"profile_type":"member_registration","first_name":"ActiveElsewhere","age":30,"gender":"Woman","location":"Peru","city":"Lima","relationship_goal":"Marriage","bio":"x"}');
update members set approved = true where user_id::text like '44444444-%';
set session_replication_role = replica;
update members set profile_photo_url = user_id::text || '/p.jpg', created_at = now() - interval '30 days' where user_id::text like '44444444-%';
update auth.users set last_sign_in_at = now() - interval '20 days' where id::text like '44444444-%';
set session_replication_role = origin;

begin; select set_config('request.jwt.claim.sub', '44444444-0000-4000-8000-0000000000d3', true); set local role authenticated;
select touch_member_presence();
commit;
select t_assert((select last_seen_at > now() - interval '1 minute' from member_presence p join members m on m.id = p.member_id where m.user_id = '44444444-0000-4000-8000-0000000000d3'), 'a visit is recorded as activity');
select t_assert(member_last_active((select id from members where user_id = '44444444-0000-4000-8000-0000000000d3')) > now() - interval '1 minute', 'last active includes visits, not only sign-ins');

select set_config('t.active', (select id::text from members where user_id = '44444444-0000-4000-8000-0000000000d3'), false);
begin; select set_config('request.jwt.claim.sub', '44444444-0000-4000-8000-0000000000d1', true); set local role authenticated;
create temp table seen as select first_name, row_number() over () as pos from browse_member_profiles(p_limit => 50);
select t_assert((select pos from seen where first_name = 'ActiveElsewhere') < (select pos from seen where first_name = 'GoneSameCity'),
  'a member active this week is shown before an inactive member, even from the viewer''s own city');
select t_assert((select activity = 'Active today' from member_activity(array[current_setting('t.active')::uuid])), 'the "Active today" label counts visits');
select t_denied('select * from member_presence', 'members cannot read visit times');
commit;
set role anon;
select t_denied('select public.touch_member_presence()', 'visitors cannot record activity');
reset role;
