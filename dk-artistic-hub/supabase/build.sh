#!/usr/bin/env bash
# Rebuilds all_in_one.sql from the numbered migrations.
# Run this after you edit any file in migrations/.
set -euo pipefail
cd "$(dirname "$0")"
OUT="all_in_one.sql"

{
  echo "-- ======================================================================"
  echo "-- DK ARTISTIC HUB - COMPLETE DATABASE  (all tables, security, functions, seed)"
  echo "-- Paste this WHOLE file into Supabase -> SQL Editor -> Run. That is all."
  echo "--"
  echo "--  * Runs as ONE transaction: everything is saved, or nothing is."
  echo "--  * Safe to run again any time (it never deletes data or overwrites your edits)."
  echo "--  * EDIT THE ADMIN EMAIL on the line below BEFORE running (comma separated for more)."
  echo "-- ======================================================================"
  echo "begin;"
  echo
  echo "select set_config('dk.admin_emails', 'REPLACE_WITH_YOUR_EMAIL@example.com', true);"
  echo
  for f in migrations/*.sql; do
    echo
    echo "-- >>>>>>>>>> $(basename "$f") <<<<<<<<<<"
    cat "$f"
    echo
  done
  echo "commit;"
} > "$OUT"

echo "Built $OUT ($(wc -l < "$OUT") lines from $(ls migrations/*.sql | wc -l) migrations)"
