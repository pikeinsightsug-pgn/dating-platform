-- Lets the owner console's Growth dashboard count message activity. The owner function
-- (admin-members, service_role) reads only who messaged whom and when; it never reads message
-- text for the dashboard. Members' own access is unchanged. Additive and safe to rerun.
grant select on public.member_messages to service_role;
