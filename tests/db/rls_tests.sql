-- Behavioural tests for the checked-in migrations, run as the real anon/authenticated roles.
-- Synthetic data only. Run through tests/db/run-db-tests.sh, never against the live project.
\set ON_ERROR_STOP 1
\set QUIET 1

create function public.t_assert(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end $$;
-- Runs a statement as the current role and passes only if it fails.
create function public.t_denied(stmt text, label text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    raise notice 'PASS: % (% %)', label, sqlstate, sqlerrm;
    return;
  end;
  raise exception 'FAIL: % (statement succeeded)', label;
end $$;
grant execute on function public.t_assert(boolean, text), public.t_denied(text, text) to anon, authenticated;

-- Synthetic accounts. A, B and E will be approved; C stays pending; F has no profile yet.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
 ('aaaaaaaa-0000-4000-8000-000000000001', 'member-a@test.invalid', now(), '{"profile_type":"member_registration","first_name":"TestA","age":29,"gender":"Woman","location":"Uganda","city":"Kampala","relationship_goal":"Marriage","bio":"Synthetic test A","partner_preference":"secret-pref-a"}'),
 ('bbbbbbbb-0000-4000-8000-000000000002', 'member-b@test.invalid', now(), '{"profile_type":"member_registration","first_name":"TestB","age":34,"gender":"Man","location":"Botswana","city":"Gaborone","relationship_goal":"Serious relationship","bio":"Synthetic test B"}'),
 ('cccccccc-0000-4000-8000-000000000003', 'member-c@test.invalid', now(), '{"profile_type":"member_registration","first_name":"TestC","age":40,"gender":"Man","location":"Uganda","city":"Gulu","relationship_goal":"Friendship","bio":"Synthetic pending C"}'),
 ('eeeeeeee-0000-4000-8000-000000000005', 'member-e@test.invalid', now(), '{"profile_type":"member_registration","first_name":"TestE","age":25,"gender":"Woman","location":"Uganda","city":"Jinja","relationship_goal":"Friendship","bio":"Synthetic test E"}');
-- Email confirmation arriving later must create exactly one profile.
insert into auth.users (id, email, raw_user_meta_data) values
 ('ffffffff-0000-4000-8000-000000000006', 'member-f@test.invalid', '{"profile_type":"member_registration","first_name":"TestF","age":31,"gender":"Woman","location":"Botswana","city":"Francistown","relationship_goal":"Marriage","bio":"Synthetic F"}');
select t_assert(not exists (select 1 from members where user_id = 'ffffffff-0000-4000-8000-000000000006'), 'no profile before email confirmation');
update auth.users set email_confirmed_at = now() where id = 'ffffffff-0000-4000-8000-000000000006';
select t_assert((select count(*) = 1 from members where user_id = 'ffffffff-0000-4000-8000-000000000006'), 'email confirmation creates exactly one pending profile');
update auth.users set email_confirmed_at = now() where id = 'ffffffff-0000-4000-8000-000000000006';
select t_assert((select count(*) = 1 from members where user_id = 'ffffffff-0000-4000-8000-000000000006'), 'repeat confirmation does not duplicate the profile');
delete from members where user_id = 'ffffffff-0000-4000-8000-000000000006';

-- Malformed metadata must not break Auth signup (previously it raised and failed the request).
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
 ('99999999-0000-4000-8000-000000000009', 'bad-meta@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Bad","age":"abc"}'),
 ('99999999-0000-4000-8000-000000000010', 'minor@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Minor","age":16,"gender":"Woman","location":"Uganda","city":"Kampala","relationship_goal":"Friendship","bio":"x"}'),
 ('99999999-0000-4000-8000-000000000011', 'owner@test.invalid', now(), '{}');
select t_assert(not exists (select 1 from members where user_id::text like '99999999-%'), 'invalid, under-18 and owner signups create no profile and do not fail');

-- Legacy (Google Form era) registrations: no Auth account, private contact data present.
insert into members (first_name, age, gender, location, city, relationship_goal, bio, email, phone, approved)
values ('LegacyOne', 30, 'Woman', 'Uganda', 'Mbarara', 'Marriage', 'Legacy record', 'legacy1@test.invalid', '+256700000001', false),
       ('LegacyTwo', 45, 'Man', 'Botswana', 'Maun', 'Friendship', 'Legacy approved without account', 'legacy2@test.invalid', '+26770000002', true);

select t_assert((select count(*) = 4 from members where user_id is not null), 'four signup profiles were created by the trigger');
select t_assert((select bool_and(not approved) from members where user_id is not null), 'new profiles start unapproved');
update members set approved = true where user_id in ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', 'eeeeeeee-0000-4000-8000-000000000005');
select id as a_id from members where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' \gset
select id as b_id from members where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' \gset
select id as c_id from members where user_id = 'cccccccc-0000-4000-8000-000000000003' \gset
select id as e_id from members where user_id = 'eeeeeeee-0000-4000-8000-000000000005' \gset

-- ===== Anonymous visitors =====
begin; set local role anon;
select t_denied('select id from public.members limit 1', 'anon cannot read member rows');
select t_denied('select * from public.browse_member_profiles()', 'anon cannot call discovery');
select t_denied('select * from public.list_my_conversations()', 'anon cannot list conversations');
select t_denied('select id from public.member_messages limit 1', 'anon cannot read messages');
commit;

-- ===== Member A (approved) =====
begin; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true); set local role authenticated;
select t_assert((select count(*) = 1 from members), 'A sees only their own members row via the table');
select t_assert((select array_agg(first_name) = array['TestB','TestE'] from (select first_name from browse_member_profiles() order by first_name) s), 'MANDATORY 3: A discovers B and E, not self, pending C, or legacy rows without accounts');
select t_assert((select count(*) = 0 from browse_member_profiles() where id = :'a_id'), 'A is never in their own discovery list');
select t_assert((select count(*) = 1 from browse_member_profiles(p_country => 'Botswana')), 'country filter');
select t_assert((select count(*) = 1 from browse_member_profiles(p_min_age => 30, p_max_age => 40)), 'age range filter');
select t_assert((select count(*) = 1 from browse_member_profiles(p_relationship_goal => 'Friendship')), 'relationship goal filter');
select t_assert((select count(*) = 1 and max(total_count) = 2 from browse_member_profiles(p_limit => 1)), 'pagination returns total_count with a page');
select t_assert((select count(*) = 1 from browse_member_profiles(p_limit => 1, p_offset => 1)), 'second page');
select t_assert((select count(*) = 1 from get_member_profile(:'b_id')), 'A can open B''s profile details');
select t_assert((select count(*) = 0 from get_member_profile(:'c_id')), 'A cannot open pending C''s profile');
-- RLS hides other members' rows rather than raising, so assert on what is visible.
select t_assert((select count(*) = 0 from members where email is not null), 'MANDATORY 6: no private contact field of another member is visible to A');
select t_denied('update public.members set approved = true where user_id = auth.uid()', 'A cannot change their own approval');
select t_denied('update public.members set user_id = ''cccccccc-0000-4000-8000-000000000003'' where user_id = auth.uid()', 'A cannot relink their profile to another account');
select t_assert((select count(*) = 1 from send_member_message(:'b_id', '  Hello B, this is a test.  ')), 'A sends B a private message');
select t_denied(format('select * from public.send_member_message(%L, %L)', :'c_id', 'hi'), 'A cannot message a pending member');
select t_denied(format('select * from public.send_member_message(%L, %L)', :'a_id', 'hi'), 'A cannot message themselves');
select t_denied(format('select * from public.send_member_message(%L, %L)', :'b_id', '   '), 'empty messages are rejected');
select t_denied(format('insert into public.member_messages (sender_member_id, recipient_member_id, body) values (%L, %L, %L)', :'b_id', :'e_id', 'spoof'), 'MANDATORY 6: A cannot insert a message impersonating B');
commit;

-- ===== Member B (approved) =====
begin; select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000002', true); set local role authenticated;
select t_assert((select array_agg(first_name order by first_name) = array['TestA','TestE'] from browse_member_profiles()), 'MANDATORY 3: B discovers A (and E), not self');
select t_assert((select count(*) = 0 from browse_member_profiles() p where p.first_name = 'TestB'), 'B is not in their own list');
select t_assert((select body = 'Hello B, this is a test.' and not from_me from get_conversation(:'a_id')), 'B reads A''s message (trimmed)');
select t_assert((select unread_count = 1 from list_my_conversations() where other_member_id = :'a_id'), 'B sees one unread message from A');
select t_assert((select mark_conversation_read(:'a_id') = 1), 'B marks the conversation read');
select t_assert((select unread_count = 0 from list_my_conversations() where other_member_id = :'a_id'), 'unread count clears');
select t_assert((select count(*) = 1 from send_member_message(:'a_id', 'Hi A')), 'B replies to A');
commit;

-- ===== Member E (approved, not a participant) =====
begin; select set_config('request.jwt.claim.sub', 'eeeeeeee-0000-4000-8000-000000000005', true); set local role authenticated;
select t_assert((select count(*) = 0 from get_conversation(:'a_id')), 'MANDATORY 6: E cannot read the A-B conversation by changing the member ID');
select t_assert((select count(*) = 0 from member_messages), 'MANDATORY 6: E cannot read other members'' messages through the table');
select t_assert((select count(*) = 0 from list_my_conversations()), 'E has no conversations');
select t_denied(format('update public.member_messages set body = %L', 'tampered'), 'E cannot alter messages');
commit;

-- ===== Member C (pending review) =====
begin; select set_config('request.jwt.claim.sub', 'cccccccc-0000-4000-8000-000000000003', true); set local role authenticated;
select t_assert((select count(*) = 1 and bool_and(not approved) from members), 'pending C can read their own profile');
select t_denied('select * from public.browse_member_profiles()', 'pending C cannot browse');
select t_denied('select * from public.browse_approved_profiles()', 'pending C cannot use the older discovery function');
select t_denied(format('select * from public.get_conversation(%L)', :'a_id'), 'pending C cannot read conversations');
commit;

-- ===== Blocking, reporting and the empty discovery state =====
begin; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true); set local role authenticated;
select block_member(:'b_id');
select block_member(:'e_id');
select t_assert((select count(*) = 0 from browse_member_profiles()), 'MANDATORY 7: discovery returns an empty list (no error) when no other eligible profile is available');
select t_denied(format('select * from public.send_member_message(%L, %L)', :'b_id', 'hi'), 'A cannot message a member they blocked');
select t_assert((select report_member(:'b_id', 'Fake profile', 'Synthetic report') is not null), 'A reports B');
select t_denied('select id from public.member_reports', 'members cannot read the reports table');
commit;
begin; select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000002', true); set local role authenticated;
select t_assert((select count(*) = 0 from browse_member_profiles() where id = :'a_id'), 'a block hides the blocker from the blocked member too');
select t_denied(format('select * from public.send_member_message(%L, %L)', :'a_id', 'hi'), 'blocked B cannot message A');
select t_assert((select count(*) = 0 from list_my_conversations() where other_member_id = :'a_id'), 'blocked conversation is hidden');
commit;
begin; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true); set local role authenticated;
select unblock_member(:'b_id'); select unblock_member(:'e_id');
select t_assert((select count(*) = 2 from browse_member_profiles()), 'unblocking restores discovery');
commit;
select t_assert((select count(*) = 1 from member_reports where status = 'open'), 'report stored for owner review');

