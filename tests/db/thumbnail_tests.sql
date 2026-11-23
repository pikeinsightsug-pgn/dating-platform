-- Behavioural tests for supabase/photo_thumbnails.sql (synthetic data only).
\set ON_ERROR_STOP 1
\set QUIET 1
select t_assert(pk_thumb_path('u1/abc-123.jpg') = 'u1/thumb_abc-123.jpg', 'thumbnail path for a .jpg photo');
select t_assert(pk_thumb_path('u1/abc.def.png') = 'u1/thumb_abc.def.jpg', 'only the last extension is replaced');
select t_assert(pk_thumb_path('u1/noext') = 'u1/thumb_noext.jpg', 'a name without an extension');
select t_assert(pk_thumb_path('old-OrigA.jpg') = 'thumb_old-OrigA.jpg', 'a path without a folder');
select t_assert(pk_thumb_path(null) is null, 'no photo, no thumbnail');

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
 ('88888888-0000-4000-8000-000000000001', 't-owner@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Thandi","age":30,"gender":"Woman","location":"Botswana","city":"Maun","relationship_goal":"Marriage","bio":"x"}'),
 ('88888888-0000-4000-8000-000000000002', 't-viewer@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Kato","age":33,"gender":"Man","location":"Uganda","city":"Gulu","relationship_goal":"Marriage","bio":"x"}'),
 ('88888888-0000-4000-8000-000000000003', 't-pending@test.invalid', now(), '{"profile_type":"member_registration","first_name":"Pending","age":33,"gender":"Man","location":"Uganda","city":"Gulu","relationship_goal":"Marriage","bio":"x"}');
update members set approved = true where user_id in ('88888888-0000-4000-8000-000000000001', '88888888-0000-4000-8000-000000000002');
update members set approved = false where user_id = '88888888-0000-4000-8000-000000000003';
set session_replication_role = replica; -- test setup only: skips the member-facing photo trigger
update members set profile_photo_url = '88888888-0000-4000-8000-000000000001/p1.png' where user_id = '88888888-0000-4000-8000-000000000001';
set session_replication_role = origin;
insert into storage.objects (bucket_id, name) values
 ('profile-photos', '88888888-0000-4000-8000-000000000001/p1.png'),
 ('profile-photos', '88888888-0000-4000-8000-000000000001/thumb_p1.jpg'),
 ('profile-photos', '88888888-0000-4000-8000-000000000001/thumb_other.jpg');

begin; select set_config('request.jwt.claim.sub', '88888888-0000-4000-8000-000000000002', true); set local role authenticated;
select t_assert(exists (select 1 from storage.objects where name = '88888888-0000-4000-8000-000000000001/thumb_p1.jpg'), 'an approved member can open the thumbnail of a profile photo');
select t_assert(not exists (select 1 from storage.objects where name = '88888888-0000-4000-8000-000000000001/thumb_other.jpg'), 'a "thumb_" file that belongs to no profile photo stays private');
commit;
begin; select set_config('request.jwt.claim.sub', '88888888-0000-4000-8000-000000000003', true); set local role authenticated;
select t_assert(not exists (select 1 from storage.objects where name like '88888888-0000-4000-8000-000000000001/%'), 'a pending member cannot open thumbnails');
select t_denied('insert into storage.objects (bucket_id, name) values (''profile-photos'', ''88888888-0000-4000-8000-000000000001/thumb_p1.jpg'')', 'nobody can upload a thumbnail into another member''s folder');
commit;
begin; select set_config('request.jwt.claim.sub', '88888888-0000-4000-8000-000000000001', true); set local role authenticated;
select t_assert((select count(*) = 3 from storage.objects where name like '88888888-0000-4000-8000-000000000001/%'), 'members see all files in their own folder');
commit;
set role anon;
select t_assert(not exists (select 1 from storage.objects where name like '%thumb_%'), 'visitors cannot open thumbnails');
reset role;
