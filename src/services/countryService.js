const net = require('node:net');
const fs = require('node:fs');
const maxmind = require('maxmind');
const config = require('../config');

let reader;
let readerPath;
let readerMtime = 0;
let nextCheck = 0;
function countryFromIp(ip, databasePath = config.geoCountryDbPath) {
  const address = String(ip || '').replace(/^::ffff:/, '');
  if (!databasePath && !config.isProduction) return 'DEV';
  if (!net.isIP(address) || !databasePath) return null;
  if (!reader && readerPath === databasePath && Date.now() < nextCheck) return null;
  try {
    if (!reader || readerPath !== databasePath || Date.now() >= nextCheck) {
      const mtime = fs.statSync(databasePath).mtimeMs;
      if (!reader || readerPath !== databasePath || mtime !== readerMtime) {
        reader = new maxmind.Reader(fs.readFileSync(databasePath));
        readerMtime = mtime;
      }
      readerPath = databasePath;
      nextCheck = Date.now() + 60_000;
    }
    return reader.get(address)?.country?.iso_code || null;
  } catch (_) {
    reader = null; readerPath = databasePath; nextCheck = Date.now() + 60_000;
    return null;
  }
}
function siteRegion(country) { return country && country !== 'RU' ? 'global' : 'ru'; }
module.exports = { countryFromIp, siteRegion };
