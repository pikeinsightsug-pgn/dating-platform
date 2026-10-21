-- READ-ONLY audit of Data API permissions (Supabase change of 30 October 2026).
-- Lists, for each table in the public schema, whether Row Level Security is on and what
-- visitors (anon), signed-in members (authenticated) and server functions (service_role)
-- may do; then which member functions each role may call.
-- Shows object names and yes/no values only: no member data is read.
with t as (
  select c.oid, c.relname, c.relrowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
)
select 'table' as kind, relname as name,
  case when relrowsecurity then 'on' else 'OFF' end as rls,
  concat_ws(' ',
    case when has_table_privilege('anon', oid, 'select') then 'select' end,
    case when has_table_privilege('anon', oid, 'insert') then 'insert' end,
    case when has_table_privilege('anon', oid, 'update') then 'update' end,
    case when has_table_privilege('anon', oid, 'delete') then 'delete' end) as anon,
  concat_ws(' ',
    case when has_table_privilege('authenticated', oid, 'select') or has_any_column_privilege('authenticated', oid, 'select') then 'select' end,
    case when has_table_privilege('authenticated', oid, 'insert') then 'insert' end,
    case when has_table_privilege('authenticated', oid, 'update') or has_any_column_privilege('authenticated', oid, 'update') then 'update(some columns)' end,
    case when has_table_privilege('authenticated', oid, 'delete') then 'delete' end) as authenticated,
  concat_ws(' ',
    case when has_table_privilege('service_role', oid, 'select') then 'select' end,
    case when has_table_privilege('service_role', oid, 'insert') then 'insert' end,
    case when has_table_privilege('service_role', oid, 'update') then 'update' end,
    case when has_table_privilege('service_role', oid, 'delete') then 'delete' end) as service_role
from t
union all
select 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', '',
  case when has_function_privilege('anon', p.oid, 'execute') then 'execute' else '' end,
  case when has_function_privilege('authenticated', p.oid, 'execute') then 'execute' else '' end,
  case when has_function_privilege('service_role', p.oid, 'execute') then 'execute' else '' end
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') -- skip extension functions
order by 1 desc, 2;
