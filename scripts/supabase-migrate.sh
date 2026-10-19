#!/usr/bin/env bash
# Apply Supabase migrations (and optionally deploy edge functions / run DB tests).
#
# Usage:
#   scripts/supabase-migrate.sh local              # reset local DB, apply all migrations, run pgTAP
#   scripts/supabase-migrate.sh local --no-reset   # apply only pending migrations to local DB
#   scripts/supabase-migrate.sh remote             # push pending migrations to the linked cloud project
#   scripts/supabase-migrate.sh remote --dry-run   # show what would be pushed
#   scripts/supabase-migrate.sh remote --psql      # push via psql + SUPABASE_DB_URL (when the CLI hangs)
#   scripts/supabase-migrate.sh pending            # list local migrations the remote has not recorded
#   scripts/supabase-migrate.sh repair             # fix history rows recorded under dashboard timestamps
#   scripts/supabase-migrate.sh mark-applied <ver>... # record already-live migrations without running them
#   scripts/supabase-migrate.sh functions          # deploy edge functions to the linked project
#   scripts/supabase-migrate.sh status             # list local vs remote migration state
#
# Remote targets need the project linked once:
#   supabase link --project-ref <ref>
# or SUPABASE_PROJECT_REF set (the script links for you). SUPABASE_DB_PASSWORD
# is passed through to the CLI when set, so no interactive prompt is needed.
#
# pending, repair, mark-applied and --psql read the history table directly and need psql plus
#   SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@<pooler-host>:5432/postgres
# (Project Settings -> Database -> Connection string, "Session pooler"). macOS: brew install libpq.
#
# When migrations were applied from the dashboard or an AI tool, fix the history before pushing:
#   pending -> repair -> mark-applied <the versions pending lists that are already live> ->
#   remote --psql --dry-run -> remote --psql
#
# CLI_TIMEOUT (seconds, default 180) stops a remote CLI call that hangs on connecting.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MIGRATIONS_DIR="supabase/migrations"
CLI_TIMEOUT="${CLI_TIMEOUT:-180}"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
info() { printf '\033[36m==> %s\033[0m\n' "$*"; }

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

confirm() {
  printf '%s [y/N] ' "$1"
  read -r answer
  [[ "$answer" == "y" || "$answer" == "Y" ]]
}

# Runs a command, killing it after CLI_TIMEOUT seconds. macOS has no `timeout`, so use perl.
with_timeout() {
  local rc=0
  perl -e 'alarm shift; exec @ARGV or die "exec failed: $!\n"' "$CLI_TIMEOUT" "$@" || rc=$?
  if [[ "$rc" -eq 142 ]]; then
    red "Timed out after ${CLI_TIMEOUT}s: $*"
    yellow "The Supabase CLI can hang while connecting to the remote database. Retry, raise"
    yellow "CLI_TIMEOUT, or use the psql path: SUPABASE_DB_URL=... $0 remote --psql"
  fi
  return "$rc"
}

require_cli() {
  if ! command -v supabase >/dev/null 2>&1; then
    red "Supabase CLI not found. Install: brew install supabase/tap/supabase (Windows: scoop install supabase)"
    exit 1
  fi
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    red "Docker is not running. Local Supabase needs Docker Desktop (or OrbStack/Colima)."
    exit 1
  fi
}

