-- READ-ONLY launch diagnostics for Find Your Person.
-- Paste the whole file into the Supabase SQL Editor and press Run.
-- It is a single SELECT statement: it cannot insert, update, delete, drop, truncate or
-- alter anything. The output is one table (ord, section, check_name, value) with counts,
-- yes/no answers and object names only — never names, emails, phone numbers, passwords
-- or tokens — so it is safe to copy and share with your developer.
with
-- Optional columns are read through JSON so the report also runs on a database where
-- the earlier setup files were never applied (missing columns simply read as null).
m as (
  select to_jsonb(x) as j from public.members x
),
mm as (
  select nullif(j->>'user_id', '')::uuid as user_id,
         coalesce((j->>'approved')::boolean, false) as approved,
         coalesce((j->>'is_test_account')::boolean, false) as is_test,
         case when j->>'age' ~ '^[0-9]{1,3}$' then (j->>'age')::integer end as age,
         j->>'first_name' as first_name, j->>'city' as city, j->>'bio' as bio,
         j->>'relationship_goal' as relationship_goal, j->>'gender' as gender, j->>'location' as location,
         j->>'profile_photo_url' as profile_photo_url, j
  from m
),
u as (
  select id, email, email_confirmed_at, raw_user_meta_data from auth.users
),
member_columns as (
  select string_agg(column_name, ', ' order by ordinal_position) as cols
  from information_schema.columns where table_schema = 'public' and table_name = 'members'
),
fn as (
  select p.proname, pg_get_function_identity_arguments(p.oid) as args, pg_get_functiondef(p.oid) as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
)
select * from (
  select 1 as ord, 'schema' as section, 'members columns' as check_name, (select cols from member_columns) as value
  union all select 2, 'schema', 'member_messages table exists', (to_regclass('public.member_messages') is not null)::text
  union all select 3, 'schema', 'member_blocks / member_reports tables exist',
    (to_regclass('public.member_blocks') is not null and to_regclass('public.member_reports') is not null)::text
  union all select 4, 'migrations', 'launch_features_secure.sql applied (signup trigger exists)',
    exists (select 1 from pg_trigger where tgname = 'create_member_profile_after_auth_confirmation')::text
  union all select 5, 'migrations', 'member_discovery_photos.sql applied (photo read function exists)',
    exists (select 1 from fn where proname = 'can_read_member_photo')::text
  union all select 6, 'migrations', 'BLOCKER if true: live browse_approved_profiles still requires 100 approved members',
    coalesce((select bool_or(def like '%opens after 100 approved%') from fn where proname = 'browse_approved_profiles'), false)::text
  union all select 7, 'migrations', 'discovery_messaging_safety.sql applied (filtered discovery exists)',
    exists (select 1 from fn where proname = 'browse_member_profiles')::text
  union all select 27, 'migrations', 'test_account_viewing.sql applied (your test accounts can view genuine members)',
    exists (select 1 from fn where proname = 'can_message_member')::text
  union all select 8, 'migrations', 'supabase_migrations history rows',
    case when to_regclass('supabase_migrations.schema_migrations') is null then 'no CLI migration history table (SQL Editor setup)'
         else (xpath('/row/c/text()', query_to_xml('select count(*) as c from supabase_migrations.schema_migrations', false, true, '')))[1]::text end
  union all select 10, 'members', 'total member rows', (select count(*) from mm)::text
  union all select 11, 'members', 'linked to an Auth account (user_id set)', (select count(*) from mm where user_id is not null)::text
  union all select 12, 'members', 'NOT linked to any Auth account (legacy / form-era)', (select count(*) from mm where user_id is null)::text
  union all select 13, 'members', 'linked to a user_id that no longer exists in auth.users',
    (select count(*) from mm where user_id is not null and not exists (select 1 from u where u.id = mm.user_id))::text
  union all select 14, 'members', 'approved', (select count(*) from mm where approved)::text
  union all select 15, 'members', 'approved AND linked AND 18+ (visible in discovery)',
    (select count(*) from mm where approved and user_id is not null and age >= 18)::text
  union all select 16, 'members', 'approved but unlinked (cannot sign in, hidden from discovery)',
    (select count(*) from mm where approved and user_id is null)::text
  union all select 17, 'members', 'linked but pending approval (these members only see their own profile)',
    (select count(*) from mm where not approved and user_id is not null)::text
  union all select 24, 'members', 'marked as owner test accounts (kept apart from genuine members)', (select count(*) from mm where is_test)::text
  union all select 25, 'members', 'GENUINE approved, linked, 18+ (excludes owner test accounts)',
    (select count(*) from mm where approved and not is_test and user_id is not null and age >= 18)::text
  union all select 26, 'schema', 'legacy_registrations archive rows (original form records)',
    case when to_regclass('public.legacy_registrations') is null then 'table missing'
         else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.legacy_registrations', false, true, '')))[1]::text end
  union all select 18, 'members', 'age missing or under 18', (select count(*) from mm where age is null or age < 18)::text
  union all select 19, 'members', 'missing required profile fields (city, bio, goal, gender or country)',
    (select count(*) from mm where city is null or bio is null or relationship_goal is null or gender is null or location is null)::text
  union all select 20, 'members', 'with a profile photo path', (select count(*) from mm where profile_photo_url is not null)::text
  union all select 21, 'members', 'photo path not inside the owner''s own folder (will not display)',
    (select count(*) from mm where profile_photo_url is not null and (user_id is null or profile_photo_url not like user_id::text || '/%'))::text
  union all select 22, 'members', 'rows with an email column value', (select count(*) from mm where nullif(j->>'email', '') is not null)::text
  union all select 23, 'members', 'rows with a phone/whatsapp column value',
    (select count(*) from mm where coalesce(nullif(j->>'phone', ''), nullif(j->>'whatsapp', ''), nullif(j->>'phone_number', '')) is not null)::text
  union all select 30, 'auth', 'Auth accounts', (select count(*) from u)::text
  union all select 31, 'auth', 'email-confirmed accounts', (select count(*) from u where email_confirmed_at is not null)::text
  union all select 32, 'auth', 'UNconfirmed accounts (cannot sign in until confirmed)', (select count(*) from u where email_confirmed_at is null)::text
  union all select 33, 'auth', 'confirmed accounts with NO member profile (see recovery screen)',
    (select count(*) from u where email_confirmed_at is not null and not exists (select 1 from mm where mm.user_id = u.id))::text
  union all select 34, 'auth', '…of which signed up through account.html (profile can self-heal at next login)',
    (select count(*) from u where email_confirmed_at is not null and raw_user_meta_data->>'profile_type' = 'member_registration'
       and not exists (select 1 from mm where mm.user_id = u.id))::text
  union all select 35, 'auth', 'accounts whose email matches an UNLINKED member row email (owner can verify and link)',
    (select count(*) from u where exists (select 1 from mm where mm.user_id is null and lower(trim(mm.j->>'email')) = lower(u.email)))::text
  union all select 40, 'duplicates', 'groups sharing first name + age + city (possible duplicates, not deleted)',
    (select count(*) from (select 1 from mm group by lower(trim(first_name)), age, lower(trim(coalesce(city, ''))) having count(*) > 1) d)::text
  union all select 41, 'duplicates', 'groups sharing the same email column value',
    (select count(*) from (select 1 from mm where nullif(j->>'email', '') is not null group by lower(trim(j->>'email')) having count(*) > 1) d)::text
  union all select 27, 'schema', 'preference columns present (seeking_gender, preferred_age_min, preferred_age_max)',
    (select count(*) = 3 from information_schema.columns where table_schema = 'public' and table_name = 'members'
       and column_name in ('seeking_gender', 'preferred_age_min', 'preferred_age_max'))::text
  union all select 28, 'schema', 'is_test_account column present', exists (select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'members' and column_name = 'is_test_account')::text
  union all select 29, 'schema', 'approved column default (should be false)',
    coalesce((select column_default from information_schema.columns where table_schema = 'public' and table_name = 'members' and column_name = 'approved'), 'column missing')
  union all select 36, 'members', 'profiles with preferences filled in', (select count(*) from mm where nullif(j->>'seeking_gender', '') is not null)::text
  union all select 62, 'messaging', 'messaging, block and report functions present (of 9)',
    (select count(distinct proname) from fn where proname in ('browse_member_profiles', 'get_member_profile', 'send_member_message',
       'list_my_conversations', 'get_conversation', 'mark_conversation_read', 'block_member', 'unblock_member', 'report_member'))::text
  union all select 63, 'messaging', 'member blocks recorded',
    case when to_regclass('public.member_blocks') is null then 'table missing'
         else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.member_blocks', false, true, '')))[1]::text end
  union all select 55, 'security', 'policies on member_messages', coalesce((select string_agg(policyname, '; ') from pg_policies where schemaname = 'public' and tablename = 'member_messages'), 'none')
  union all select 56, 'security', 'authenticated can INSERT into member_messages directly (should be false after the new file)',
    case when to_regclass('public.member_messages') is null then 'table missing' else has_table_privilege('authenticated', 'public.member_messages', 'insert')::text end
  union all select 9, 'migrations', 'registration_setup.sql columns present (user_id, approved, city, bio)',
    (select count(*) = 4 from information_schema.columns where table_schema = 'public' and table_name = 'members'
       and column_name in ('user_id', 'approved', 'city', 'bio'))::text
  union all select 50, 'security', 'RLS enabled on members',
    (select relrowsecurity from pg_class where oid = 'public.members'::regclass)::text
  union all select 51, 'security', 'policies on members', (select string_agg(policyname, '; ') from pg_policies where schemaname = 'public' and tablename = 'members')
  union all select 52, 'security', 'policies on storage.objects', (select string_agg(policyname, '; ') from pg_policies where schemaname = 'storage' and tablename = 'objects')
  union all select 53, 'security', 'anon can SELECT members (should be false)', has_table_privilege('anon', 'public.members', 'select')::text
  union all select 54, 'security', 'profile-photos bucket (public should be false)',
    (select format('exists; public=%s; limit=%s; types=%s', public, file_size_limit, allowed_mime_types) from storage.buckets where id = 'profile-photos')
  union all select 60, 'messaging', 'messages stored',
    case when to_regclass('public.member_messages') is null then 'table missing'
         else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.member_messages', false, true, '')))[1]::text end
  union all select 61, 'messaging', 'open member reports',
    case when to_regclass('public.member_reports') is null then 'table missing'
         else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.member_reports where status = ''open''', false, true, '')))[1]::text end
) report
order by ord;
