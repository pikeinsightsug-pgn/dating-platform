-- Automatic founder welcome message (already applied in production on 2026-11-15; kept here so
-- the repository matches the live database). Safe to rerun: it only replaces this function and
-- trigger. When a new member row is created, "Pike – Founder" sends them a welcome message.
-- A failure never blocks sign-up. To switch it off:
--   drop trigger if exists on_new_member_welcome on public.members;
create or replace function public.send_founder_welcome()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  founder_id uuid := '0bf5a032-1880-42d1-88eb-5a0809514e8d';
begin
  if new.id <> founder_id then
    begin
      insert into member_messages (sender_member_id, recipient_member_id, body)
      values (
        founder_id,
        new.id,
        'Hi ' || coalesce(nullif(trim(new.first_name), ''), 'there') || ', welcome to P.K Connect! 🎉' || E'\n\n' ||
        'I''m Pike, the founder. I built P.K Connect so people can meet real, genuine partners without fake profiles or scammers. Every member is reviewed to keep this a safe community.' || E'\n\n' ||
        'Tip: complete your profile and add a clear, recent photo. It helps you get noticed.' || E'\n\n' ||
        'If you need any help, just reply to this message. Wishing you luck in finding your person! ❤️' || E'\n\n' ||
        '— Pike, Founder'
      );
    exception when others then
      raise warning 'Founder welcome message failed: %', sqlerrm;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists on_new_member_welcome on members;

create trigger on_new_member_welcome
after insert on members
for each row execute function public.send_founder_welcome();
