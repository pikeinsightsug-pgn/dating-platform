-- P.K CONNECT goes worldwide.
--
-- Run this ONCE in the Supabase SQL Editor (it is also safe to rerun).
-- It lets members register, edit their profile and be discovered from any country in
-- the supported list, instead of only Uganda and Botswana.
--
-- What it changes, and nothing else:
--   1. Creates public.is_supported_country(text) with the full country list.
--   2. Rewrites every live rule on public.members (row-level policies and CHECK
--      constraints) and every function in the public schema that still says
--      "location in ('Uganda', 'Botswana')" so it calls is_supported_country instead.
-- It does not add, delete, approve or edit any member, photo or message.
-- Everything runs in one transaction: if any rule cannot be rewritten safely, the
-- script stops with an error and nothing is changed.

begin;

-- Single source of truth in the database for which countries a member may choose.
-- Must match assets/countries.js; tests/platform-regression.test.mjs checks this.
create or replace function public.is_supported_country(p_country text)
returns boolean language sql immutable parallel safe set search_path = ''
as $countries$
  select coalesce(p_country = any (array[
    'Afghanistan',
    'Albania',
    'Algeria',
    'Andorra',
    'Angola',
    'Antigua and Barbuda',
    'Argentina',
    'Armenia',
    'Australia',
    'Austria',
    'Azerbaijan',
    'Bahamas',
    'Bahrain',
    'Bangladesh',
    'Barbados',
    'Belarus',
    'Belgium',
    'Belize',
    'Benin',
    'Bhutan',
    'Bolivia',
    'Bosnia and Herzegovina',
    'Botswana',
    'Brazil',
    'Brunei',
    'Bulgaria',
    'Burkina Faso',
    'Burundi',
    'Cabo Verde',
    'Cambodia',
    'Cameroon',
    'Canada',
    'Central African Republic',
    'Chad',
    'Chile',
    'China',
    'Colombia',
    'Comoros',
    'Congo (Brazzaville)',
    'Congo (DRC)',
    'Costa Rica',
    'Côte d''Ivoire',
    'Croatia',
    'Cuba',
    'Cyprus',
    'Czechia',
    'Denmark',
    'Djibouti',
    'Dominica',
    'Dominican Republic',
    'Ecuador',
    'Egypt',
    'El Salvador',
    'Equatorial Guinea',
    'Eritrea',
    'Estonia',
    'Eswatini',
    'Ethiopia',
    'Fiji',
    'Finland',
    'France',
    'Gabon',
    'Gambia',
    'Georgia',
    'Germany',
    'Ghana',
    'Greece',
    'Grenada',
    'Guatemala',
    'Guinea',
    'Guinea-Bissau',
    'Guyana',
    'Haiti',
    'Honduras',
    'Hong Kong',
    'Hungary',
    'Iceland',
    'India',
    'Indonesia',
    'Iran',
    'Iraq',
    'Ireland',
    'Israel',
    'Italy',
    'Jamaica',
    'Japan',
    'Jordan',
    'Kazakhstan',
    'Kenya',
    'Kiribati',
    'Kosovo',
    'Kuwait',
    'Kyrgyzstan',
    'Laos',
    'Latvia',
    'Lebanon',
    'Lesotho',
    'Liberia',
    'Libya',
    'Liechtenstein',
    'Lithuania',
    'Luxembourg',
    'Macau',
    'Madagascar',
    'Malawi',
    'Malaysia',
    'Maldives',
    'Mali',
    'Malta',
    'Marshall Islands',
    'Mauritania',
    'Mauritius',
    'Mexico',
    'Micronesia',
    'Moldova',
    'Monaco',
    'Mongolia',
    'Montenegro',
    'Morocco',
    'Mozambique',
    'Myanmar',
    'Namibia',
    'Nauru',
    'Nepal',
    'Netherlands',
    'New Zealand',
    'Nicaragua',
    'Niger',
    'Nigeria',
    'North Korea',
    'North Macedonia',
    'Norway',
    'Oman',
    'Pakistan',
    'Palau',
    'Palestine',
    'Panama',
    'Papua New Guinea',
    'Paraguay',
    'Peru',
    'Philippines',
    'Poland',
    'Portugal',
    'Puerto Rico',
    'Qatar',
    'Romania',
    'Russia',
    'Rwanda',
    'Saint Kitts and Nevis',
    'Saint Lucia',
    'Saint Vincent and the Grenadines',
    'Samoa',
    'San Marino',
    'São Tomé and Príncipe',
    'Saudi Arabia',
    'Senegal',
    'Serbia',
    'Seychelles',
    'Sierra Leone',
    'Singapore',
    'Slovakia',
    'Slovenia',
    'Solomon Islands',
    'Somalia',
    'South Africa',
    'South Korea',
    'South Sudan',
    'Spain',
    'Sri Lanka',
    'Sudan',
    'Suriname',
    'Sweden',
    'Switzerland',
    'Syria',
    'Taiwan',
    'Tajikistan',
    'Tanzania',
    'Thailand',
    'Timor-Leste',
    'Togo',
    'Tonga',
    'Trinidad and Tobago',
    'Tunisia',
    'Turkey',
    'Turkmenistan',
    'Tuvalu',
    'Uganda',
    'Ukraine',
    'United Arab Emirates',
    'United Kingdom',
    'United States',
    'Uruguay',
    'Uzbekistan',
    'Vanuatu',
    'Vatican City',
    'Venezuela',
    'Vietnam',
    'Yemen',
    'Zambia',
    'Zimbabwe'
  ]::text[]), false)
