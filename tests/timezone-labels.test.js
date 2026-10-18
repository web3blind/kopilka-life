const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = { window: {}, Intl, Date };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/i18n.js'), 'utf8'), context);
const i18n = context.window.KopilkaI18n;
test('all runtime-supported zones have localized RU/EN labels and today offsets without changing IDs', () => {
  for (const locale of ['ru','en']) for (const zone of i18n.timezoneChoices('US/Eastern')) {
    const label = i18n.timezoneLabel(locale, zone);
    assert.match(label, /UTC[+-]\d{2}:\d{2}/, zone);
    assert.notEqual(label, zone);
    if (locale === 'ru') assert.match(label, /[А-Яа-яЁё]/, zone);
  }
});
test('DST and fractional offsets describe chosen zone/date, not fixed hardcoded offsets', () => {
  assert.match(i18n.timezoneLabel('en','US/Eastern',new Date('2026-01-01')), /UTC-05:00/);
  assert.match(i18n.timezoneLabel('en','US/Eastern',new Date('2026-07-01')), /UTC-04:00/);
  assert.match(i18n.timezoneLabel('ru','Asia/Kathmandu',new Date('2026-01-01')), /UTC\+05:45/);
  assert.match(i18n.timezoneLabel('ru','UTC'), /Всемирное время.*UTC\+00:00/);
  assert.match(i18n.timezoneLabel('en','Etc/GMT+5'), /UTC-05:00/);
});
test('unsupported current values never become a selectable UTC substitution', () => {
  for (const value of ['Mars/Olympus', ' Europe/Moscow', '', null, {}, ['UTC'], '+03:00']) {
    assert.equal(i18n.validTimezone(value), false);
    assert.equal(i18n.timezoneChoices(value).includes(value), false);
    assert.equal(i18n.timezoneLabel('en',value), i18n.t('en','invalidTimezone'));
  }
});
