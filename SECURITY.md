# Keeping P.K CONNECT safe

## Already built in

- Every member feature runs through database rules (row-level security). Members can only read and
  change their own profile, cannot approve themselves, cannot read anyone's email, phone or partner
  preferences, and cannot see or message anyone until the owner approves them.
- Only the owner email set as `ADMIN_EMAIL` can use the owner console; the server-side key never
  reaches the browser.
- Members can block and report anyone. Messages and reports are rate-limited.
- Only the official account can use names such as "Official", "Founder", "Admin" or "P.K Connect".
- Every page carries a Content-Security-Policy: code runs only from this site (the Supabase library
  is self-hosted in `assets/vendor/`, an exact copy of the pinned release), pages talk only to this
  project's Supabase, and plugins, form hijacking and `<base>` tricks are blocked.
- Member pages and the owner console refuse to run inside another website's frame (clickjacking).
- GitHub secret scanning and push protection are on; Dependabot checks the deploy actions weekly.
- The owner function deploys only from `main`.

## Settings only the owner can switch on

1. **2-Step Verification** on every account that controls the platform:
   - Google accounts `pikeinsightsug@gmail.com` and `pikeokello@gmail.com`
   - GitHub (Settings → Password and authentication → Two-factor authentication)
   - Supabase (Account → Security → Multi-factor authentication)
2. **Strong, unique passwords** for the owner console and the official account (12+ characters,
   never reused). Use a password manager.
3. **Supabase → Authentication → Sign In / Providers → Email:** keep **Confirm email** on, and set
   the minimum password length to at least 8.
4. **Supabase → Authentication → Rate Limits:** keep the defaults or lower them.
5. **GitHub → Settings → Branches:** add a rule for `main` that requires a pull request before
   merging, so nothing reaches the live site by accident.
6. **Never share** the Supabase service-role key, the `SUPABASE_ACCESS_TOKEN`, or any password in
   chat, email or code. If one may have leaked, regenerate it in Supabase straight away.
7. Review **Open member reports** in `/admin/` regularly, and remove any profile that asks for money.
