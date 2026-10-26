-- Safe additive setup for the expanded registration form.
-- This does not delete or overwrite existing member records.
alter table public.members
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists location text,
  add column if not exists city text,
  add column if not exists relationship_goal text,
  add column if not exists bio text,
  add column if not exists interests text,
  add column if not exists partner_preference text,
  add column if not exists profile_photo_url text,
  add column if not exists approved boolean not null default false;
update public.members set approved = false where approved is null;
alter table public.members alter column approved set default false;
alter table public.members alter column approved set not null;

-- Keep one account linked to at most one member profile.
create unique index if not exists members_user_id_unique
  on public.members(user_id) where user_id is not null;

-- Keep uploaded photos private. The website uploads to this exact bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-photos', 'profile-photos', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = false,
    file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

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

-- The unauthenticated signup form may create a member registration only.
alter table public.members enable row level security;
drop policy if exists "public can register members" on public.members;
create policy "public can register members"
on public.members for insert
to anon, authenticated
with check (
  age >= 18 and age <= 120
  and first_name is not null and length(trim(first_name)) between 1 and 80
  and gender in ('Woman', 'Man', 'Non-binary', 'Prefer not to say')
  and public.is_supported_country(location)
  and city is not null and length(trim(city)) between 1 and 100
  and relationship_goal in ('Serious relationship', 'Marriage', 'Friendship', 'Exploring connections')
  and bio is not null and length(trim(bio)) between 1 and 500
  and (interests is null or length(interests) <= 300)
  and (partner_preference is null or length(partner_preference) <= 500)
  and approved = false
  and ((auth.uid() is null and user_id is null) or user_id = auth.uid())
);

grant insert on table public.members to anon, authenticated;

-- Restrict anonymous uploads to the dedicated private photo bucket.
drop policy if exists "public can upload registration photos" on storage.objects;
create policy "public can upload registration photos"
on storage.objects for insert
to anon, authenticated
with check (bucket_id = 'profile-photos');

-- No public SELECT or DELETE policy is created for member photos.
