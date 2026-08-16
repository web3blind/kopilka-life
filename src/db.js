const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');
let db;
function initDatabase(dbPath = config.dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  // Track applied migrations so ALTER/CREATE steps run once (idempotent restarts).
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const migrationsDir = path.join(process.cwd(), 'migrations');
  const migrationFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const applied = db.prepare('SELECT name FROM _migrations').all().map((row) => row.name);
  for (const file of migrationFiles) {
    if (applied.includes(file)) continue;
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    db.prepare('INSERT OR IGNORE INTO _migrations (name) VALUES (?)').run(file);
  }
  return db;
}
function getDb() { return db || initDatabase(); }
function closeDb() { if (db) db.close(); db = null; }
module.exports = { initDatabase, getDb, closeDb };
