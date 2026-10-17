# Member registration and owner approval setup

The website is static on GitHub Pages and uses the existing Supabase Auth project. Registration creates an Auth user first. The database trigger writes the private `members` row with the trusted Auth user ID when the email is confirmed (or immediately if confirmation is disabled). The profile remains unapproved until an owner reviews it. After confirmation, the member signs in to the private dashboard.

The setup is additive. It does not remove, truncate, relink, approve, or overwrite existing member records. The Auth trigger runs only for signups marked by the website as member registrations; it does not create profiles for owner accounts. Payments, automatic charging, referral commissions, member discovery, and unrestricted messaging remain disabled.

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
2. Deploy `supabase/functions/admin-members/index.ts` as the `admin-members` Edge Function with JWT verification enabled.
3. Configure these Edge Function secrets in the Supabase project:
   - `ADMIN_EMAIL`: the exact owner email address, in lowercase.
   - `SUPABASE_URL`: the project URL.
   - `SUPABASE_ANON_KEY`: the public anon/publishable key.
   - `SUPABASE_SERVICE_ROLE_KEY`: the service-role key. Store this only as an Edge Function secret; never put it in HTML, GitHub Pages, or browser code.
4. The function independently validates the bearer token and exact confirmed owner email before using the service-role key.
5. Publish the repository's `admin/` directory with GitHub Pages and open `/admin/`. The console stores only the project URL and public key in that browser's local storage.

The owner endpoint returns up to 200 registrations and allows only explicit approve/reject actions. Approval is not automatic. Review a person's age and registration before approval.

## Verification after setup

Use a new test email address you control. Create an account, confirm it if email confirmation is enabled, sign in, and confirm that exactly one row appears in `public.members` with the matching Auth user ID and `approved = false`. The database trigger creates the row at confirmation; the website checks for an existing row before using its safe fallback. Check that the dashboard can read and update that profile, cannot change the approval flag, and redirects to login after logout. Use the password reset link and confirm it returns to the recovery form.

Do not use a real member's email or alter an existing member record for testing.
