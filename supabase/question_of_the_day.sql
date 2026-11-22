-- Question of the day (November 2026).
-- Apply after smart_discovery.sql. Additive and safe to rerun: the question list is refreshed,
-- answers already given are kept.
--
-- Every day (UTC) approved members see one fun question at the top of Discover with four
-- answers. After answering they see how everyone answered (percentages only, never who).
-- Their answer shows on their profile for that day, and a member who opens a profile sees
-- "You both picked the same answer" plus a ready-made first message. 60 questions rotate in
-- order, so the list lasts 2 months and then starts again. Add or edit questions in the
-- daily_questions table (Table Editor); set active = false to skip one.
begin;

do $preflight$
begin
  if to_regprocedure('public.current_approved_member_id()') is null
     or to_regprocedure('public.members_are_blocked(uuid, uuid)') is null then
    raise exception 'Apply the earlier checked-in setup files first; no changes applied';
  end if;
end;
$preflight$;

create table if not exists public.daily_questions (
  id integer primary key,
  question text not null check (length(question) between 5 and 200),
  options text[] not null check (cardinality(options) between 2 and 4),
  active boolean not null default true
);
alter table public.daily_questions enable row level security;
revoke all on public.daily_questions from public, anon, authenticated;

create table if not exists public.daily_answers (
  member_id uuid not null references public.members(id) on delete cascade,
  day date not null,
  question_id integer not null references public.daily_questions(id) on delete cascade,
  option_index smallint not null check (option_index between 0 and 3),
  answered_at timestamptz not null default now(),
  primary key (member_id, day)
);
create index if not exists daily_answers_day_idx on public.daily_answers(day, question_id);
alter table public.daily_answers enable row level security;
revoke all on public.daily_answers from public, anon, authenticated;