-- ===== Profile photos in private storage =====
begin; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true); set local role authenticated;
insert into storage.objects (bucket_id, name) values ('profile-photos', 'aaaaaaaa-0000-4000-8000-000000000001/photo-a.jpg');
select t_assert(true, 'MANDATORY 5 (database part): A uploads into their own folder');
select t_denied('insert into storage.objects (bucket_id, name) values (''profile-photos'', ''bbbbbbbb-0000-4000-8000-000000000002/evil.jpg'')', 'A cannot upload into B''s folder');
update members set profile_photo_url = 'aaaaaaaa-0000-4000-8000-000000000001/photo-a.jpg' where user_id = auth.uid();
select t_denied('update public.members set profile_photo_url = ''bbbbbbbb-0000-4000-8000-000000000002/x.jpg'' where user_id = auth.uid()', 'A cannot point their profile at another member''s file');
commit;
begin; select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000002', true); set local role authenticated;
select t_assert((select count(*) = 1 from storage.objects where name like 'aaaaaaaa-%'), 'approved B can view approved A''s photo');
select t_assert((select profile_photo_path is not null from browse_member_profiles() where id = :'a_id'), 'discovery returns A''s photo path');
commit;
begin; select set_config('request.jwt.claim.sub', 'cccccccc-0000-4000-8000-000000000003', true); set local role authenticated;
select t_assert((select count(*) = 0 from storage.objects), 'pending C cannot view member photos');
commit;
begin; set local role anon;
select t_assert((select count(*) = 0 from storage.objects), 'anonymous visitors cannot view member photos');
commit;

