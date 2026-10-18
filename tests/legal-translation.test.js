'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..', 'public');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('English legal documents preserve source structure, dates, links and key caveats', () => {
  for (const kind of ['privacy', 'terms']) {
    const ru = read(`${kind}.html`), en = read(`${kind}.en.html`);
    assert.match(en, /<html lang="en">/);
    for (const tag of ['h1', 'h2', 'li', 'p', 'strong']) {
      assert.equal((en.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length,
        (ru.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length, `${kind}: ${tag} parity`);
    }
    assert.match(en, /data-document-return/);
    assert.match(en, /document-navigation\.js/);
    assert.doesNotMatch(en, /[А-Яа-яЁё]/);
  }
  const privacy = read('privacy.en.html');
  for (const clause of [
    '28 September 2026', 'Telegram or VK user ID', 'optional note',
    'IP address', 'only aggregated data, without personal notes',
    'does not store bank cards or payment details', 'does not transfer money or accept payments',
    'does not publish personal notes', 'does not sell user data to third parties',
    'until they ask for it to be deleted', 'CC BY 4.0',
    'not a transfer of the user’s personal entries', 'https://db-ip.com',
  ]) assert.ok(privacy.includes(clause), clause);
  const terms = read('terms.en.html');
  for (const clause of [
    '18 August 2026', 'not a currency', 'not a loyalty programme', 'not electronic money',
    'not a promise of material benefit', 'does not hold money, accept payments or make transfers',
    'only a text reminder', 'passwords, bank details, confidential medical information',
    'does not replace a doctor, psychologist, financial adviser or legal advice',
    'once per local calendar day', 'cannot manage someone else’s profile',
  ]) assert.ok(terms.includes(clause), clause);
});

function standalone(url, lang) {
  const links = [
    { attrs: { href: '/' }, return: true },
    { attrs: { href: '/terms.html' } },
    { attrs: { href: '/privacy.en.html?sign=secret&return=https://evil.example' } },
    { attrs: { href: 'https://evil.example/terms.html' } },
  ].map((item) => ({ ...item, getAttribute(k) { return this.attrs[k]; }, setAttribute(k,v) { this.attrs[k] = v; } }));
  const document = {
    documentElement: { lang },
    querySelectorAll(selector) { return selector === 'a[href]' ? links : []; },
    querySelector() { return links[0]; },
  };
  const window = { location: new URL(url) };
  window.location.replace = (value) => { links.redirect = value; };
  vm.runInNewContext(read('document-navigation.js'), { window, document, URL, URLSearchParams });
  return links;
}

test('standalone locale/source allowlists never forward arbitrary parameters', () => {
  for (const kind of ['privacy', 'terms']) {
    for (const source of ['web', 'vk', 'telegram']) {
      const links = standalone(`https://life.example/${kind}.en.html?source=${source}&lang=en&sign=secret&return=https://evil.example`, 'en');
      const returns = { web: 'https://life.example/?lang=en', vk: 'https://vk.ru/app54723764', telegram: 'https://t.me/HarborLifeBot?startapp' };
      assert.equal(links[0].href, returns[source]);
      assert.equal(links[1].attrs.href, `/terms.en.html?source=${source}&lang=en`);
      assert.equal(links[2].attrs.href, `/privacy.en.html?source=${source}&lang=en`);
      assert.equal(links[3].attrs.href, 'https://evil.example/terms.html');
    }
  }
  for (const query of ['source=https://evil.example', 'source=vk&source=telegram', 'lang=../../evil&source=nope']) {
    const links = standalone(`https://life.example/privacy.html?${query}`, 'ru');
    assert.equal(links[0].href, 'https://life.example/');
    assert.equal(links[1].attrs.href, '/terms.html?source=web');
  }
  const links = standalone('https://life.example/privacy.html?lang=en&source=vk', 'ru');
  assert.equal(links.redirect, '/privacy.en.html?source=vk&lang=en');
});
