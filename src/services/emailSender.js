const config = require('../config');

async function sendLoginCode(email, code) {
  if (!config.resendApiKey) throw new Error('Email API is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: config.emailFrom, to: [email], reply_to: config.emailReplyTo,
      subject: 'Копилка жизни — код входа',
      text: `Код для входа в Копилку жизни: ${code}\nОн действует 10 минут. Если ты не запрашивал вход, просто проигнорируй письмо.\n`
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('Email API delivery failed');
}
module.exports = { sendLoginCode };