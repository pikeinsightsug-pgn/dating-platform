# Member registration and owner approval setup

The website is static on GitHub Pages and uses the existing Supabase Auth project. Registration creates an Auth user first. The database trigger writes the private `members` row with the trusted Auth user ID when the email is confirmed (or immediately if confirmation is disabled). The profile remains unapproved until an owner reviews it. After confirmation, the member signs in to the private dashboard.

The setup is additive. It does not remove, truncate, relink, approve, or overwrite existing member records. The Auth trigger runs only for signups marked by the website as member registrations; it does not create profiles for owner accounts. Payments, automatic charging, referral commissions and paid features remain disabled. Discovery and private messaging are limited to signed-in members whose profiles the owner has approved.

## Before enabling registration

The repository does not include the original `public.members` table creation or access to the live project schema. Confirm in the Supabase Table Editor that the existing `public.members` table has its core identity/profile columns, especially `id`, `first_name`, `age`, `gender`, and `created_at`. The setup files add `user_id`, `location`, `city`, `relationship_goal`, `bio`, `interests`, `partner_preference`, `profile_photo_url`, and `approved` when missing; they deliberately do not guess or recreate the existing table.

In the Supabase SQL Editor, review and apply these checked-in files in order:

1. `supabase/registration_setup.sql`
2. `supabase/launch_features_secure.sql`

Both scripts are additive and safe to rerun. They preserve existing rows. The final RLS policy allows new adult profiles only for Uganda or Botswana, forces new rows to remain unapproved, and requires authenticated profiles to link to the current user's Auth ID. Members can read and update their own profile. Column grants prevent members from changing `user_id`, `approved`, or system-managed fields. Public visitors receive no member read access.

If the live `members` table differs from the listed core columns, stop before applying and reconcile the migration with the live schema; do not drop or recreate the table.

## Supabase Auth URL configuration

In **Authentication → URL Configuration**:

- Set **Site URL** to `https://pikeinsightsug-pgn.github.io/dating-platform/`.
- Add `https://pikeinsightsug-pgn.github.io/dating-platform/account.html` to **Redirect URLs** for email confirmation.
- Add `https://pikeinsightsug-pgn.github.io/dating-platform/account.html?mode=recovery` to **Redirect URLs** for password reset.

Keep the project's email confirmation setting as intended. The page explains when the member must confirm before logging in. Password reset responses do not reveal whether an email is registered.

## Owner approval console

1. Create an owner account in Supabase Authentication using an email you control and confirm that email.
2. From the repository root, deploy the existing function with:
   `supabase login`
   `supabase functions deploy admin-members --project-ref cyvkpcwjkeifpvegwhpt`
   The function name is `admin-members`; its entry point is `supabase/functions/admin-members/index.ts`. Do not pass `--no-verify-jwt`.
3. Set only this custom Edge Function secret in the Supabase Dashboard under **Edge Functions → Secrets**:
   - `ADMIN_EMAIL`: the exact confirmed owner email address, in lowercase.
   Supabase provides `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to the function runtime. Do not try to add or override these reserved `SUPABASE_` variables as custom secrets. Never put the service-role key in HTML, GitHub Pages, or browser code.
4. This repository has no `supabase/config.toml`; Supabase's default `verify_jwt` setting is `true`. Keep JWT verification enabled. The function also validates the bearer token with Auth and checks that its confirmed email exactly matches `ADMIN_EMAIL` before using the server-side service-role key.
5. Publish the repository's `admin/` directory with GitHub Pages and open `/admin/`. The console stores only the project URL and public key in that browser's local storage.

## Verify the approval service

The endpoint is `https://cyvkpcwjkeifpvegwhpt.supabase.co/functions/v1/admin-members`. An unauthenticated request should be rejected with 401 because JWT verification is enabled; this checks that the route exists but does not verify secrets. A 404 means the function is not deployed at that endpoint. For a full check, sign in through `/admin/` with the confirmed owner account and load the registration list. A successful list confirms that the deployed code accepts the configured owner email and can read member rows and Auth account identifiers. A configuration error means the runtime or `ADMIN_EMAIL` setup needs attention. Do not share secret values when troubleshooting.

The owner endpoint returns up to 200 registrations and allows only explicit approve/reject actions. It displays the registered Auth email and Auth ID to the verified owner. Approval is never automatic. Confirm the email/ID match your test account before approving; skip any record without a linked Auth identity.

## Verification after setup

Use a new test email address you control. Create an account, confirm it if email confirmation is enabled, sign in, and confirm that exactly one row appears in `public.members` with the matching Auth user ID and `approved = false`. The database trigger creates the row at confirmation; the website checks for an existing row before using its safe fallback. Check that the dashboard can read and update that profile, cannot change the approval flag, and redirects to login after logout. Use the password reset link and confirm it returns to the recovery form.

Do not use a real member's email or alter an existing member record for testing.


## Member discovery and profile photos

After the existing registration and secure setup scripts are in place, review and apply
`supabase/member_discovery_photos.sql` in the Supabase SQL Editor. It reuses the private
`profile-photos` bucket, allows authenticated members to upload only to their own folder,
and permits approved members to view photos tied to approved profiles. The migration is
additive and does not change member records or approval states.

