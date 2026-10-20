#!/usr/bin/env bash
# Applies every checked-in migration to a throwaway local Postgres database and runs
# the RLS/behaviour tests as the anon and authenticated roles.
#
# Usage: PGHOST=/path/to/socket PGPORT=5432 PGUSER=postgres tests/db/run-db-tests.sh
# Needs a local PostgreSQL 15+ superuser. Never point this at the live Supabase project.
set -euo pipefail
cd "$(dirname "$0")/../.."

DB="${TEST_DB:-dating_platform_test}"
psql_q() { psql -v ON_ERROR_STOP=1 -q -X "$@"; }

psql_q -d postgres -c "drop database if exists $DB" -c "create database $DB"
psql_q -d "$DB" -c "set client_min_messages = warning" -f tests/db/supabase_stub.sql
for file in \
  supabase/registration_setup.sql \
  supabase/launch_features_secure.sql \
  supabase/member_discovery_photos.sql \
  supabase/discovery_messaging_safety.sql \
  supabase/discovery_messaging_safety.sql \
  supabase/legacy_registrations.sql; do
  # The newest migration runs twice to prove it is safe to rerun.
  PGOPTIONS="-c client_min_messages=warning" psql_q -d "$DB" -f "$file"
done

PGOPTIONS="-c client_min_messages=notice" psql -v ON_ERROR_STOP=1 -X -q -d "$DB" -f tests/db/rls_tests.sql 2>&1 \
  | sed -n 's/^psql:[^ ]* NOTICE:  //p; s/^psql:.*ERROR:  /ERROR: /p'
status=${PIPESTATUS[0]}

# The read-only diagnostics must run on the fully migrated database and on one where
# none of the setup files were applied.
psql_q -d "$DB" -f supabase/diagnostics_readonly.sql > /dev/null && echo "PASS: diagnostics run on the migrated database" || status=1
psql_q -d postgres -c "drop database if exists ${DB}_bare" -c "create database ${DB}_bare"
psql_q -d "${DB}_bare" -c "set client_min_messages = warning" -f tests/db/supabase_stub.sql
psql_q -d "${DB}_bare" -f supabase/diagnostics_readonly.sql > /dev/null && echo "PASS: diagnostics run before any setup file is applied" || status=1
psql_q -d postgres -c "drop database if exists ${DB}_bare"
psql_q -d postgres -c "drop database if exists $DB"
exit "$status"
