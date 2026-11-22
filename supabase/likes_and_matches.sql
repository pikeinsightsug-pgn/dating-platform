-- Likes, mutual matches and "Your matches today" (November 2026).
-- Apply after question_of_the_day.sql, smart_discovery.sql and push_notifications.sql.
-- Additive and safe to rerun: no member row or message is changed.
--
--   * A member taps Like on a profile. Nobody can see a like unless it is mutual, except the
--     person who was liked, who sees "X people liked you" and (for now, free) who they are.
--     "Not now" is never stored or shown to anyone.
--   * When two members like each other it is a match: both get a phone alert and are invited
--     to chat. Unliking removes the like (and the match).
--   * daily_matches(): up to 5 suggestions a day, picked from the member's own preferences
--     (who they want to meet and their age range) and what they have in common: relationship
--     goal, today's Question of the day answer, interests, recent activity, a photo, and
--     whether the other person already liked them. City and country are deliberately NOT used,
--     so members meet people anywhere.
--   * At most 100 likes a day per member; blocked members never see or like each other.
begin;

do $preflight$
begin
  if to_regprocedure('public.current_approved_member_id()') is null
     or to_regprocedure('public.members_are_blocked(uuid, uuid)') is null
     or to_regprocedure('public.member_last_active(uuid)') is null
     or to_regclass('public.daily_answers') is null then
    raise exception 'Apply smart_discovery.sql and question_of_the_day.sql first; no changes applied';
  end if;
end;
$preflight$;

create table if not exists public.member_likes (
  liker_id uuid not null references public.members(id) on delete cascade,
  liked_id uuid not null references public.members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (liker_id, liked_id),
  check (liker_id <> liked_id)
);
create index if not exists member_likes_liked_idx on public.member_likes(liked_id, created_at desc);
alter table public.member_likes enable row level security;
revoke all on public.member_likes from public, anon, authenticated;

