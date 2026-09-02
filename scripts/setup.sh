#!/usr/bin/env bash
#
# Brings the whole system up.
#
#   ./scripts/setup.sh          set up, then say how to start
#   ./scripts/setup.sh --start  set up, then run it
#
# Docker is the intended path: one command starts Postgres, applies migrations
# and runs the service. Where Docker is unavailable — an older macOS, a locked
# down laptop — it falls back to a native Postgres and a local Node process,
# which is the same code against the same schema on the same port.
#
# It will not install system software behind your back: where a tool is missing
# it prints the command and stops.

set -euo pipefail

PORT=5433
DB_USER=credit
DB_NAME=credit_builder
DB_URL="postgres://${DB_USER}:${DB_USER}@localhost:${PORT}/${DB_NAME}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

cd "$(dirname "$0")/.."
START=${1:-}

# ------------------------------------------------------------- 0. Config
if [ ! -f .env ]; then
  cp .env.example .env
  warn ".env created from .env.example — set BANKING_API_KEY before syncing"
fi

# ------------------------------------------------------ 1. Docker, if we can
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  bold "Docker detected — bringing up the whole stack"
  if docker compose up -d --build; then
    ok "postgres, migrations and the service are running"
    echo
    echo "  http://localhost:3000/docs      API documentation"
    echo "  docker compose logs -f app      follow the service"
    echo "  docker compose down             stop everything"
    exit 0
  fi
  warn "docker compose failed; falling back to a native setup"
else
  bold "No usable Docker — setting up natively"
fi

# --------------------------------------------------------------- 2. Node
bold "1. Node"
REQUIRED=$(cat .nvmrc)
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm install "$REQUIRED" >/dev/null 2>&1 || true
  nvm use "$REQUIRED" >/dev/null 2>&1 || true
  ok "nvm: using Node $(node -v)"
elif command -v node >/dev/null 2>&1; then
  ok "Node $(node -v) (no nvm; using what is on PATH)"
else
  die "Node not found. Install nvm, then re-run:
      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
fi

node -e '
  const [maj] = process.versions.node.split(".").map(Number);
  if (maj < 22) { console.error(`  Node ${process.versions.node} is too old`); process.exit(1); }
' || die "Upgrade Node, then re-run."

# ------------------------------------------------------- 3. Dependencies
bold "2. npm dependencies"
# TypeScript, Vitest, ESLint and Drizzle are all devDependencies — nothing here
# is installed globally.
if [ -f node_modules/.package-lock.json ] && [ node_modules/.package-lock.json -nt package-lock.json ]; then
  ok "node_modules already matches package-lock.json"
else
  npm ci
  ok "installed from package-lock.json"
fi

# -------------------------------------------------------- 4. PostgreSQL
bold "3. PostgreSQL 17 on :${PORT}"
pg_up() { (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; }

if pg_up; then
  ok "already listening on :${PORT}"
elif [ -d /Applications/Postgres.app ]; then
  BIN=/Applications/Postgres.app/Contents/Versions/17/bin
  DATA="$HOME/Library/Application Support/Postgres/var-17"
  if [ ! -d "$DATA" ]; then
    "$BIN/initdb" -D "$DATA" -U "$DB_USER" --encoding=UTF8 --locale=C \
      --auth-local=trust --auth-host=trust >/dev/null
    echo "port = ${PORT}" >> "$DATA/postgresql.conf"
    ok "initialised a cluster at $DATA"
  fi
  "$BIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w start >/dev/null 2>&1 || true
  pg_up || die "Postgres.app cluster would not start — see $DATA/server.log"
  "$BIN/createdb" -h localhost -p "$PORT" -U "$DB_USER" "$DB_NAME" 2>/dev/null || true
  ok "started via Postgres.app"
else
  die "No PostgreSQL on :${PORT}, and no way to start one. Pick either:
      Docker            brew install --cask docker        (needs macOS 13+)
      Docker via Colima brew install colima docker docker-compose && colima start
      Native            brew install --cask postgres-unofficial   (Postgres.app)
      then re-run this script."
fi

grep -q "^DATABASE_URL=" .env 2>/dev/null || echo "DATABASE_URL=${DB_URL}" >> .env

# ---------------------------------------------------------- 5. Migrate
bold "4. Schema"
DATABASE_URL="${DB_URL}" npm run db:migrate >/dev/null
ok "migrations applied"

bold "Ready"
echo "  npm run dev                 start the service on :3000"
echo "  npm test                    unit tests (~200ms, no infrastructure)"
echo "  npm run test:integration    needs the database above"
echo "  npm run check               typecheck + lint + format + unit"

if [ "$START" = "--start" ]; then
  echo
  exec npm run dev
fi
