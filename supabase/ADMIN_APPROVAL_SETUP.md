# Secure owner approval console

This adds an owner-only review interface without exposing member records to the public website. It does not approve any existing registration automatically, delete records, or activate payments.

## Important prerequisites

1. Confirm the project URL and public publishable/anon key used by the public site.
2. Create an owner account in Supabase Authentication using an email you control and confirm that email.
3. Deploy the Edge Function in `supabase/functions/admin-members/index.ts`.
4. Configure these Edge Function secrets in the Supabase project:
   - `ADMIN_EMAIL`: the exact email address of the owner account, in lowercase.
   - `SUPABASE_URL`: the project URL.
   - `SUPABASE_ANON_KEY`: the project's public anon/publishable key.
   - `SUPABASE_SERVICE_ROLE_KEY`: the project's service-role key. Set this only as an Edge Function secret; never put it in HTML, GitHub Pages, or a browser.
5. Deploy the function with JWT verification enabled. The function independently validates the bearer token and exact owner email before using the service-role key.
6. Publish the repository's `admin/` directory with GitHub Pages. Open `/admin/` on the published site and sign in with the owner account.
7. Enter the project URL and public key in the owner console. The console saves only those public values in that browser's local storage.

## Function behavior

- `list`: returns at most 200 registrations and safe profile fields, plus counts for the records returned.
- `approve`: sets `approved=true` for the selected member only after an explicit confirmation in the owner UI.
- `reject`: sets `approved=false` for the selected member only after an explicit confirmation.
- No public signup policy is changed by these files.
- Existing records are not changed until the owner clicks an action.
- Payment processing is not implemented.

## Notes

The function uses the service-role key server-side because the current public registration policy intentionally does not grant clients permission to read or update member records. Never relax Row Level Security or put the service-role key in the browser to make the dashboard work.

Before approving a person, the owner should review the registration and verify that it is genuine and that the person is 18 or older. The list endpoint is capped at 200 rows; if the community grows beyond that, implement server-side pagination before relying on the counts as a full database total.