insert into public.daily_questions (id, question, options) values
  (1, 'What''s your idea of a perfect first date?', array['Dinner somewhere cosy', 'A walk and good conversation', 'Something adventurous', 'Coffee and see where it goes']),
  (2, 'How do you like to spend a Sunday?', array['Lazy morning in bed', 'Out with friends', 'Exploring somewhere new', 'Family time and a big lunch']),
  (3, 'Which matters most to you in a partner?', array['Kindness', 'Honesty', 'A good sense of humour', 'Ambition']),
  (4, 'What''s your love language?', array['Kind words', 'Quality time', 'Thoughtful gifts', 'Acts of service']),
  (5, 'Morning person or night owl?', array['Up with the sun', 'Late nights all the way', 'Depends on the day', 'Coffee decides']),
  (6, 'Your dream holiday together?', array['A quiet beach', 'A big exciting city', 'Mountains and nature', 'Road trip with no plan']),
  (7, 'How soon is too soon to say "I love you"?', array['Within a month', 'A few months in', 'When it feels right', 'Wait for them to say it first']),
  (8, 'What makes you laugh the most?', array['Silly jokes', 'Funny videos', 'Witty banter', 'Embarrassing stories']),
  (9, 'Who should pay on the first date?', array['The one who asked', 'Split it', 'The man', 'Whoever offers first']),
  (10, 'Which would you rather receive?', array['A handwritten letter', 'A surprise visit', 'A long phone call', 'Flowers']),
  (11, 'How do you handle a disagreement?', array['Talk it out right away', 'Take time to cool off', 'Hug first, talk later', 'Write it down']),
  (12, 'What''s most attractive in a first message?', array['A good question', 'A compliment', 'Something funny', 'Mentioning my profile']),
  (13, 'Your ideal weekend night?', array['Movie at home', 'Dancing', 'Dinner with friends', 'An early night']),
  (14, 'Which pet would you share a home with?', array['A dog', 'A cat', 'Both!', 'No pets, thanks']),
  (15, 'How important is faith in a relationship?', array['Very important', 'Somewhat important', 'Not important', 'We should respect each other''s views']),
  (16, 'Pick a superpower for date night:', array['Read minds', 'Teleport anywhere', 'Stop time', 'Always find parking']),
  (17, 'What''s your favourite way to show you care?', array['Cooking a meal', 'Planning a surprise', 'Listening carefully', 'Sending sweet messages']),
  (18, 'Long chats or short and sweet?', array['Long voice notes', 'Long texts', 'Short and sweet', 'Let''s just call']),
  (19, 'Which song mood fits you today?', array['Slow and romantic', 'Upbeat dance', 'Calm and soulful', 'Old classics']),
  (20, 'What would you cook to impress a date?', array['My signature dish', 'Breakfast in bed', 'A sweet dessert', 'I''d book a restaurant']),
  (21, 'City life or countryside?', array['Big city lights', 'Quiet countryside', 'A small town', 'Somewhere by the sea']),
  (22, 'How many children would you like?', array['None', 'One or two', 'Three or four', 'Let''s talk about it']),
  (23, 'What''s a deal-breaker for you?', array['Dishonesty', 'Laziness', 'Bad hygiene', 'Being rude to waiters']),
  (24, 'Which describes your style?', array['Smart and classy', 'Casual and comfy', 'Sporty', 'Bold and colourful']),
  (25, 'Your favourite way to relax?', array['Music', 'A good film or series', 'Exercise', 'Sleep!']),
  (26, 'Who should text first after a date?', array['The one who had more fun', 'The man', 'The woman', 'Whoever wants to see the other again']),
  (27, 'What''s the best age gap in a couple?', array['Same age', 'Up to 5 years', 'Up to 10 years', 'Age is just a number']),
  (28, 'Which date would you say yes to?', array['Picnic in the park', 'Cooking class together', 'Live music night', 'Sunset drive']),
  (29, 'How do you feel about long distance?', array['Love can travel', 'Only for a short time', 'Not for me', 'Depends on the person']),
  (30, 'What do you notice first about someone?', array['Their smile', 'Their eyes', 'How they dress', 'How they speak']),
  (31, 'Your perfect anniversary gift?', array['A trip away', 'Jewellery or a watch', 'A photo album of us', 'A quiet dinner']),
  (32, 'How tidy are you?', array['Very neat', 'Organised mess', 'Messy but clean', 'Let''s not talk about it']),
  (33, 'What''s your dream career path?', array['Running my own business', 'Rising to the top', 'Helping people', 'Something creative']),
  (34, 'Pick a drink for a first date:', array['Coffee', 'Juice or a smoothie', 'A glass of wine', 'Tea']),
  (35, 'How do you feel about meeting the family early?', array['The sooner the better', 'After a few months', 'Only when it''s serious', 'I''m nervous about it']),
  (36, 'Best way to spend a rainy day together?', array['Cuddles and a movie', 'Cooking together', 'Board games', 'Dancing in the rain']),
  (37, 'Which compliment would make your day?', array['You''re beautiful or handsome', 'You''re so kind', 'You''re so smart', 'You make me laugh']),
  (38, 'What would your friends say about you?', array['Loyal', 'The life of the party', 'The wise one', 'Always late']),
  (39, 'Your favourite season?', array['Summer', 'Autumn', 'Winter', 'Spring']),
  (40, 'How do you like to celebrate your birthday?', array['Big party', 'Small dinner with close friends', 'A trip', 'Quietly at home']),
  (41, 'What kind of music would we dance to?', array['Afrobeats', 'R&B', 'Love songs', 'Old-school classics']),
  (42, 'Phone calls or video calls?', array['Phone calls', 'Video calls', 'Both', 'Texting is enough']),
  (43, 'Your ideal home?', array['Modern apartment', 'House with a garden', 'Farmhouse', 'Wherever you are']),
  (44, 'How romantic are you?', array['Very, flowers and poems', 'Sweet in small ways', 'Practical romantic', 'Still learning']),
  (45, 'What''s the best first-date conversation topic?', array['Dreams and goals', 'Travel', 'Food', 'Funny life stories']),
  (46, 'How often should couples go on dates?', array['Every week', 'Twice a month', 'Once a month', 'Every day can be a date']),
  (47, 'Which film genre for date night?', array['Romance', 'Comedy', 'Action', 'Horror, so you hold my hand']),
  (48, 'What''s your favourite kind of food?', array['Spicy', 'Sweet', 'Homemade traditional', 'Anything with friends']),
  (49, 'How do you feel about surprises?', array['Love them', 'Small ones only', 'Not really', 'Surprise me and see']),
  (50, 'Would you rather…', array['Travel the world together', 'Build a home together', 'Start a business together', 'All of the above']),
  (51, 'What''s your biggest green flag?', array['They listen', 'They keep promises', 'They''re kind to everyone', 'They make time for you']),
  (52, 'How do you show you''re interested?', array['Lots of messages', 'Plenty of compliments', 'Making time to meet', 'Shy smiles']),
  (53, 'Which word describes your ideal relationship?', array['Peaceful', 'Fun', 'Passionate', 'Supportive']),
  (54, 'Early to bed or party till late?', array['Early to bed', 'Party till late', 'Depends on the company', 'A bit of both']),
  (55, 'Your favourite way to keep fit?', array['Gym', 'Walking or jogging', 'Dancing', 'Sport with friends']),
  (56, 'How would you plan a surprise date?', array['A secret dinner', 'A weekend away', 'A picnic at sunset', 'Tickets to a show']),
  (57, 'What''s more important?', array['Good communication', 'Shared values', 'Chemistry', 'Trust']),
  (58, 'Which hobby would you try together?', array['Cooking', 'Dancing lessons', 'Hiking', 'Painting']),
  (59, 'What does your perfect morning look like?', array['Breakfast together', 'A workout', 'Quiet prayer or reflection', 'Sleeping in']),
  (60, 'What would you name our future pet?', array['Something cute like Honey', 'Something funny like Boss', 'A famous name', 'We''d argue for weeks'])
