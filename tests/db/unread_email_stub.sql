-- Local stand-ins for Supabase's pg_net, Vault and pg_cron, used only by run-db-tests.sh.
create schema if not exists extensions;
create schema if not exists net;
create table net.sent (id bigserial primary key, url text, headers jsonb, body jsonb);
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
  headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint
language sql as $$ insert into net.sent (url, headers, body) values (url, headers, body) returning id $$;
create schema if not exists vault;
create table vault.decrypted_secrets (name text primary key, decrypted_secret text);
create schema if not exists cron;
create table cron.job (jobname text primary key, schedule text, command text);
create function cron.schedule(job_name text, schedule text, command text) returns bigint
language sql as $$
  insert into cron.job values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command;
  select 1::bigint
$$;
