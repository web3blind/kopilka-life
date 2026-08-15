const { initDatabase, closeDb } = require('../src/db');
const config = require('../src/config');
initDatabase();
closeDb();
console.log(`SQLite initialized: ${config.dbPath}`);
