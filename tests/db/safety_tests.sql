-- Behavioural tests for supabase/safety_protection.sql (synthetic data only).
\set ON_ERROR_STOP 1
\set QUIET 1

-- 20 synthetic members: 1 = new-account sender, 2 = older sender, 3 = copy-paster,
-- 4 = official account, 5..20 = other members.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
select ('77777777-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 's' || i || '@test.invalid', now(),
       jsonb_build_object('profile_type', 'member_registration', 'first_name', 'Safety' || i, 'age', 30,
                          'gender', case when i % 2 = 0 then 'Woman' else 'Man' end, 'location', 'Zimbabwe',
                          'city', 'Harare', 'relationship_goal', 'Marriage', 'bio', 'x')
from generate_series(1, 20) i;
update members set approved = true where user_id::text like '77777777-%';
-- Only member 1 is a brand-new account.
update members set created_at = now() - interval '10 days' where user_id::text like '77777777-%'
  and user_id <> '77777777-0000-4000-8000-000000000001';
update members set is_official = true where user_id = '77777777-0000-4000-8000-000000000004';

create function pg_temp.mid(n integer) returns uuid language sql as $$
  select id from public.members where user_id = ('77777777-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;
select set_config('t.m' || i, pg_temp.mid(i)::text, false) from generate_series(1, 20) i;

-- Contact details between strangers ---------------------------------------------------------
begin; select set_config('request.jwt.claim.sub', '77777777-0000-4000-8000-000000000002', true); set local role authenticated;
select t_denied('select send_member_message(''' || current_setting('t.m5') || '''::uuid, ''Call me on 0712 345 678'')', 'a phone number is held back between strangers');
select t_denied('select send_member_message(''' || current_setting('t.m5') || '''::uuid, ''+263 77-123-4567'')', 'an international phone number is held back');
select t_denied('select send_member_message(''' || current_setting('t.m5') || '''::uuid, ''Lets talk on WhatsApp'')', 'WhatsApp is held back between strangers');
select t_denied('select send_member_message(''' || current_setting('t.m5') || '''::uuid, ''write to me at sam.k@gmail.com'')', 'an email address is held back between strangers');
select t_assert((select count(*) = 1 from send_member_message(current_setting('t.m5')::uuid, 'Hi! I am 29, I live 5 km from town and love the year 2026')), 'ordinary messages with small numbers are sent');
commit;

-- 10 messages each without a like is not enough.
insert into member_messages (sender_member_id, recipient_member_id, body)
select current_setting('t.m' || s)::uuid, current_setting('t.m' || r)::uuid, 'chat ' || g
from (values (2, 5), (5, 2)) p(s, r), generate_series(1, 10) g;
begin; select set_config('request.jwt.claim.sub', '77777777-0000-4000-8000-000000000002', true); set local role authenticated;
select t_denied('select send_member_message(''' || current_setting('t.m5') || '''::uuid, ''My WhatsApp is 0712 345 678'')', '10 messages each without a mutual like is not enough');
commit;

-- A mutual like without 10 messages each is not enough.
insert into member_likes (liker_id, liked_id) values
  (current_setting('t.m2')::uuid, current_setting('t.m6')::uuid),
  (current_setting('t.m6')::uuid, current_setting('t.m2')::uuid);
insert into member_messages (sender_member_id, recipient_member_id, body)
select current_setting('t.m' || s)::uuid, current_setting('t.m' || r)::uuid, 'chat ' || g
from (values (2, 6), (6, 2)) p(s, r), generate_series(1, 9) g;
begin; select set_config('request.jwt.claim.sub', '77777777-0000-4000-8000-000000000002', true); set local role authenticated;
select t_denied('select send_member_message(''' || current_setting('t.m6') || '''::uuid, ''Here is my number 0712 345 678'')', 'a mutual like with fewer than 10 messages each is not enough');
commit;

-- A mutual like AND 10 messages each opens contact sharing.
insert into member_messages (sender_member_id, recipient_member_id, body)
values (current_setting('t.m6')::uuid, current_setting('t.m2')::uuid, 'chat 10'),
       (current_setting('t.m2')::uuid, current_setting('t.m6')::uuid, 'chat 10');
begin; select set_config('request.jwt.claim.sub', '77777777-0000-4000-8000-000000000002', true); set local role authenticated;
select t_assert((select count(*) = 1 from send_member_message(current_setting('t.m6')::uuid, 'Here is my number 0712 345 678')), 'a mutual like and 10 messages each allow contact details');
select t_denied('select send_member_message(''' || current_setting('t.m7') || '''::uuid, ''0712 345 678'')', 'other strangers still cannot receive contact details');
commit;

-- The official account is never held back.
begin; select set_config('request.jwt.claim.sub', '77777777-0000-4000-8000-000000000004', true); set local role authenticated;
select t_assert((select count(*) = 1 from send_member_message(current_setting('t.m7')::uuid, 'Need help? Email pikeinsightsug@gmail.com')), 'the official account can share contact details');
commit;

-- Money words ---------------------------------------------------------------------------------
begin; select set_config('request.jwt.claim.sub', '77777777-0000-4000-8000-000000000002', true); set local role authenticated;
select t_assert((select count(*) = 1 from send_member_message(current_setting('t.m8')::uuid, 'Please send me money for transport')), 'a money message still arrives');
commit;
select t_assert((select safety_flag = 'money' from member_messages where sender_member_id = current_setting('t.m2')::uuid
                 and recipient_member_id = current_setting('t.m8')::uuid), 'the money message is marked');
select t_assert(not exists (select 1 from safety_alerts where member_id = current_setting('t.m2')::uuid), 'one money message to one person does not flag the member');
begin; select set_config('request.jwt.claim.sub', '77777777-0000-4000-8000-000000000002', true); set local role authenticated;
select send_member_message(current_setting('t.m9')::uuid, 'I need help, can you use Western Union?');
select t_denied('select * from safety_alerts', 'members cannot read safety alerts');
commit;
select t_assert((select people = 2 and status = 'open' from safety_alerts where member_id = current_setting('t.m2')::uuid and kind = 'money_words'),
                'money words to 2 people flag the member for the owner');
select t_assert(exists (select 1 from member_messages where sender_member_id = current_setting('t.m2')::uuid and body like 'Hi!%' and safety_flag is null),
                'ordinary messages are not marked');

-- Copy-paste spam ----------------------------------------------------------------------------
begin; select set_config('request.jwt.claim.sub', '77777777-0000-4000-8000-000000000003', true); set local role authenticated;
select send_member_message(current_setting('t.m' || i)::uuid, 'Hello dear, you look so beautiful. I am a  doctor working abroad.')
from generate_series(5, 11) i;
commit;
select t_assert(not exists (select 1 from safety_alerts where member_id = current_setting('t.m3')::uuid), '7 copies do not flag the member');
begin; select set_config('request.jwt.claim.sub', '77777777-0000-4000-8000-000000000003', true); set local role authenticated;
select t_assert((select count(*) = 1 from send_member_message(current_setting('t.m12')::uuid, 'Hello dear, you look so BEAUTIFUL. I am a doctor working abroad.')), 'the 8th copy is sent');
select t_denied('select send_member_message(''' || current_setting('t.m13') || '''::uuid, ''Hello dear, you look so beautiful. I am a doctor working abroad.'')', 'the 9th copy is refused');
select t_assert((select count(*) = 3 from (select send_member_message(current_setting('t.m' || i)::uuid, 'Hi, how are you?') from generate_series(13, 15) i) s), 'short greetings can go to many people');
commit;
select t_assert((select kind = 'copy_paste' and people = 8 from safety_alerts where member_id = current_setting('t.m3')::uuid), 'copy-paste flags the member for the owner');

-- New accounts: 15 new conversations on the first day ------------------------------------
insert into member_messages (sender_member_id, recipient_member_id, body)
values (current_setting('t.m20')::uuid, current_setting('t.m1')::uuid, 'Welcome!');
begin; select set_config('request.jwt.claim.sub', '77777777-0000-4000-8000-000000000001', true); set local role authenticated;
select t_assert((select count(*) = 15 from (select send_member_message(current_setting('t.m' || i)::uuid, 'Hi there ' || i)
                 from generate_series(5, 19) i) s), 'a new account can start 15 conversations');
select t_denied('select send_member_message(''' || current_setting('t.m2') || '''::uuid, ''Hi'')', 'the 16th new conversation waits until tomorrow');
select t_assert((select count(*) = 1 from send_member_message(current_setting('t.m20')::uuid, 'Thank you!')), 'replying to someone who wrote first is always allowed');
select t_assert((select count(*) = 1 from send_member_message(current_setting('t.m5')::uuid, 'Second message')), 'existing conversations continue');
commit;

-- Auto-hide after 3 reports -------------------------------------------------------------------
select set_config('t.target', current_setting('t.m3'), false);
begin; select set_config('request.jwt.claim.sub', '77777777-0000-4000-8000-000000000005', true); set local role authenticated;
select report_member(current_setting('t.target')::uuid, 'Scam or payment request', null);
select report_member(current_setting('t.target')::uuid, 'Scam or payment request', 'again');
commit;
begin; select set_config('request.jwt.claim.sub', '77777777-0000-4000-8000-000000000006', true); set local role authenticated;
select report_member(current_setting('t.target')::uuid, 'Fake profile', null);
commit;
select t_assert((select approved and not safety_hold from members where id = current_setting('t.target')::uuid), 'reports from 2 people do not pause a profile');
begin; select set_config('request.jwt.claim.sub', '77777777-0000-4000-8000-000000000007', true); set local role authenticated;
select report_member(current_setting('t.target')::uuid, 'Harassment', null);
select t_assert(not exists (select 1 from get_member_profile(current_setting('t.target')::uuid)), 'a paused profile is hidden from members');
commit;
select t_assert((select not approved and safety_hold and safety_hold_at is not null from members where id = current_setting('t.target')::uuid), 'reports from 3 different people pause the profile');
begin; select set_config('request.jwt.claim.sub', '77777777-0000-4000-8000-000000000003', true); set local role authenticated;
select t_denied('select send_member_message(''' || current_setting('t.m14') || '''::uuid, ''hello'')', 'a paused member cannot send messages');
commit;

select set_config('t.official', current_setting('t.m4'), false);
do $reports$
declare r integer;
begin
  for r in 5..7 loop
    insert into member_reports (reporter_member_id, reported_member_id, reason)
    values (pg_temp.mid(r), current_setting('t.official')::uuid, 'Other');
  end loop;
end;
$reports$;
select t_assert((select approved and not safety_hold from members where id = current_setting('t.official')::uuid), 'the official account is never paused');

-- Members cannot change their own safety markers.
begin; select set_config('request.jwt.claim.sub', '77777777-0000-4000-8000-000000000003', true); set local role authenticated;
select t_denied('update members set safety_hold = false, approved = true where user_id = auth.uid()', 'members cannot lift their own pause');
commit;

set role anon;
select t_denied('select * from public.safety_alerts', 'visitors cannot read safety alerts');
reset role;
