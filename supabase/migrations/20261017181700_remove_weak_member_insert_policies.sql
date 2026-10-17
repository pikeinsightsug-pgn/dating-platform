-- Remove legacy permissive INSERT policies that bypass the canonical member registration checks.
-- The existing "public can register members" policy retains public signup while enforcing
-- adult age, valid required profile fields, approved = false, and caller-owned user_id.
DROP POLICY IF EXISTS "Allow public member registration" ON public.members;
DROP POLICY IF EXISTS "Allow adult member registrations" ON public.members;
