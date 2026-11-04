#!/usr/bin/env bash
# One-command install from a terminal.
#
#   DATABASE_URL="postgresql://postgres:PASSWORD@db.xxxx.supabase.co:5432/postgres" \
#   ADMIN_EMAILS="you@example.com,partner@example.com" \
#   ./apply.sh
#
# Add VERIFY=1 to also run the permission tests afterwards (they roll back, nothing is kept).
set -euo pipefail
cd "$(dirname "$0")"

: "${DATABASE_URL:?Set DATABASE_URL (Supabase -> Project Settings -> Database -> Connection string)}"
ADMIN_EMAILS="${ADMIN_EMAILS:-}"

if [[ -n "$ADMIN_EMAILS" && ! "$ADMIN_EMAILS" =~ ^[A-Za-z0-9@.,+_-]+$ ]]; then
  echo "ADMIN_EMAILS contains unexpected characters." >&2; exit 1
fi

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
if [[ -n "$ADMIN_EMAILS" ]]; then
  sed "s|REPLACE_WITH_YOUR_EMAIL@example.com|${ADMIN_EMAILS}|" all_in_one.sql > "$TMP"
else
  cp all_in_one.sql "$TMP"
  echo "WARNING: ADMIN_EMAILS not set - no administrator will be created." >&2
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$TMP"
echo "Database installed."

if [[ "${VERIFY:-0}" == "1" ]]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f verify.sql
fi