-- ===== Client-side fallback profile creation (account.html) =====
begin; select set_config('request.jwt.claim.sub', 'ffffffff-0000-4000-8000-000000000006', true); set local role authenticated;
select t_denied('insert into public.members (user_id, first_name, age, gender, location, city, relationship_goal, bio, approved) values (auth.uid(), ''F'', 31, ''Woman'', ''Botswana'', ''Maun'', ''Marriage'', ''bio'', true)', 'a member cannot create a pre-approved profile');
select t_denied('insert into public.members (user_id, first_name, age, gender, location, city, relationship_goal, bio, approved) values (''aaaaaaaa-0000-4000-8000-000000000001'', ''F'', 31, ''Woman'', ''Botswana'', ''Maun'', ''Marriage'', ''bio'', false)', 'a member cannot create a profile for another account');
select t_denied('insert into public.members (user_id, first_name, age, gender, location, city, relationship_goal, bio, approved) values (auth.uid(), ''F'', 17, ''Woman'', ''Botswana'', ''Maun'', ''Marriage'', ''bio'', false)', 'under-18 profiles are rejected');
insert into public.members (user_id, first_name, age, gender, location, city, relationship_goal, bio, approved)
values (auth.uid(), 'TestF', 31, 'Woman', 'Botswana', 'Francistown', 'Marriage', 'Synthetic F', false);
select t_assert(true, 'MANDATORY 1 (database part): a signed-in member with no profile can create one pending profile from their own signup data');
select t_denied('insert into public.members (user_id, first_name, age, gender, location, city, relationship_goal, bio, approved) values (auth.uid(), ''F'', 31, ''Woman'', ''Botswana'', ''Maun'', ''Marriage'', ''bio'', false)', 'a second profile for the same account is rejected');
commit;

