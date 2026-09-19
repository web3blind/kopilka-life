const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');
let db;
function applyMigration(connection, name, sql) {
  // These connection settings are already applied before BEGIN. In particular
  // SQLite cannot switch journal mode inside a transaction (001_init.sql).
  const transactionalSql = sql.replace(/^\s*PRAGMA\s+(?:journal_mode\s*=\s*WAL|busy_timeout\s*=\s*5000)\s*;/gim, '');
  connection.transaction(() => {
    connection.exec(transactionalSql);
    connection.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
  })();
}
function initDatabase(dbPath = config.dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const connection = new Database(dbPath);
  try {
    connection.pragma('journal_mode = WAL');
    connection.pragma('busy_timeout = 5000');
    connection.pragma('foreign_keys = ON');
    connection.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    const migrationsDir = path.join(process.cwd(), 'migrations');
    const migrationFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    const applied = connection.prepare('SELECT name FROM _migrations').all().map((row) => row.name);
    for (const file of migrationFiles) {
      if (applied.includes(file)) continue;
      applyMigration(connection, file, fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    }
    db = connection;
    return db;
  } catch (error) {
    connection.close();
    throw error;
  }
}
function getDb() { return db || initDatabase(); }
function closeDb() { if (db) db.close(); db = null; }
module.exports = { initDatabase, getDb, closeDb, applyMigration };
