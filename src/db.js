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
  const migrationsDir = path.join(process.cwd(), 'migrations');
  const migrationFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of migrationFiles) {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
  return db;
}
function getDb() { return db || initDatabase(); }
function closeDb() { if (db) db.close(); db = null; }
module.exports = { initDatabase, getDb, closeDb };
