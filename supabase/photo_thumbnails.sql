-- Small photos ("thumbnails") for cards, lists and chat pictures (November 2026).
-- Apply after member_extra_photos.sql. Additive and safe to rerun; no photo or member row changes.
--
-- Each profile photo "<folder>/<name>.<ext>" can have a small copy "<folder>/thumb_<name>.jpg"
-- (about 10 times smaller). Members who may see a profile photo may also see its thumbnail.
-- The website makes thumbnails when a photo is uploaded, and for older photos when the member
-- next opens My Profile; the owner console can also make them for everyone at once.
begin;

do $preflight$
begin
  if to_regprocedure('public.can_read_member_photo(text)') is null
     or to_regclass('public.member_photos') is null then
    raise exception 'Apply member_discovery_photos.sql and member_extra_photos.sql first; no changes applied';
  end if;
end;
$preflight$;

-- Keep in step with thumbPathFor() in assets/member-core.js.
create or replace function public.pk_thumb_path(p_path text)
returns text language sql immutable set search_path = ''
as $$
  select case when p_path is null then null else
    (case when position('/' in p_path) > 0 then regexp_replace(p_path, '[^/]*$', '') else '' end)
    || 'thumb_'
    || (case when regexp_replace(p_path, '^.*/', '') ~ '\.'
             then regexp_replace(regexp_replace(p_path, '^.*/', ''), '\.[^.]*$', '')
             else regexp_replace(p_path, '^.*/', '') end)
    || '.jpg'
  end
$$;
grant execute on function public.pk_thumb_path(text) to authenticated, service_role;

-- The earlier rules, plus: the thumbnail of a profile photo follows the same rule as the photo.
create or replace function public.can_read_member_photo(object_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select (storage.foldername(object_name))[1] = auth.uid()::text
    or exists (
      select 1
      from public.members m
      where (m.profile_photo_url = object_name
             or (m.profile_photo_url is not null and public.pk_thumb_path(m.profile_photo_url) = object_name))
        and m.user_id is not null
        and (
          m.user_id = auth.uid()
          or (m.approved = true and m.age >= 18 and public.current_approved_member_id() is not null)
        )
    )
    or exists (
      select 1
      from public.member_photos mp
      join public.members m on m.id = mp.member_id
      where mp.storage_path = object_name
        and m.user_id is not null
        and m.approved = true and m.age >= 18
        and public.current_approved_member_id() is not null
    )
$$;
revoke all on function public.can_read_member_photo(text) from public, anon;
grant execute on function public.can_read_member_photo(text) to authenticated;

commit;
