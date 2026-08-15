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
  db.exec(fs.readFileSync(path.join(process.cwd(), 'migrations', '001_init.sql'), 'utf8'));
  return db;
}
function getDb() { return db || initDatabase(); }
function closeDb() { if (db) db.close(); db = null; }
module.exports = { initDatabase, getDb, closeDb };