-- ===== Legacy registrations are preserved =====
select t_assert((select count(*) = 2 from members where user_id is null), 'MANDATORY 4 (database part): legacy registrations without accounts remain preserved and unlinked');
select t_assert((select email = 'legacy1@test.invalid' and phone = '+256700000001' from members where first_name = 'LegacyOne'), 'legacy contact details are intact');

-- ===== A database rule rejecting the profile row must not fail Auth signup =====
alter table public.members add constraint t_reject_name check (first_name is distinct from 'RejectMe') not valid;
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
 ('12121212-0000-4000-8000-000000000012', 'rejected@test.invalid', now(), '{"profile_type":"member_registration","first_name":"RejectMe","age":30,"gender":"Woman","location":"Uganda","city":"Kampala","relationship_goal":"Marriage","bio":"x"}');
select t_assert(exists (select 1 from auth.users where email = 'rejected@test.invalid')
  and not exists (select 1 from members where user_id = '12121212-0000-4000-8000-000000000012'),
  'a profile row the database rejects is skipped; the Auth signup still succeeds');
alter table public.members drop constraint t_reject_name;

-- ===== Owner test accounts are kept apart from genuine members =====
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
 ('13131313-0000-4000-8000-000000000013', 'owner-test-2@test.invalid', now(), '{"profile_type":"member_registration","first_name":"OwnerTest2","age":35,"gender":"Man","location":"Uganda","city":"Kampala","relationship_goal":"Friendship","bio":"owner test"}');
