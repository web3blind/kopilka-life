// Controlled provider for disposable connected QA only. Never load in production.
const fs = require('node:fs');
if (process.env.NODE_ENV !== 'test' || !process.env.DB_PATH?.endsWith('qa.sqlite') || !process.env.KOPILKA_AI_QA_CALLS) throw new Error('AI browser fixture requires disposable QA environment');
const realFetch = global.fetch;
const pricing = process.env.AI_WEEKLY_PAID_ENABLED === 'true' ? { prompt: '0.00000002', completion: '0.00000003' } : { prompt: '0', completion: '0' };
global.fetch = async (url, options = {}) => {
  if (!String(url).startsWith('https://openrouter.ai/api/v1/')) return realFetch(url, options);
  if (String(url).endsWith('/models')) return Response.json({ data: [{ id: process.env.AI_WEEKLY_MODEL, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing }] });
  if (String(url).endsWith('/endpoints/zdr')) return Response.json({ data: [{ model_id: process.env.AI_WEEKLY_MODEL, tag: 'fixture-only', pricing }] });
  if (String(url).endsWith('/endpoints')) return Response.json({ data: { endpoints: [{ tag: 'fixture-only', pricing }] } });
  if (!String(url).endsWith('/chat/completions')) throw new Error('unexpected QA provider path');
  const body = JSON.parse(options.body);
  const calls = fs.existsSync(process.env.KOPILKA_AI_QA_CALLS) ? JSON.parse(fs.readFileSync(process.env.KOPILKA_AI_QA_CALLS, 'utf8')) : [];
  calls.push({ model: body.model, provider: body.provider, messages: body.messages, hasNotes: body.messages.some(m => m.content.includes('synthetic-walk')), method: options.method });
  fs.writeFileSync(process.env.KOPILKA_AI_QA_CALLS, JSON.stringify(calls));
  if (body.messages.some(m => m.content.includes('fixture_reject'))) return Response.json({ error: { message: 'synthetic rejection' } }, { status: 429 });
  if (body.messages.some(m => m.content.includes('fixture_uncertain'))) throw new Error('synthetic network interruption');
  await new Promise(resolve => setTimeout(resolve, 150));
  const en = body.messages.some(m => /\bEnglish\b/.test(m.content));
  const input = JSON.parse(body.messages.find(m => m.role === 'user').content);
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
  return Response.json({ id: 'fixture-digest', model: body.model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { cost: 0, prompt_tokens: 100, completion_tokens: 60 } });
};
