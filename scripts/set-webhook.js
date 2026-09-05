#!/usr/bin/env node
const config = require('../src/config');

function usage() {
  console.log([
    'Usage:',
    '  node scripts/set-webhook.js --dry-run',
    '  node scripts/set-webhook.js --set',
    '  node scripts/set-webhook.js --clear',
    '  node scripts/set-webhook.js --info',
    '',
    'Env:',
    '  BOT_TOKEN is required for all API modes.',
    '  TELEGRAM_WEBHOOK_SECRET is required for --set.',
    '  WEBAPP_URL or APP_BASE_URL must be an https:// production URL for --set/--dry-run.',
    '',
    'The webhook URL is <base>/telegram/webhook. Secrets are never printed.'
  ].join('\n'));
}

function parseMode(args) {
  const modes = ['--dry-run', '--set', '--clear', '--info'].filter((mode) => args.includes(mode));
  if (args.length !== 1 || modes.length !== 1) return null;
  return modes[0].slice(2);
}

function requireHttpsUrl(value, name) {
  let url;
  try { url = new URL(value); } catch (_) { throw new Error(`${name} must be a valid URL`); }
  if (url.protocol !== 'https:') throw new Error(`${name} must use https:// for Telegram webhooks`);
  return url;
}

function requireWebhookSecret(value) {
  if (!value || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new Error('TELEGRAM_WEBHOOK_SECRET is required and must use only A-Z, a-z, 0-9, _ or -');
  return value;
}

function buildSetWebhookPayload(webhookUrl, secret) {
  return {
    url: webhookUrl,
    secret_token: requireWebhookSecret(secret),
    allowed_updates: ['message', 'edited_message', 'inline_query']
  };
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
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) { usage(); return; }
  const mode = parseMode(args);
  if (!mode) throw new Error('Unknown mode. Use --dry-run, --set, --clear, or --info.');
  if (!config.botToken || config.botToken === 'replace_me') throw new Error('BOT_TOKEN is required and must not be replace_me');
  if (mode === 'info') {
    const data = await callTelegram('getWebhookInfo', {});
    const info = data.result || {};
    console.log(`Webhook configured: ${Boolean(info.url)}`);
    console.log(`Pending updates: ${Number(info.pending_update_count || 0)}`);
    if (info.last_error_date) console.log(`Last error date: ${Number(info.last_error_date)}`);
    return;
  }
  if (mode === 'clear') {
    await callTelegram('deleteWebhook', { drop_pending_updates: false });
    console.log('Webhook cleared.');
    return;
  }
  const base = requireHttpsUrl(config.webappUrl || config.appBaseUrl, 'WEBAPP_URL/APP_BASE_URL');
  const webhookUrl = new URL('/telegram/webhook', base).toString();
  const payload = buildSetWebhookPayload(webhookUrl, config.telegramWebhookSecret);
  console.log(`Webhook URL: ${webhookUrl}`);
  if (mode === 'dry-run') { console.log('Dry run valid. No Telegram API call was made.'); return; }
  await callTelegram('setWebhook', payload);
  console.log('Webhook installed with secret-token verification and inline updates.');
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });

module.exports = { parseMode, buildSetWebhookPayload, requireHttpsUrl, requireWebhookSecret };
