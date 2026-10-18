const crypto = require('node:crypto');
function googleHandoff(payload) {
  const nonce = crypto.randomBytes(18).toString('base64url');
  const data = JSON.stringify({ type: 'kopilka:google-oauth', ...payload }).replace(/</g, '\\u003c');
  const script = `(() => { const value=${data}; sessionStorage.setItem('kopilkaGoogleOAuthHandoff', JSON.stringify(value)); let acknowledged=false; window.addEventListener('message', event => { if (event.source === window.opener && event.origin === location.origin && event.data?.type === 'kopilka:google-oauth-ack' && event.data?.channel === value.channel) { acknowledged=true; sessionStorage.removeItem('kopilkaGoogleOAuthHandoff'); window.close(); } }); if (window.opener && !window.opener.closed && value.channel) { window.opener.postMessage(value, location.origin); window.setTimeout(() => { if (!acknowledged) window.location.replace('/?google_oauth_return=1'); }, 1200); } else window.location.replace('/?google_oauth_return=1'); })();`;
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Копилка жизни — Google</title></head><body><main><h1>Возвращаемся в Копилку жизни</h1><p role="status">Завершаем вход…</p></main><script nonce="${nonce}">${script}</script></body></html>`;
  return { html, csp: `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` };
}
module.exports = { googleHandoff };