on conflict (id) do update set question = excluded.question, options = excluded.options;

-- Today's question: the active questions in id order, one per UTC day, starting 22 Nov 2026.
create or replace function public.pk_question_for(p_day date)
returns integer language sql stable security definer set search_path = ''
as $$
  with q as (select id, row_number() over (order by id) - 1 as n, count(*) over () as total
             from public.daily_questions where active)
  select id from q
  where n = (((p_day - date '2026-11-22') % total) + total) % total
$$;
revoke all on function public.pk_question_for(date) from public, anon, authenticated;

-- The question, my answer (or null) and how everyone answered (percent per option).
create or replace function public.today_question()
returns table (question_id integer, question text, options text[], my_answer smallint,
               answer_percents integer[], total_answers integer)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me uuid := public.current_approved_member_id();
  today date := (now() at time zone 'utc')::date;
  qid integer := public.pk_question_for(today);
begin
  if me is null then
    raise exception 'Only approved members can see the question of the day' using errcode = '42501';
  end if;
  if qid is null then return; end if;
  return query
  with counts as (
    select a.option_index, count(*)::integer as n
    from public.daily_answers a where a.day = today and a.question_id = qid
    group by a.option_index
  ), tot as (select coalesce(sum(n), 0)::integer as t from counts)
  select dq.id, dq.question, dq.options,
         (select a.option_index from public.daily_answers a where a.member_id = me and a.day = today),
         (select array_agg(case when tot.t = 0 then 0
                   else round(100.0 * coalesce((select c.n from counts c where c.option_index = i - 1), 0) / tot.t)::integer end
                 order by i)
            from generate_series(1, cardinality(dq.options)) as i),
         tot.t
  from public.daily_questions dq, tot
  where dq.id = qid;
end;
$$;
revoke all on function public.today_question() from public, anon;
grant execute on function public.today_question() to authenticated;

-- Answer (or change the answer to) today's question.
create or replace function public.answer_today_question(p_option integer)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := public.current_approved_member_id();
  today date := (now() at time zone 'utc')::date;
  qid integer := public.pk_question_for(today);
begin
  if me is null then
    raise exception 'Only approved members can answer the question of the day' using errcode = '42501';
  end if;
  if qid is null or p_option is null or p_option < 0
     or p_option >= (select cardinality(options) from public.daily_questions where id = qid) then
    raise exception 'Choose one of the answers' using errcode = '22023';
  end if;
  insert into public.daily_answers (member_id, day, question_id, option_index)
  values (me, today, qid, p_option)
  on conflict (member_id, day) do update
    set option_index = excluded.option_index, question_id = excluded.question_id, answered_at = now();
end;
$$;
revoke all on function public.answer_today_question(integer) from public, anon;
grant execute on function public.answer_today_question(integer) to authenticated;

-- Another member's answer to today's question, for their profile. Empty when they have not
-- answered, are not an approved member, or either member has blocked the other.
create or replace function public.member_today_answer(p_member_id uuid)
returns table (question text, their_answer text, my_answer text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me uuid := public.current_approved_member_id();
  today date := (now() at time zone 'utc')::date;
begin
  if me is null then
    raise exception 'Only approved members can see answers' using errcode = '42501';
  end if;
  if p_member_id is null or p_member_id = me or public.members_are_blocked(me, p_member_id)
     or not exists (select 1 from public.members m where m.id = p_member_id and m.approved = true) then
    return;
  end if;
  return query
  select dq.question, dq.options[t.option_index + 1],
         (select dq.options[mine.option_index + 1] from public.daily_answers mine
           where mine.member_id = me and mine.day = today and mine.question_id = t.question_id)
  from public.daily_answers t
  join public.daily_questions dq on dq.id = t.question_id
  where t.member_id = p_member_id and t.day = today;
end;
$$;
revoke all on function public.member_today_answer(uuid) from public, anon;
grant execute on function public.member_today_answer(uuid) to authenticated;

commit;
