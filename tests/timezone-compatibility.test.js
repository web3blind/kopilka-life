const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function olderIntl() {
  function DateTimeFormat(locale, options = {}) {
    if (['longOffset','longGeneric'].includes(options.timeZoneName)) throw new RangeError('Older WebView rejects extended names');
    return new Intl.DateTimeFormat(locale,options);
  }
  DateTimeFormat.prototype = Intl.DateTimeFormat.prototype;
  return { DateTimeFormat };
}
for (const locale of ['ru','en']) test(`older Intl timezone renderer ${locale}: exact offsets and aliases without expanded names`,()=>{
  const scope={window:{},Intl:olderIntl()};vm.runInNewContext(fs.readFileSync('public/i18n.js','utf8'),scope);
  const I=scope.window.KopilkaI18n;
  const cases=[['Europe/Kaliningrad','2026-01-15T23:59:59Z','UTC+02:00'],['US/Eastern','2026-01-15T12:34:56Z','UTC-05:00'],['US/Eastern','2026-07-15T12:34:56Z','UTC-04:00'],['Asia/Kathmandu','2026-01-15T23:59:59.900Z','UTC+05:45'],['UTC','2026-01-15T00:00:00Z','UTC+00:00']];
  for(const [zone,date,offset] of cases) {
    let label;assert.doesNotThrow(()=>{label=I.timezoneLabel(locale,zone,new Date(date));});assert.ok(label.includes(offset),label);
    if(zone==='US/Eastern')assert.ok(label.includes(zone),label);
    const choices=I.timezoneChoices(zone,['UTC',zone]);assert.ok(choices.includes(zone));
  }
});
