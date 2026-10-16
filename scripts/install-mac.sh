#!/usr/bin/env bash
# Install Smart Mess System and its toolchain on macOS.
#
# Usage:
#   scripts/install-mac.sh                # tools + dependencies + .env
#   scripts/install-mac.sh --local-db     # also start local Supabase, apply migrations, fill .env
#   scripts/install-mac.sh --skip-docker  # don't install Docker Desktop (cloud Supabase only)
#   scripts/install-mac.sh --start        # start the web app when done
#
# Installs (only if missing): Homebrew, Node.js 22, pnpm, Supabase CLI, Docker Desktop.
# Safe to re-run: every step checks before it changes anything.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOCAL_DB=0
SKIP_DOCKER=0
START=0
for arg in "$@"; do
  case "$arg" in
    --local-db) LOCAL_DB=1 ;;
    --skip-docker) SKIP_DOCKER=1 ;;
    --start) START=1 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$arg"; exit 1 ;;
  esac
done

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
info() { printf '\033[36m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  red "This script is for macOS. On Windows run scripts\\install-windows.cmd."
  exit 1
fi

# 1. Homebrew
if ! have brew; then
  info "Installing Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
else
  info "Homebrew found"
fi

# 2. Node.js >= 20
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! have node || [[ "$(node_major)" -lt 20 ]]; then
  info "Installing Node.js 22"
  brew install node@22
  brew link --overwrite --force node@22
else
  info "Node.js $(node -v) found"
fi

# 3. pnpm
if ! have pnpm; then
  info "Installing pnpm"
  if have corepack; then
    corepack enable
    corepack prepare pnpm@latest --activate
  fi
  have pnpm || npm install -g pnpm
else
  info "pnpm $(pnpm -v) found"
fi

# 4. Supabase CLI
if ! have supabase; then
  info "Installing Supabase CLI"
  brew install supabase/tap/supabase
else
  info "Supabase CLI $(supabase --version) found"
fi

# 5. Docker Desktop (needed only for a local Supabase stack)
if [[ "$SKIP_DOCKER" -eq 0 ]]; then
  if ! have docker; then
    info "Installing Docker Desktop"
    brew install --cask docker
    printf 'Open Docker Desktop once to finish its setup, then re-run with --local-db.\n'
  else
    info "Docker found"
  fi
fi

# 6. JavaScript dependencies
info "Installing project dependencies (pnpm install)"
pnpm install

# 7. Environment file
if [[ ! -f .env ]]; then
  info "Creating .env from .env.example"
  cp .env.example .env
else
  info ".env already exists, leaving it as is"
fi

# Replace KEY=... in .env (or append it).
set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    # `|` delimiter: keys and URLs never contain it.
    sed -i '' "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

# 8. Optional local database
if [[ "$LOCAL_DB" -eq 1 ]]; then
  if ! docker info >/dev/null 2>&1; then
    red "Docker is not running. Start Docker Desktop, then re-run with --local-db."
    exit 1
  fi
  info "Starting local Supabase, applying migrations and running database tests"
  scripts/supabase-migrate.sh local

  info "Writing local Supabase URL and keys to .env"
  status_env="$(supabase status -o env 2>/dev/null || true)"
  api_url="$(printf '%s\n' "$status_env" | sed -n 's/^API_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')"
  anon_key="$(printf '%s\n' "$status_env" | sed -n 's/^ANON_KEY="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')"
  service_key="$(printf '%s\n' "$status_env" | sed -n 's/^SERVICE_ROLE_KEY="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')"
  [[ -n "$api_url" ]] && set_env EXPO_PUBLIC_SUPABASE_URL "$api_url"
  [[ -n "$anon_key" ]] && set_env EXPO_PUBLIC_SUPABASE_KEY "$anon_key"
  [[ -n "$service_key" ]] && set_env SUPABASE_SERVICE_ROLE_KEY "$service_key"
fi

# 9. Sanity check
info "Type-checking the workspace"
pnpm typecheck

green "Smart Mess System is installed."
printf '\nNext steps:\n'
if [[ "$LOCAL_DB" -eq 0 ]]; then
  printf '  - Fill in EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_KEY in .env\n'
  printf '    (or re-run with --local-db to use a local Supabase stack).\n'
fi
printf '  - Create the first Administrator: see "First Administrator" in README.md.\n'
printf '  - Start the app: pnpm web\n\n'

if [[ "$START" -eq 1 ]]; then
  exec pnpm web
fi
