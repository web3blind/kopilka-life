// Controlled provider for disposable connected QA only. Never load in production.
const fs = require('node:fs');
if (process.env.NODE_ENV !== 'test' || !process.env.DB_PATH?.endsWith('qa.sqlite') || !process.env.KOPILKA_AI_QA_CALLS) throw new Error('AI browser fixture requires disposable QA environment');
const realFetch = global.fetch;
const pricing = { prompt: '0.00000002', completion: '0.00000003' };
global.fetch = async (url, options = {}) => {
  const address = String(url);
  const google = address.startsWith('https://generativelanguage.googleapis.com/');
  if (!google && !address.startsWith('https://openrouter.ai/api/v1/')) return realFetch(url, options);
  if (!google && address.endsWith('/models')) return Response.json({ data: [{ id: process.env.AI_WEEKLY_MODEL, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing }] });
  if (!google && address.endsWith('/endpoints/zdr')) return Response.json({ data: [{ model_id: process.env.AI_WEEKLY_MODEL, tag: 'fixture-only', pricing }] });
  if (!google && address.endsWith('/endpoints')) return Response.json({ data: { endpoints: [{ tag: 'fixture-only', pricing }] } });
  if (!(google ? /\/models\/[^/?]+:generateContent$/.test(address) : address.endsWith('/chat/completions'))) throw new Error('unexpected QA provider path');
  const body = JSON.parse(options.body);
  const messages = google ? [
    { role: 'system', content: body.systemInstruction.parts.map(p => p.text || '').join('\n') },
    { role: 'user', content: body.contents.flatMap(c => c.parts).map(p => p.text || '').join('\n') }
  ] : body.messages;
  const headers = new Headers(options.headers);
  const calls = fs.existsSync(process.env.KOPILKA_AI_QA_CALLS) ? JSON.parse(fs.readFileSync(process.env.KOPILKA_AI_QA_CALLS, 'utf8')) : [];
  calls.push({ model: google ? decodeURIComponent(address.match(/\/models\/([^/?]+):generateContent$/)[1]) : body.model,
    transport: google ? 'Google Gemini' : 'OpenRouter', provider: body.provider, messages,
    hasNotes: messages.some(m => m.content.includes('synthetic-walk')), method: options.method,
    hasApiKeyHeader: headers.has('x-goog-api-key'), hasAuthorization: headers.has('authorization'), hasKeyInUrl: /[?&]key=/.test(address) });
  fs.writeFileSync(process.env.KOPILKA_AI_QA_CALLS, JSON.stringify(calls));
  if (messages.some(m => m.content.includes('fixture_reject'))) return Response.json({ error: { message: 'synthetic rejection' } }, { status: 429 });
  if (messages.some(m => m.content.includes('fixture_uncertain'))) throw new Error('synthetic network interruption');
  await new Promise(resolve => setTimeout(resolve, 150));
  const en = messages.some(m => /\bEnglish\b/.test(m.content));
  const input = JSON.parse(messages.find(m => m.role === 'user').content);
  const topic = input.selection.topic;
  const ideas = {
    calm: ['Можно ненадолго убрать лишние звуки.', 'If you wish, reduce background noise for a moment.'],
    'hard-days': ['Можно выбрать одно самое простое дело или сделать паузу.', 'You could choose one low-effort task or take a break.'],
    rest: ['Если хочется, оставь один вечер без новых задач.', 'If you wish, leave one evening free of new tasks.'],
    kindness: ['Можно бесплатно убрать одну вещь в общем пространстве.', 'You could tidy one item in a shared space, without spending money.'],
    'self-support': ['Можно приготовить себе стакан воды.', 'You could get yourself a glass of water.'],
    goal: ['В записях нет явной цели. Если хочется, можно её записать.', 'No explicit goal is recorded. If you wish, write one down.']
  };
  const facts = en ? 'Recorded facts: a walk is logged. Other days are not documented.' : 'Факты из записей: отмечена прогулка. Про остальные дни данных нет.';
  const content = facts + (topic === 'summary' ? '' : '\n\n' + (en ? 'Optional ideas: ' : 'Необязательные идеи: ') + ideas[topic][en ? 1 : 0]);
  if (google) return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: content }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 60 } });
  return Response.json({ id: 'fixture-digest', model: body.model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { cost: 0, prompt_tokens: 100, completion_tokens: 60 } });
};