-- Can this member be liked by me: approved, adult, has an account, not official, not me,
-- and neither of us blocked the other.
create or replace function public.pk_can_like(me uuid, other uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select me is not null and other is not null and me <> other
    and exists (select 1 from public.members m where m.id = other and m.approved = true
                and m.age >= 18 and m.user_id is not null and m.is_official = false)
    and not public.members_are_blocked(me, other)
$$;
revoke all on function public.pk_can_like(uuid, uuid) from public, anon, authenticated;

create or replace function public.like_member(p_member_id uuid)
returns table (matched boolean)
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := public.require_approved_member();
begin
  if not public.pk_can_like(me, p_member_id) then
    raise exception 'This member cannot be liked' using errcode = '42501';
  end if;
  if (select count(*) from public.member_likes l
      where l.liker_id = me and l.created_at > now() - interval '1 day') >= 100 then
    raise exception 'You have liked a lot of people today. Try again tomorrow.' using errcode = '54000';
  end if;
  insert into public.member_likes (liker_id, liked_id) values (me, p_member_id)
  on conflict do nothing;
  return query select exists (select 1 from public.member_likes l
                              where l.liker_id = p_member_id and l.liked_id = me);
end;
$$;
revoke all on function public.like_member(uuid) from public, anon;
grant execute on function public.like_member(uuid) to authenticated;

create or replace function public.unlike_member(p_member_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := public.require_approved_member();
begin
  delete from public.member_likes where liker_id = me and liked_id = p_member_id;
end;
$$;
revoke all on function public.unlike_member(uuid) from public, anon;
grant execute on function public.unlike_member(uuid) to authenticated;

-- For the cards and profile view: did I like them, did they like me (only shown as a match
-- or in "liked you"), for members I can see.
create or replace function public.like_status(p_member_ids uuid[])
returns table (id uuid, i_liked boolean, liked_me boolean)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me uuid := public.require_approved_member();
begin
  return query
  select x.mid,
         exists (select 1 from public.member_likes l where l.liker_id = me and l.liked_id = x.mid),
         exists (select 1 from public.member_likes l where l.liker_id = x.mid and l.liked_id = me)
  from unnest(coalesce(p_member_ids[1:60], array[]::uuid[])) as x(mid)
  where public.pk_can_like(me, x.mid);
end;
$$;
revoke all on function public.like_status(uuid[]) from public, anon;
grant execute on function public.like_status(uuid[]) to authenticated;

-- 'liked_me': people who liked me and I have not liked back yet. 'matches': mutual likes.
create or replace function public.list_likes(p_kind text)
returns table (id uuid, first_name text, age integer, gender text, location text, city text,
               relationship_goal text, profile_photo_path text, liked_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me uuid := public.require_approved_member();
begin
  if p_kind not in ('liked_me', 'matches') then
    raise exception 'Unknown list' using errcode = '22023';
  end if;
  return query
  select m.id, m.first_name, m.age, m.gender, m.location, m.city, m.relationship_goal,
         case when m.profile_photo_url is not null
               and (storage.foldername(m.profile_photo_url))[1] = m.user_id::text
              then m.profile_photo_url end,
         l.created_at
  from public.member_likes l
  join public.members m on m.id = l.liker_id
  where l.liked_id = me
    and public.pk_can_like(me, m.id)
    and (case when p_kind = 'matches'
              then exists (select 1 from public.member_likes back where back.liker_id = me and back.liked_id = m.id)
              else not exists (select 1 from public.member_likes back where back.liker_id = me and back.liked_id = m.id) end)
  order by l.created_at desc
  limit 60;
end;
$$;
revoke all on function public.list_likes(text) from public, anon;
grant execute on function public.list_likes(text) to authenticated;

-- Up to 5 suggestions, the same all day (they change daily), never people I already liked.
create or replace function public.daily_matches(p_limit integer default 5)
returns table (id uuid, first_name text, age integer, gender text, location text, city text,
               relationship_goal text, bio text, profile_photo_path text, likes_me boolean,
               reasons text[])
language plpgsql stable security definer set search_path = ''
as $$
declare
  me uuid := public.require_approved_member();
  my public.members%rowtype;
  today date := (now() at time zone 'utc')::date;
  wanted text;
begin
  select * into my from public.members where public.members.id = me;
  wanted := case my.seeking_gender when 'Men' then 'man' when 'Women' then 'woman' else null end;
  return query
  with cand as (
    select m.*, public.member_last_active(m.id) as seen,
           exists (select 1 from public.member_likes l where l.liker_id = m.id and l.liked_id = me) as likes_me_,
           (select dq.options[a.option_index + 1]
              from public.daily_answers a
              join public.daily_answers mine on mine.member_id = me and mine.day = today
                and mine.question_id = a.question_id and mine.option_index = a.option_index
              join public.daily_questions dq on dq.id = a.question_id
             where a.member_id = m.id and a.day = today) as same_answer,
           (select t.word from (
               select trim(w) as word from regexp_split_to_table(lower(coalesce(m.interests, '')), '[,;/\n]+') w
               intersect
               select trim(w) from regexp_split_to_table(lower(coalesce(my.interests, '')), '[,;/\n]+') w) t
             where length(t.word) between 3 and 40 order by t.word limit 1) as shared_interest
    from public.members m
    where m.approved = true and m.age >= 18 and m.user_id is not null and m.id <> me
      and m.is_official = false and coalesce(m.is_test_account, false) = false
      and not public.members_are_blocked(me, m.id)
      and not exists (select 1 from public.member_likes l where l.liker_id = me and l.liked_id = m.id)
      and (wanted is null or (case when lower(m.gender) in ('man', 'male') then 'man'
                                   when lower(m.gender) in ('woman', 'female') then 'woman' end) = wanted)
      and (my.preferred_age_min is null or m.age >= my.preferred_age_min)
      and (my.preferred_age_max is null or m.age <= my.preferred_age_max)
  ), scored as (
    select c.*,
      (case when c.likes_me_ then 4 else 0 end)
      + (case when c.same_answer is not null then 3 else 0 end)
      + (case when my.relationship_goal is not null and c.relationship_goal = my.relationship_goal then 3 else 0 end)
      + (case when c.shared_interest is not null then 2 else 0 end)
      + (case when c.seen > now() - interval '3 days' then 2 else 0 end)
      + (case when c.profile_photo_url is not null then 3 else 0 end)
      + (case when (c.seeking_gender is null or c.seeking_gender = 'Everyone'
                    or (c.seeking_gender = 'Men' and lower(my.gender) in ('man', 'male'))
                    or (c.seeking_gender = 'Women' and lower(my.gender) in ('woman', 'female')))
                and (c.preferred_age_min is null or my.age >= c.preferred_age_min)
                and (c.preferred_age_max is null or my.age <= c.preferred_age_max) then 1 else 0 end) as score
    from cand c
  )
  select s.id, s.first_name, s.age, s.gender, s.location, s.city, s.relationship_goal, s.bio,
         case when s.profile_photo_url is not null
               and (storage.foldername(s.profile_photo_url))[1] = s.user_id::text
              then s.profile_photo_url end,
         s.likes_me_,
         (array_remove(array[
            case when s.likes_me_ then 'Already likes you ❤️' end,
            case when my.relationship_goal is not null and s.relationship_goal = my.relationship_goal
                 then 'Also looking for ' || lower(s.relationship_goal) end,
            case when s.same_answer is not null then 'You both picked “' || s.same_answer || '” today' end,
            case when s.shared_interest is not null then 'You both like ' || s.shared_interest end,
            case when s.seen > now() - interval '1 day' then 'Active today'
                 when s.seen > now() - interval '7 days' then 'Active this week' end,
            case when s.created_at > now() - interval '7 days' then 'New this week' end
          ], null))[1:3]
  from scored s
  order by s.score desc, md5(me::text || s.id::text || today::text)
  limit least(10, greatest(1, coalesce(p_limit, 5)));
end;
$$;
revoke all on function public.daily_matches(integer) from public, anon;
grant execute on function public.daily_matches(integer) to authenticated;

-- Phone alerts: "Someone liked you 👀" (at most one every 30 minutes per person) and
-- "It's a match with Naledi 🎉" to both people. Never blocks the like itself.
create or replace function public.notify_new_like_push()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  rest_key text;
  is_match boolean;
  liker_name text;
  liked_name text;
  send_one record;
begin
  begin
    select ds.decrypted_secret into rest_key from vault.decrypted_secrets ds
    where ds.name = 'onesignal_rest_api_key' limit 1;
    if rest_key is null then return new; end if;
    is_match := exists (select 1 from public.member_likes l where l.liker_id = new.liked_id and l.liked_id = new.liker_id);
    select coalesce(nullif(trim(m.first_name), ''), 'Someone') into liker_name from public.members m where m.id = new.liker_id;
    select coalesce(nullif(trim(m.first_name), ''), 'Someone') into liked_name from public.members m where m.id = new.liked_id;
    if not is_match and exists (select 1 from public.member_likes l where l.liked_id = new.liked_id
        and l.liker_id <> new.liker_id and l.created_at > now() - interval '30 minutes') then
      return new;
    end if;
    for send_one in
      select new.liked_id as target, new.liker_id as other,
             case when is_match then 'It''s a match with ' || liker_name || ' 🎉 Say hello!'
                  else 'Someone liked you on P.K Connect 👀 Tap to see who' end as body
      union all
      select new.liker_id, new.liked_id, 'It''s a match with ' || liked_name || ' 🎉 Say hello!'
      where is_match
    loop
      perform net.http_post(
        url := 'https://api.onesignal.com/notifications?c=push',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Key ' || rest_key),
        body := jsonb_build_object(
          'app_id', '8e44de4a-0ae7-4a62-b9fb-099b24a6b81c',
          'target_channel', 'push',
          'include_aliases', jsonb_build_object('external_id', jsonb_build_array(send_one.target::text)),
          'headings', jsonb_build_object('en', 'P.K Connect'),
          'contents', jsonb_build_object('en', send_one.body),
          'url', case when is_match then 'https://pkconnectonline.com/messages.html?member=' || send_one.other::text
                      else 'https://pkconnectonline.com/discover.html?likes=1' end,
          'web_push_topic', 'pk-like-' || send_one.target::text
        )
      );
    end loop;
  exception when others then
    raise warning 'Like notification skipped: %', sqlerrm;
  end;
  return new;
end;
$$;
revoke all on function public.notify_new_like_push() from public, anon, authenticated;

drop trigger if exists notify_new_like_push on public.member_likes;
create trigger notify_new_like_push
after insert on public.member_likes
for each row execute function public.notify_new_like_push();

commit;