update members set approved = true, is_test_account = true where user_id = '13131313-0000-4000-8000-000000000013';
update members set is_test_account = true where id = :'e_id';
select id as t2_id from members where user_id = '13131313-0000-4000-8000-000000000013' \gset
select t_assert((select count(*) = 0 from members where is_test_account and user_id::text like 'aaaaaaaa%'), 'genuine profiles start unmarked');
begin; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true); set local role authenticated;
select t_assert((select array_agg(first_name order by first_name) = array['TestB'] from browse_member_profiles()), 'a genuine member never sees test accounts in discovery');
select t_assert((select array_agg(first_name order by first_name) = array['TestB'] from browse_approved_profiles()), 'the older discovery function also hides test accounts');
select t_assert((select count(*) = 0 from get_member_profile(:'t2_id')), 'a genuine member cannot open a test profile');
select t_denied(format('select * from public.send_member_message(%L, %L)', :'t2_id', 'hi'), 'a genuine member cannot message a test account');
select t_denied('update public.members set is_test_account = true where user_id = auth.uid()', 'members cannot mark themselves as test accounts');
commit;
begin; select set_config('request.jwt.claim.sub', '13131313-0000-4000-8000-000000000013', true); set local role authenticated;
select t_assert((select array_agg(first_name order by first_name) = array['TestE'] from browse_member_profiles()), 'test accounts see only other test accounts');
select t_denied(format('select * from public.send_member_message(%L, %L)', :'a_id', 'hi'), 'a test account cannot message a genuine member');
select t_assert((select count(*) = 1 from send_member_message(:'e_id', 'test to test')), 'two test accounts can message each other');
select t_assert((select count(*) = 0 from list_my_conversations() where other_member_id = :'a_id'), 'no genuine conversations are visible to a test account');
commit;
update members set is_test_account = false where id = :'e_id';

-- ===== Registration questionnaire preferences =====
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
 ('14141414-0000-4000-8000-000000000014', 'prefs@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Prefs","age":29,"gender":"Woman","location":"Botswana","city":"Maun","relationship_goal":"Marriage","bio":"x","seeking_gender":"Men","preferred_age_min":28,"preferred_age_max":40}'),
 ('15151515-0000-4000-8000-000000000015', 'badprefs@test.invalid', now(), '{"profile_type":"member_registration","first_name":"BadPrefs","age":29,"gender":"Woman","location":"Botswana","city":"Maun","relationship_goal":"Marriage","bio":"x","seeking_gender":"Aliens","preferred_age_min":50,"preferred_age_max":20}');
select t_assert((select seeking_gender = 'Men' and preferred_age_min = 28 and preferred_age_max = 40 from members where user_id = '14141414-0000-4000-8000-000000000014'), 'signup copies who they want to meet and the preferred age range');
select t_assert((select seeking_gender is null and preferred_age_min is null and first_name = 'BadPrefs' from members where user_id = '15151515-0000-4000-8000-000000000015'), 'invalid optional preferences are stored as not given; the profile is still created');
begin; select set_config('request.jwt.claim.sub', '14141414-0000-4000-8000-000000000014', true); set local role authenticated;
update members set seeking_gender = 'Everyone', preferred_age_min = 25, preferred_age_max = 45 where user_id = auth.uid();
select t_assert((select seeking_gender = 'Everyone' and preferred_age_max = 45 from members), 'members can edit their own preferences');
select t_denied('update public.members set preferred_age_min = 60, preferred_age_max = 30 where user_id = auth.uid()', 'an impossible age range is rejected');
select t_denied('update public.members set seeking_gender = ''Robots'' where user_id = auth.uid()', 'unknown seeking values are rejected');
commit;
begin; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true); set local role authenticated;
select t_assert((select count(*) = 0 from members where seeking_gender is not null), 'other members cannot read anyone''s preferences directly');
commit;

