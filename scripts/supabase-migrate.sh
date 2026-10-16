#!/usr/bin/env bash
# Apply Supabase migrations (and optionally deploy edge functions / run DB tests).
#
# Usage:
#   scripts/supabase-migrate.sh local            # reset local DB, apply all migrations, run pgTAP
#   scripts/supabase-migrate.sh local --no-reset # apply only pending migrations to local DB
#   scripts/supabase-migrate.sh remote           # push pending migrations to the linked cloud project
#   scripts/supabase-migrate.sh remote --dry-run # show what would be pushed
#   scripts/supabase-migrate.sh functions        # deploy edge functions to the linked project
#   scripts/supabase-migrate.sh status           # list local vs remote migration state
#
# Remote targets need the project linked once:
#   supabase link --project-ref <ref>
# or SUPABASE_PROJECT_REF set (the script links for you). SUPABASE_DB_PASSWORD
# is passed through to the CLI when set, so no interactive prompt is needed.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
info() { printf '\033[36m==> %s\033[0m\n' "$*"; }

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

require_cli() {
  if ! command -v supabase >/dev/null 2>&1; then
    red "Supabase CLI not found. Install: brew install supabase/tap/supabase"
    exit 1
  fi
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    red "Docker is not running. Local Supabase needs Docker Desktop (or OrbStack/Colima)."
    exit 1
  fi
}

ensure_linked() {
  if [[ -f supabase/.temp/project-ref ]]; then
    return
  fi
  if [[ -n "${SUPABASE_PROJECT_REF:-}" ]]; then
    info "Linking project ${SUPABASE_PROJECT_REF}"
    supabase link --project-ref "$SUPABASE_PROJECT_REF" ${SUPABASE_DB_PASSWORD:+--password "$SUPABASE_DB_PASSWORD"}
  else
    red "Project not linked. Run: supabase link --project-ref <ref>  (or set SUPABASE_PROJECT_REF)"
    exit 1
  fi
}

list_migrations() {
  info "Migrations in supabase/migrations:"
  ls -1 supabase/migrations/*.sql | sed 's|^supabase/migrations/|  |'
}

cmd_local() {
  require_docker
  if ! supabase status >/dev/null 2>&1; then
    info "Starting local Supabase stack"
    supabase start
  fi
  list_migrations
  if [[ "${1:-}" == "--no-reset" ]]; then
    info "Applying pending migrations to local database"
    supabase migration up --local
  else
    info "Resetting local database and applying all migrations"
    supabase db reset --local
  fi
  info "Running pgTAP test suite"
  supabase test db
  green "Local database is up to date."
}

cmd_remote() {
  ensure_linked
  list_migrations
  if [[ "${1:-}" == "--dry-run" ]]; then
    info "Dry run: migrations that would be pushed"
    supabase db push --dry-run ${SUPABASE_DB_PASSWORD:+--password "$SUPABASE_DB_PASSWORD"}
    return
  fi
  printf 'Push pending migrations to the LINKED REMOTE project? This changes the live database. [y/N] '
  read -r answer
  if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
    red "Aborted."
    exit 1
  fi
  supabase db push ${SUPABASE_DB_PASSWORD:+--password "$SUPABASE_DB_PASSWORD"}
  green "Remote migrations applied."
}

cmd_functions() {
  ensure_linked
  for fn in supabase/functions/*/; do
    name="$(basename "$fn")"
    info "Deploying edge function: $name"
    supabase functions deploy "$name"
  done
  green "Edge functions deployed."
}

cmd_status() {
  ensure_linked
  supabase migration list ${SUPABASE_DB_PASSWORD:+--password "$SUPABASE_DB_PASSWORD"}
}

require_cli
case "${1:-}" in
  local) shift; cmd_local "$@" ;;
  remote) shift; cmd_remote "$@" ;;
  functions) shift; cmd_functions ;;
  status) shift; cmd_status ;;
  *) usage ;;
esac
