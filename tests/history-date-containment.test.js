const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const css = fs.readFileSync(process.env.KOPILKA_DATE_CSS || path.join(__dirname, '../public/styles.css'), 'utf8');

test('History native date control has its own border-box shrink contract', () => {
  const rule = css.match(/\.history-picker input\[type="date"\]\s*\{([^}]+)\}/);
  assert.ok(rule, 'scoped native date rule exists');
  const declarations = Object.fromEntries(rule[1].split(';').filter(Boolean).map(d => d.split(':').map(s => s.trim())));
  assert.deepEqual(declarations, {
    width: '100%', 'max-width': 'min(100%,19rem)', 'min-width': '0', 'box-sizing': 'border-box'
  }, 'contain only the outer border; retain native picker, font, focus and visible content');
});

test('History picker is not hidden, clipped or given custom native segments', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => /history-picker|#historyDate/.test(m[1]));
  assert.equal(rules.length, 1);
  assert.doesNotMatch(rules[0][2], /appearance|overflow|clip|font|outline|display|transform/);
  assert.doesNotMatch(css, /historyDate[^{}]*::-webkit|history-picker[^{}]*::-webkit/);
});