$countries$;
grant execute on function public.is_supported_country(text) to anon, authenticated;

do $worldwide$
declare
  r record;
  new_expr text;
  new_def text;
  changed integer := 0;
  -- How PostgreSQL stores "location in ('Uganda', 'Botswana')" inside a policy or constraint.
  stored_form constant text := '\(?(\w+) = ANY \(ARRAY\[''Uganda''::text, ''Botswana''::text\]\)\)?';
begin
  -- Row-level security policies on members.
  for r in
    select policyname, cmd, qual, with_check from pg_policies
    where schemaname = 'public' and tablename = 'members'
      and (coalesce(qual, '') like '%Botswana%' or coalesce(with_check, '') like '%Botswana%')
  loop
    if coalesce(r.qual, '') like '%Botswana%' then
      new_expr := regexp_replace(r.qual, stored_form, 'public.is_supported_country(\1)', 'g');
      if new_expr like '%Botswana%' then
        raise exception 'Policy "%" uses the country list in an unexpected form; nothing was changed. Rule: %', r.policyname, r.qual;
      end if;
      execute format('alter policy %I on public.members using (%s)', r.policyname, new_expr);
    end if;
    if coalesce(r.with_check, '') like '%Botswana%' then
      new_expr := regexp_replace(r.with_check, stored_form, 'public.is_supported_country(\1)', 'g');
      if new_expr like '%Botswana%' then
        raise exception 'Policy "%" uses the country list in an unexpected form; nothing was changed. Rule: %', r.policyname, r.with_check;
      end if;
      execute format('alter policy %I on public.members with check (%s)', r.policyname, new_expr);
    end if;
    changed := changed + 1;
    raise notice 'Opened policy "%" to all supported countries', r.policyname;
  end loop;

  -- CHECK constraints on members (if one was ever added by hand).
  for r in
    select conname, pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid = 'public.members'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%Botswana%'
  loop
    new_def := regexp_replace(r.def, stored_form, 'public.is_supported_country(\1)', 'g');
    if new_def like '%Botswana%' then
      raise exception 'Constraint "%" uses the country list in an unexpected form; nothing was changed. Rule: %', r.conname, r.def;
    end if;
    execute format('alter table public.members drop constraint %I', r.conname);
    execute format('alter table public.members add constraint %I %s', r.conname, new_def);
    changed := changed + 1;
    raise notice 'Opened constraint "%" to all supported countries', r.conname;
  end loop;

  -- Functions (for example the trigger that creates a profile after email confirmation).
  for r in
    select p.oid, p.proname, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname <> 'is_supported_country'
      and p.prosrc like '%''Botswana''%'
  loop
    new_def := regexp_replace(r.def, '([\w.]+) not in \(''Uganda'', ''Botswana''\)', 'not public.is_supported_country(\1)', 'g');
    new_def := regexp_replace(new_def, '([\w.]+) in \(''Uganda'', ''Botswana''\)', 'public.is_supported_country(\1)', 'g');
    if new_def like '%''Botswana''%' then
      raise exception 'Function % uses the country list in an unexpected form; nothing was changed.', r.proname;
    end if;
    execute new_def;
    changed := changed + 1;
    raise notice 'Opened function % to all supported countries', r.proname;
  end loop;

  raise notice 'Worldwide update finished: % rule(s) updated.', changed;
end
$worldwide$;

commit;

-- Quick check (should return true, true, false):
select public.is_supported_country('Kenya') as kenya,
       public.is_supported_country('Uganda') as uganda,
       public.is_supported_country('Atlantis') as made_up;
