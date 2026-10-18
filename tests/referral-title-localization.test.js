'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { displayTitle, ENTRY_TYPES } = require('../src/services/entriesService');

test('referral award display follows RU/EN locale without changing stored ledger content', () => {
  const entry = Object.freeze({ type: 'referral', title: 'Активный приглашённый человек', life_points: 1, note: '' });
  assert.equal(displayTitle(entry, 'en'), 'Active invited person');
  assert.equal(displayTitle(entry, 'ru'), entry.title);
  assert.equal(entry.title, 'Активный приглашённый человек');
  assert.equal(entry.life_points, 1);
  assert.equal(ENTRY_TYPES.includes('referral'), false);
});

test('unknown/custom system titles stay intact and ordinary actions remain localized', () => {
  assert.equal(displayTitle({ type: 'custom_award', title: 'Original title' }, 'en'), 'Original title');
  assert.equal(displayTitle({ type: 'movement', title: 'Движение' }, 'en'), 'Movement');
});