After applying it, test with two owner-controlled test accounts that have been manually
approved. Discovery requires an approved signed-in member. Uploads accept JPEG, PNG, and
WebP files up to 5 MiB. Do not use actual member accounts for tests.

The Google Form remains separate and unchanged. Its responses and uploaded files are not
imported or linked by this migration. Do not create duplicate profiles by importing its
responses automatically; first reconcile the form's response data with the live member
table and Auth accounts.


## Pilot launch: apply order and checks (October 2026)

First run `supabase/diagnostics_readonly.sql` in the SQL Editor. It is read-only and
reports counts only. It shows which of the files below are already live, and whether the
older discovery function is still blocking. Then apply, in this order, only the files
it reports as missing. Each one is additive and safe to rerun:

1. `supabase/registration_setup.sql`
2. `supabase/launch_features_secure.sql`
3. `supabase/member_discovery_photos.sql`. **Required for discovery.** The version of
   `browse_approved_profiles()` in step 2 fails on every call ("column reference age is
   ambiguous") and would also refuse to run below 100 approved members. This file replaces it.
4. `supabase/discovery_messaging_safety.sql`: filters, paging, profile details, private
   messaging, blocking and reporting. It also makes the signup trigger skip invalid
   metadata instead of failing the Auth request.
5. `supabase/legacy_registrations.sql`: a private archive table for the original form records.

Then redeploy the owner function (`supabase functions deploy admin-members --project-ref cyvkpcwjkeifpvegwhpt`)
so `/admin/` gains verified account linking and the report queue. Re-run the diagnostics and
check that line 6 is `false` and line 7 is `true`.

Every migration is exercised locally by `npm run test:db` (66 RLS assertions) and
`npm run test:e2e` (browser journeys). Both use a throwaway local Postgres, never this project.

## Deployment order for the pilot

1. Run `supabase/diagnostics_readonly.sql` (read-only) and keep the result.
2. Apply the missing SQL files in the order above.
3. Redeploy `admin-members`. The owner console now keeps working with an older
   deployment, but linking, test accounts, original registrations and reports need the
   new one.
4. Only then merge the pull request (GitHub Pages publishes `main`).
5. Authentication → URL Configuration: keep **Site URL** as
   `https://pikeinsightsug-pgn.github.io/dating-platform/` and make sure **Redirect URLs**
   include `https://pikeinsightsug-pgn.github.io/dating-platform/account.html` and
   `https://pikeinsightsug-pgn.github.io/dating-platform/account.html?mode=recovery`.
   Invitation and confirmation links that land on the homepage are forwarded to
   `account.html`, where invited people choose their password.

## Owner test accounts

In `/admin/`, use **Mark as my test account** on each of your own test profiles. Test accounts
see and message only other test accounts, genuine members never see them, and they do not
count as genuine members. Members cannot change this flag themselves.

## Restoring the original Google Form registrations

Nothing here creates, merges, links or approves a profile automatically.

1. **Export (read-only).**
   - `members.csv`: Table Editor → `members` → Export → Export table as CSV.
   - `auth.csv`: SQL Editor → `select id, email, phone, email_confirmed_at, created_at from auth.users;`
     → Download CSV.
2. **Compare.** On your own computer:
   `node tools/reconcile-registrations.mjs --form responses.csv --members members.csv --auth auth.csv`
   Output in `reconciliation-output/` is counts plus a per-row status with no names, contacts or
   photo links. Add `--include-contacts` only when you need a private follow-up sheet. Matches
   use email or phone only. Shared contacts and name resemblances are flagged for review,
   never merged.
3. **Archive the originals.** Apply `supabase/legacy_registrations.sql`, run the tool again with
   `--archive-sql`, and run `reconciliation-output/archive-original-registrations.sql` in the SQL
   Editor. Every original answer, including photo links, referral codes and dates, is kept in
   the private `legacy_registrations` table. Rerunning skips rows already archived.
4. **Help each person activate.** Contact them on the WhatsApp/phone number they gave.
   - **No profile in the app** (most of the original 47): send them
     `https://pikeinsightsug-pgn.github.io/dating-platform/account.html` to register with their
     own email. Ask which email they used.
   - **An old profile exists without an account:** Authentication → Users → **Invite user** with
     their email. The invitation creates no profile, so there is no duplicate. They choose a
     password from the link. Then use **Link verified account** on their old profile in `/admin/`.
5. **Link the original.** In `/admin/` → Original registrations, choose the person's member profile,
   confirm you verified them, and **Link to profile**. This records the match only.
6. **Approve** each verified, eligible adult separately with **Approve**. The genuine approved
   count excludes your test accounts.

Photos from the form remain in your Google Drive. Ask each person to upload their photo in
the app (or for consent before you add it); do not copy them automatically.

Approved members see only approved, linked, 18+ profiles. Pending members see their own profile
and an explanation. Accounts without a profile see a recovery screen that shows the email
address to give the owner.
