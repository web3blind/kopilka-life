#!/usr/bin/env node
const config = require('../src/config');

function maskToken(token) {
  if (!token) return '';
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function usage() {
  console.log([
    'Usage:',
    '  node scripts/set-webhook.js --dry-run',
    '  node scripts/set-webhook.js --set',
    '  node scripts/set-webhook.js --clear',
    '',
    'Env:',
    '  BOT_TOKEN is required.',
    '  WEBAPP_URL or APP_BASE_URL must be an https:// production URL.',
    '',
    'The webhook URL is <base>/telegram/webhook. Secrets are never printed.'
  ].join('\n'));
}

function requireHttpsUrl(value, name) {
  let url;
  try { url = new URL(value); } catch (_) { throw new Error(`${name} must be a valid URL`); }
  if (url.protocol !== 'https:') throw new Error(`${name} must use https:// for Telegram webhooks`);
  return url;
}

async function callTelegram(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`Telegram ${method} failed: HTTP ${res.status} ${data.description || ''}`.trim());
  return data;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.size === 0) { usage(); return; }
  if (!config.botToken || config.botToken === 'replace_me') throw new Error('BOT_TOKEN is required and must not be replace_me');
  const base = requireHttpsUrl(config.webappUrl || config.appBaseUrl, 'WEBAPP_URL/APP_BASE_URL');
  const webhookUrl = new URL('/telegram/webhook', base).toString();
  console.log(`BOT_TOKEN: ${maskToken(config.botToken)}`);
  console.log(`Webhook URL: ${webhookUrl}`);
  if (args.has('--dry-run')) { console.log('Dry run only. No Telegram API call was made.'); return; }
  if (args.has('--clear')) { await callTelegram('deleteWebhook', { drop_pending_updates: false }); console.log('Webhook cleared.'); return; }
  if (args.has('--set')) { await callTelegram('setWebhook', { url: webhookUrl, allowed_updates: ['message', 'edited_message'] }); console.log('Webhook installed.'); return; }
  throw new Error('Unknown mode. Use --dry-run, --set, or --clear.');
}

main().catch((error) => { console.error(error.message); process.exit(1); });