-- ===== Extra profile photos =====
\set pa 'aaaaaaaa-0000-4000-8000-000000000001/11111111-1111-4111-8111-11111111111'
begin; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true); set local role authenticated;
insert into storage.objects (bucket_id, name) select 'profile-photos', :'pa' || n || '.jpg' from generate_series(1, 7) n;
select t_assert((select count(*) = 6 from (select add_member_photo(:'pa' || n || '.jpg') from generate_series(1, 6) n) x), 'a member can add up to 6 extra photos from their own folder');
select t_denied(format('select public.add_member_photo(%L)', :'pa' || '7.jpg'), 'a 7th extra photo is refused');
select t_denied('select public.add_member_photo(''bbbbbbbb-0000-4000-8000-000000000002/22222222-2222-4222-8222-222222222222.jpg'')', 'a photo from someone else''s folder is refused');
select t_denied('select public.add_member_photo(''aaaaaaaa-0000-4000-8000-000000000001/33333333-3333-4333-8333-333333333333.jpg'')', 'a file that was never uploaded is refused');
select t_assert((select count(*) = 6 from list_my_photos()), 'the member sees their own extra photos');
select t_denied('select * from public.member_photos', 'members cannot read the photo table directly');
commit;
select id as photo_id from member_photos order by created_at limit 1 \gset
begin; select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000002', true); set local role authenticated;
select t_assert((select count(*) = 1 from get_member_profile(:'a_id')), 'approved B can open approved A''s profile');
select t_assert((select count(*) = 6 from get_member_photos(:'a_id')), 'approved B sees A''s 6 extra photos');
select t_assert((select count(*) = 6 from storage.objects where name like 'aaaaaaaa-0000-4000-8000-000000000001/11111111-%'),
  'B can open exactly A''s 6 extra photo files, not A''s other unlisted file');
select t_assert(remove_member_photo(:'photo_id') is null, 'a member cannot remove someone else''s photo');
select t_denied('select public.add_member_photo(''aaaaaaaa-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111117.jpg'')', 'a member cannot add someone else''s file to their own profile');
commit;
begin; select set_config('request.jwt.claim.sub', 'cccccccc-0000-4000-8000-000000000003', true); set local role authenticated;
select t_denied(format('select * from public.get_member_photos(%L)', :'a_id'), 'a pending member cannot list anyone''s extra photos');
select t_assert((select count(*) = 0 from storage.objects where name like 'aaaaaaaa-%'), 'a pending member cannot open extra photo files');
commit;
begin; set local role anon;
select t_denied(format('select * from public.get_member_photos(%L)', :'a_id'), 'visitors cannot list extra photos');
select t_assert((select count(*) = 0 from storage.objects), 'visitors cannot open extra photo files');
commit;
begin; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true); set local role authenticated;
select t_assert(remove_member_photo(:'photo_id') like 'aaaaaaaa-0000-4000-8000-000000000001/%', 'a member can remove their own extra photo');
select t_assert((select count(*) = 5 from list_my_photos()), 'the removed photo is gone');
commit;
select t_assert((select count(*) = 5 from member_photos), 'no other photo rows changed');

-- ===== Official founder account (supabase/official_account.sql) =====
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
 ('16161616-0000-4000-8000-000000000016', 'founder@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Tiago","age":42,"gender":"Man","location":"Botswana","city":"Francistown","relationship_goal":"Friendship","bio":"owner"}'),
 ('17171717-0000-4000-8000-000000000017', 'founder-test@test.invalid', now(), '{"profile_type":"member_registration","first_name":"FounderTest","age":40,"gender":"Man","location":"Uganda","city":"Gulu","relationship_goal":"Friendship","bio":"owner test official"}');
select id as o_id from members where user_id = '16161616-0000-4000-8000-000000000016' \gset
select id as ot_id from members where user_id = '17171717-0000-4000-8000-000000000017' \gset
select t_assert((select bool_and(not is_official) from members), 'every existing profile starts as not official');
-- What the owner console does: approve, mark official, and make sure it is not a test account.
update members set approved = true, is_official = true, is_test_account = false where id = :'o_id';
update members set approved = true, is_official = true, is_test_account = true where id = :'ot_id';

