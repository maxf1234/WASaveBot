#!/usr/bin/env bash
# Runs the migration and the RLS test against a throwaway local Postgres.
# Needs the Postgres server binaries (initdb, pg_ctl) and psql.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bin="${PG_BIN:-$(dirname "$(ls /usr/lib/postgresql/*/bin/initdb | tail -1)")}"
dir="$(mktemp -d)"
port="${PGPORT:-54329}"
run() { if [ "$(id -u)" = 0 ]; then su postgres -c "$*"; else bash -c "$*"; fi; }
[ "$(id -u)" = 0 ] && chown postgres "$dir"
trap 'run "$bin/pg_ctl -D $dir/data -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT
run "$bin/initdb -D $dir/data -A trust -U postgres" >/dev/null
run "$bin/pg_ctl -D $dir/data -o \"-p $port -k $dir -c listen_addresses=''\" -w start" >/dev/null
q() { psql -v ON_ERROR_STOP=1 -q -h "$dir" -p "$port" -U postgres -d postgres -f "$1"; }
q "$here/supabase_shim.sql"
# Every migration in order, so the test also proves they apply to each other.
for m in "$here"/../migrations/*.sql; do q "$m"; done
q "$here/claim.sql"
q "$here/rls.sql"
