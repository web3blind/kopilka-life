#!/bin/bash
set -euo pipefail

# The legacy destructive deploy automation has been retired. This command is a
# read-only gate for the parent-owned production procedure documented in README.
if [ "${1:-}" != "--preflight" ] || [ "$#" -ne 1 ]; then
  echo "Automatic deployment is disabled." >&2
  echo "Use: KOPILKA_SITE=... KOPILKA_DB_BACKUP=... KOPILKA_ENV_BACKUP=... KOPILKA_RELEASE_DIR=... $0 --preflight" >&2
  echo "Then follow README.md > Safe production transition; this script never deploys or restarts." >&2
  exit 64
fi

: "${KOPILKA_SITE:?KOPILKA_SITE is required}"
: "${KOPILKA_DB_BACKUP:?KOPILKA_DB_BACKUP is required}"
: "${KOPILKA_ENV_BACKUP:?KOPILKA_ENV_BACKUP is required}"
: "${KOPILKA_RELEASE_DIR:?KOPILKA_RELEASE_DIR is required}"

test -d "$KOPILKA_SITE"
test -f "$KOPILKA_SITE/.env"
test -f "$KOPILKA_DB_BACKUP"
test -s "$KOPILKA_DB_BACKUP"
test -f "$KOPILKA_ENV_BACKUP"
test -s "$KOPILKA_ENV_BACKUP"
test -d "$KOPILKA_RELEASE_DIR"
test "$KOPILKA_RELEASE_DIR" != "$KOPILKA_SITE"
test ! -e "$KOPILKA_RELEASE_DIR/.env"
test ! -e "$KOPILKA_RELEASE_DIR/data"
test -f "$KOPILKA_RELEASE_DIR/package-lock.json"
test -f "$KOPILKA_RELEASE_DIR/migrations/014_security_state.sql"

node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
  const integrity = db.pragma("integrity_check", { simple: true });
  const required = ["users", "entries", "weekly_contracts", "user_artifacts"];
  const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all("table").map((row) => row.name));
  db.close();
  if (integrity !== "ok" || required.some((name) => !present.has(name))) process.exit(1);
' "$KOPILKA_DB_BACKUP"

echo "PRECHECK_OK"
echo "Verified: external non-empty DB/env backups, SQLite integrity, isolated release tree, security migration."
echo "No files, services, webhooks, or production data were changed."
