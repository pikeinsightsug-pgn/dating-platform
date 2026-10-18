# Paid registration — design only (NOT active)

Status: **proposal**. Nothing here is built, migrated or switched on. During testing the site
states that no payment is requested, and no code path asks for or checks payment.
Pricing, access codes and the payment provider still have to be decided by the owner.

## Where access is decided today

There is exactly one rule for using member features (discovery, profiles, messaging):

| Layer | Gate | File |
|---|---|---|
| Database (authoritative) | `public.require_approved_member()` / `current_approved_member_id()` — approved, 18+, linked account | `supabase/discovery_messaging_safety.sql`, `supabase/launch_features_secure.sql` |
| Browser (routing only) | `FYP.canUseMemberFeatures(profile)` | `assets/member-core.js` |

Paid access must be added to these two gates — never as a check in an individual page, which
could be bypassed by calling the database directly.

## Proposed model (requires a new migration, to be reviewed before it is written)

1. **`member_entitlements`** — one row per member and access grant:
   `member_id`, `kind` (`paid` | `complimentary_code` | `owner_grant`), `status`
   (`pending` | `active` | `revoked` | `expired`), `starts_at`, `ends_at`, `source_reference`
   (payment provider reference or code id), `created_by`. RLS: members read only their own rows;
   only the server (Edge Function with the service role) writes.
2. **`access_codes`** — complimentary codes for the original founding members:
   `code_hash` (store a hash, never the plain code), `intended_for` (e.g. a legacy registration id),
   `max_redemptions` (1), `redeemed_by_member_id`, `redeemed_at`, `expires_at`, `revoked_at`.
   A unique constraint on the redemption plus a single `redeem_access_code()` function prevents
   the same code being used twice, even with two simultaneous attempts.
3. **Payment verification** — a server-side Edge Function receives the payment provider's signed
   webhook, verifies the signature, and only then sets an entitlement to `active`. The browser is
   never trusted to report "payment succeeded".
4. **Gate change** — `require_approved_member()` would additionally require an active
   entitlement once the owner switches a setting on (for example a single-row
   `platform_settings.paid_access_required boolean default false`). Existing approved members and
   code holders would be granted entitlements first, so nobody is locked out by surprise.
5. **Owner control** — the `/admin/` console would list entitlements and codes, generate and
   revoke codes, and grant or revoke access, through the same owner-only Edge Function.

## What must happen before any of this is built

- Owner decides prices, currency (UGX/BWP), what is paid for, and refund rules.
- Choose a payment provider that supports Uganda and Botswana (mobile money matters).
- Review and approve the migration above; apply it with the same diagnostics-first process.
- Update the privacy notice and homepage wording before any payment is requested.