begin; select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true); set local role authenticated;
select t_assert((select count(*) = 0 from browse_member_profiles() where id = :'o_id'), 'the official account is not shown in Discover as a dating profile');
select t_assert((select count(*) = 0 from browse_approved_profiles() where id = :'o_id'), 'the older discovery function also leaves the official account out');
select t_assert((select array_agg(id) = array[:'o_id'::uuid] from list_official_accounts()), 'an approved member sees exactly the genuine official account');
select t_assert((select first_name = 'Tiago' and city = 'Francistown' from list_official_accounts()), 'the official card shows its name and city');
select t_assert((select count(*) = 1 from get_member_profile(:'o_id')), 'members can open the official profile from a message link');
select t_assert((select count(*) = 1 from send_member_message(:'o_id', 'Thank you Pike')), 'members can reply to the official account');
select t_denied('update public.members set is_official = true where user_id = auth.uid()', 'members cannot make themselves official');
select t_denied('update public.members set first_name = ''Pike – Founder'' where user_id = auth.uid()', 'members cannot call themselves Founder');
select t_denied('update public.members set first_name = ''P.K Connect Team'' where user_id = auth.uid()', 'members cannot use the platform name as their name');
select t_denied('update public.members set first_name = ''Official'' where user_id = auth.uid()', 'members cannot call themselves Official');
update public.members set bio = 'Synthetic test A' where user_id = auth.uid();
select t_assert((select first_name = 'TestA' from members), 'members can still save their profile with their own name');
update public.members set first_name = 'Supporter Ann' where user_id = auth.uid();
select t_assert((select first_name = 'Supporter Ann' from members), 'ordinary names that only contain a reserved word are allowed');
update public.members set first_name = 'TestA' where user_id = auth.uid();
commit;

begin; select set_config('request.jwt.claim.sub', '16161616-0000-4000-8000-000000000016', true); set local role authenticated;
update public.members set first_name = 'Pike – Founder' where user_id = auth.uid();
select t_assert((select first_name = 'Pike – Founder' and is_official from members), 'the official account can use the Founder name and sees its own flag');
select t_assert((select count(*) = 0 from list_official_accounts()), 'the official account does not list itself');
select t_assert((select count(*) >= 3 from browse_member_profiles()), 'the official account can browse genuine members to welcome them');
select t_assert((select count(*) = 0 from browse_member_profiles() where id in (:'t2_id', :'ot_id')), 'the official account never sees test accounts');
commit;
-- 30 recent messages is the normal limit; the official account may keep welcoming members.
insert into member_messages (sender_member_id, recipient_member_id, body)
select :'o_id', :'b_id', 'welcome ' || n from generate_series(1, 30) n;
begin; select set_config('request.jwt.claim.sub', '16161616-0000-4000-8000-000000000016', true); set local role authenticated;
select t_assert((select count(*) = 1 from send_member_message(:'e_id', 'Welcome to P.K Connect!')), 'the official account can send more than 30 welcome messages in 10 minutes');
commit;
insert into member_messages (sender_member_id, recipient_member_id, body)
select :'b_id', :'a_id', 'hello ' || n from generate_series(1, 30) n;
begin; select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000002', true); set local role authenticated;
select t_denied(format('select * from public.send_member_message(%L, %L)', :'e_id', 'one more'), 'ordinary members keep the 30-message limit');
commit;

begin; select set_config('request.jwt.claim.sub', '13131313-0000-4000-8000-000000000013', true); set local role authenticated;
select t_assert((select array_agg(id) = array[:'ot_id'::uuid] from list_official_accounts()), 'test accounts see only the test official account');
commit;
begin; select set_config('request.jwt.claim.sub', 'cccccccc-0000-4000-8000-000000000003', true); set local role authenticated;
select t_denied('select * from public.list_official_accounts()', 'pending members cannot list the official account');
commit;
begin; set local role anon;
select t_denied('select * from public.list_official_accounts()', 'visitors cannot list the official account');
commit;
begin; select set_config('request.jwt.claim.sub', 'eeeeeeee-0000-4000-8000-000000000005', true); set local role authenticated;
select block_member(:'o_id');
select t_assert((select count(*) = 0 from list_official_accounts()), 'a member who blocks the official account no longer sees it');
select unblock_member(:'o_id');
commit;
-- The signup trigger and the owner are never blocked by the reserved-name rule.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
 ('18181818-0000-4000-8000-000000000018', 'admin-name@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Admin","age":30,"gender":"Woman","location":"Uganda","city":"Kampala","relationship_goal":"Marriage","bio":"x"}');
select t_assert(exists (select 1 from members where user_id = '18181818-0000-4000-8000-000000000018' and not approved), 'a signup with a reserved name still succeeds (pending, for the owner to review)');
update members set first_name = 'Owner Renamed Official' where id = :'ot_id';
select t_assert((select first_name = 'Owner Renamed Official' from members where id = :'ot_id'), 'the owner can rename any profile');
