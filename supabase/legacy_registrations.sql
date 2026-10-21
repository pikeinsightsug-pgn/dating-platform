-- Private, owner-only archive of the original Google Form / Airtable registrations.
-- Additive: creates one new table. It never creates, links, approves or edits member profiles.
-- Rows are loaded by the SQL that tools/reconcile-registrations.mjs generates, and every
-- original answer is kept verbatim in original_answers.
begin;

create table if not exists public.legacy_registrations (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('google_form', 'airtable', 'other')),
  source_row_hash text not null unique,
  submitted_at timestamptz,
  first_name text,
  age integer,
  country text,
  email_normalized text,
  phone_normalized text,
  referral_code text,
  original_answers jsonb not null,
  reconciliation_status text not null default 'unreviewed'
    check (reconciliation_status in ('unreviewed', 'matched_profile', 'needs_account', 'needs_profile', 'possible_duplicate', 'ineligible', 'incomplete', 'linked', 'declined')),
  matched_member_id uuid references public.members(id) on delete set null,
  owner_notes text,
  imported_at timestamptz not null default now()
);
create index if not exists legacy_registrations_email_idx on public.legacy_registrations(email_normalized);
create index if not exists legacy_registrations_phone_idx on public.legacy_registrations(phone_normalized);

-- Contains private contact details: no access for visitors or members. The owner reads it
-- in the Supabase Table Editor / SQL Editor, which use privileged roles.
alter table public.legacy_registrations enable row level security;
revoke all on public.legacy_registrations from public, anon, authenticated;
-- The owner console's server-side function (service_role) lists these records and records
-- the owner's review. Granted explicitly: from 30 October 2026 Supabase no longer gives new
-- public tables Data API permissions automatically. No insert or delete: rows are loaded and
-- kept through the SQL Editor only.
grant select, update on public.legacy_registrations to service_role;

commit;