require_psql() {
  if ! command -v psql >/dev/null 2>&1; then
    red "psql not found. macOS: brew install libpq && brew link --force libpq. Windows: install PostgreSQL client tools."
    exit 1
  fi
  if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
    red "SUPABASE_DB_URL is not set. Copy the Session pooler connection string from"
    red "Project Settings -> Database and export it (keep it out of .env files you share)."
    exit 1
  fi
  if [[ "$SUPABASE_DB_URL" != postgres://* && "$SUPABASE_DB_URL" != postgresql://* ]]; then
    red "SUPABASE_DB_URL must be a postgresql:// connection string (the Session pooler URI)."
    exit 1
  fi
  # Catch a copied example instead of the real URI: <pooler-host>, [YOUR-PASSWORD] and the like.
  if [[ "$SUPABASE_DB_URL" == *"<"* || "$SUPABASE_DB_URL" == *">"* || "$SUPABASE_DB_URL" == *"["* \
        || "$SUPABASE_DB_URL" == *"YOUR-PASSWORD"* || "$SUPABASE_DB_URL" == *"REAL_PASSWORD"* ]]; then
    red "SUPABASE_DB_URL still contains a placeholder (<...>, [YOUR-PASSWORD], ...)."
    red "Paste the real Session pooler URI from the dashboard (Connect -> Session pooler) and put"
    red "your database password in it."
    exit 1
  fi
  load_history
}

ensure_linked() {
  if [[ -f supabase/.temp/project-ref ]]; then
    return
  fi
  if [[ -n "${SUPABASE_PROJECT_REF:-}" ]]; then
    info "Linking project ${SUPABASE_PROJECT_REF}"
    with_timeout supabase link --project-ref "$SUPABASE_PROJECT_REF" ${SUPABASE_DB_PASSWORD:+--password "$SUPABASE_DB_PASSWORD"}
  else
    red "Project not linked. Run: supabase link --project-ref <ref>  (or set SUPABASE_PROJECT_REF)"
    exit 1
  fi
}

list_migrations() {
  info "Migrations in ${MIGRATIONS_DIR}:"
  ls -1 "$MIGRATIONS_DIR"/*.sql | sed "s|^${MIGRATIONS_DIR}/|  |"
}

# "0019_security_review_fixes.sql" -> "0019" / "security_review_fixes"
file_version() { basename "$1" .sql | cut -d_ -f1; }
file_name() { basename "$1" .sql | cut -d_ -f2-; }

psql_remote() {
  psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -q "$@"
}

# Remote history, read once by require_psql. Read here, not inside $(...) or <(...), because a
# failure there is silently ignored and an unreachable database would look like an empty history.
REMOTE_HISTORY=""
load_history() {
  local err
  err="$(mktemp)"
  if ! REMOTE_HISTORY="$(psql_remote -At -c "SELECT version || '|' || COALESCE(name, '') FROM supabase_migrations.schema_migrations ORDER BY version" 2>"$err")"; then
    red "Could not read the remote migration history:"
    sed 's/^/  /' "$err" >&2
    rm -f "$err"
    red "Check SUPABASE_DB_URL: Session pooler URI, port 5432, correct database password."
    exit 1
  fi
  rm -f "$err"
}

# version|name for every row in the remote history table.
remote_history() {
  [[ -n "$REMOTE_HISTORY" ]] && printf '%s\n' "$REMOTE_HISTORY"
  return 0
}

recorded_versions() { remote_history | cut -d'|' -f1; }

# Local migration files whose version is not recorded remotely, in order.
pending_files() {
  local recorded file
  recorded="$(recorded_versions)"
  for file in "$MIGRATIONS_DIR"/*.sql; do
    if ! grep -qx "$(file_version "$file")" <<<"$recorded"; then
      printf '%s\n' "$file"
    fi
  done
}

# Remote rows recorded under a dashboard/MCP timestamp version (14 digits) whose name matches a
# local file that carries a different version. Prints "remote_version|local_version|name".
drifted_rows() {
  local row version name file
  while IFS='|' read -r version name; do
    [[ "$version" =~ ^[0-9]{14}$ ]] || continue
    for file in "$MIGRATIONS_DIR"/*_"${name}".sql; do
      [[ -f "$file" ]] || continue
      printf '%s|%s|%s\n' "$version" "$(file_version "$file")" "$name"
    done
  done < <(remote_history)
}

# Remote rows recorded under a timestamp version whose name matches no local file. They are left
# alone; the local file that holds the same change must be recorded with mark-applied.
unmatched_rows() {
  local version name
  while IFS='|' read -r version name; do
    [[ "$version" =~ ^[0-9]{14}$ ]] || continue
    compgen -G "$MIGRATIONS_DIR/*_${name}.sql" >/dev/null || printf '%s|%s\n' "$version" "$name"
  done < <(remote_history)
}

# Writes the history-row insert used by push_with_psql and mark-applied. psql only substitutes
# variables in -f files, not -c strings, so the insert is a file.
make_record_file() {
  RECORD_FILE="$(mktemp)"
  trap 'rm -f "$RECORD_FILE"' EXIT
  printf '%s\n' "INSERT INTO supabase_migrations.schema_migrations (version, name, statements) VALUES (:'mig_version', :'mig_name', ARRAY[:'mig_sql']);" >"$RECORD_FILE"
}

cmd_local() {
  require_cli
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

cmd_pending() {
  require_psql
  local files drift
  drift="$(drifted_rows)"
  if [[ -n "$drift" ]]; then
    yellow "History rows recorded under timestamps (run '$0 repair' before pushing):"
    while IFS='|' read -r remote local name; do
      yellow "  ${remote} -> ${local}_${name}"
    done <<<"$drift"
  fi
  local unmatched
  unmatched="$(unmatched_rows)"
  if [[ -n "$unmatched" ]]; then
    yellow "History rows under timestamps that match no local file name:"
    while IFS='|' read -r remote name; do
      yellow "  ${remote} (${name})"
    done <<<"$unmatched"
  fi
  files="$(pending_files)"
  if [[ -z "$files" ]]; then
    green "Remote history has every local migration."
    return
  fi
  info "Local migrations not recorded on the remote:"
  sed "s|^${MIGRATIONS_DIR}/|  |" <<<"$files"
  if [[ -n "$drift" || -n "$unmatched" ]]; then
    yellow "Some of these may already be live, applied under a timestamp version. Run 'repair' first,"
    yellow "then record the ones that are already live with '$0 mark-applied <version>...'."
    yellow "Pushing a live migration again can replace newer functions with older definitions."
  fi
}

cmd_repair() {
  require_psql
  local drift
  drift="$(drifted_rows)"
  if [[ -z "$drift" ]]; then
    green "No timestamp-versioned history rows match local files. Nothing to repair."
    return
  fi
  info "These history rows will be renumbered to match the local files:"
  while IFS='|' read -r remote local name; do
    printf '  %s (%s) -> %s\n' "$remote" "$name" "$local"
  done <<<"$drift"
  yellow "Only the history table changes. Check that each migration's changes really are live first."
  confirm "Renumber these history rows on the REMOTE project?" || { red "Aborted."; exit 1; }

  local sql="BEGIN;"
  while IFS='|' read -r remote local name; do
    sql+=" UPDATE supabase_migrations.schema_migrations SET version = '${local}' WHERE version = '${remote}' AND name = '${name}';"
  done <<<"$drift"
  sql+=" COMMIT;"
  psql_remote -c "$sql"
  green "History repaired."
}

# Records local migrations as applied without running them, for changes that are already live
# (applied from the dashboard under another name). The same as `supabase migration repair --status applied`.
cmd_mark_applied() {
  if [[ $# -eq 0 ]]; then
    red "Usage: $0 mark-applied <version>...   (e.g. 0023 0024)"
    exit 1
  fi
  require_psql
  local v matches files=() recorded
  recorded="$(recorded_versions)"
  for v in "$@"; do
    if grep -qx "$v" <<<"$recorded"; then
      yellow "  ${v} is already recorded on the remote; skipping."
      continue
    fi
    matches="$(compgen -G "$MIGRATIONS_DIR/${v}_*.sql" || true)"
    if [[ -z "$matches" ]]; then
      red "No local migration file has version ${v}."
      exit 1
    fi
    if [[ "$(wc -l <<<"$matches")" -gt 1 ]]; then
      red "More than one local file has version ${v}:"
      sed 's/^/  /' <<<"$matches"
      exit 1
    fi
    files+=("$matches")
  done
  if [[ ${#files[@]} -eq 0 ]]; then
    green "Nothing to record."
    return
  fi
  info "These will be recorded as applied WITHOUT running them:"
  printf '  %s\n' "${files[@]#"$MIGRATIONS_DIR/"}"
  yellow "Only do this for migrations whose changes are already live on the database."
  confirm "Record them in the REMOTE history?" || { red "Aborted."; exit 1; }

  make_record_file
  local file
  for file in "${files[@]}"; do
    psql_remote \
      -v mig_version="$(file_version "$file")" \
      -v mig_name="$(file_name "$file")" \
      -v mig_sql="$(cat "$file")" \
      -f "$RECORD_FILE"
  done
  green "Recorded ${#files[@]} migration(s) as applied."
}

# Applies each pending file in its own transaction and records it, exactly as `supabase db push` would.
push_with_psql() {
  require_psql
  if [[ -n "$(drifted_rows)" ]]; then
    red "History has timestamp-versioned rows that match local files. Run '$0 repair' first,"
    red "otherwise those migrations would run a second time."
    exit 1
  fi
  local files file
  files="$(pending_files)"
  if [[ -z "$files" ]]; then
    green "Nothing to push: remote history has every local migration."
    return
  fi
  info "Pending migrations (each runs in full):"
  sed "s|^${MIGRATIONS_DIR}/|  |" <<<"$files"
  if [[ -n "$(unmatched_rows)" ]]; then
    yellow "The history also has timestamp rows that match no local file (see '$0 pending')."
    yellow "If any file above is already live under one of them, abort and run '$0 mark-applied' for it."
  fi
  if [[ "${1:-}" == "--dry-run" ]]; then
    return
  fi
  confirm "Apply these to the REMOTE database? This changes the live database." || { red "Aborted."; exit 1; }

  make_record_file

  while IFS= read -r file; do
    info "Applying $(basename "$file")"
    # -1 wraps both files in one transaction: the migration and its history row commit together.
    psql_remote -1 \
      -v mig_version="$(file_version "$file")" \
      -v mig_name="$(file_name "$file")" \
      -v mig_sql="$(cat "$file")" \
      -f "$file" \
      -f "$RECORD_FILE"
  done <<<"$files"
  green "Remote migrations applied."
}

cmd_remote() {
  if [[ " $* " == *" --psql "* ]]; then
    local rest=()
    for a in "$@"; do [[ "$a" == "--psql" ]] || rest+=("$a"); done
    push_with_psql "${rest[@]+"${rest[@]}"}"
    return
  fi
  require_cli
  ensure_linked
  list_migrations
  yellow "If the CLI reports 'Remote migration versions not found', the history has dashboard rows."
  yellow "Fix it with '$0 pending', 'repair' and 'mark-applied', then push with '$0 remote --psql'."
  if [[ "${1:-}" == "--dry-run" ]]; then
    info "Dry run: migrations that would be pushed"
    with_timeout supabase db push --dry-run ${SUPABASE_DB_PASSWORD:+--password "$SUPABASE_DB_PASSWORD"}
    return
  fi
  confirm "Push pending migrations to the LINKED REMOTE project? This changes the live database." \
    || { red "Aborted."; exit 1; }
  with_timeout supabase db push ${SUPABASE_DB_PASSWORD:+--password "$SUPABASE_DB_PASSWORD"}
  green "Remote migrations applied."
}

cmd_functions() {
  require_cli
  ensure_linked
  for fn in supabase/functions/*/; do
    name="$(basename "$fn")"
    info "Deploying edge function: $name"
    with_timeout supabase functions deploy "$name"
  done
  green "Edge functions deployed."
}

cmd_status() {
  require_cli
  ensure_linked
  with_timeout supabase migration list ${SUPABASE_DB_PASSWORD:+--password "$SUPABASE_DB_PASSWORD"}
}

case "${1:-}" in
  local) shift; cmd_local "$@" ;;
  remote) shift; cmd_remote "$@" ;;
  pending) shift; cmd_pending ;;
  repair) shift; cmd_repair ;;
  mark-applied) shift; cmd_mark_applied "$@" ;;
  functions) shift; cmd_functions ;;
  status) shift; cmd_status ;;
  -h|--help|*) usage ;;
esac
