// Synthetic browser-QA provider only. Never use as production preload.
if (process.env.NODE_ENV !== 'test') throw new Error('AI weekly fixture requires NODE_ENV=test');
const originalFetch = global.fetch;
const base = 'https://openrouter.ai/api/v1';
global.fetch = async (url, options = {}) => {
  const target = String(url);
  if (!target.startsWith(base + '/')) {
    if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(target)) return originalFetch(url, options);
    throw new Error('External network disabled by AI weekly QA fixture');
  }
  const model = process.env.AI_WEEKLY_MODEL || 'xingchen-agi/xing4.0-29b-a4b:free';
  if (target === base + '/models') return Response.json({data:[{id:model,pricing:{prompt:'0',completion:'0'}}]});
  if (target === base + '/endpoints/zdr') return Response.json({data:[{model_id:model,tag:'fixture-only',pricing:{prompt:'0',completion:'0'}}]});
  if (target === base + '/models/' + model + '/endpoints') return Response.json({data:{endpoints:[{
    tag:'fixture-only',provider_name:'Synthetic test fixture',pricing:{prompt:'0',completion:'0'},data_policy:{is_zdr:true,data_collection:false}
  }]}});
  if (target !== base + '/chat/completions' || options.method !== 'POST') throw new Error('Unexpected AI weekly fixture request');
  const body = JSON.parse(options.body);
  const english = body.messages[0].content.includes('in English');
  // This response proves application wiring, NOT a real model's quality or privacy policy.
  return Response.json({choices:[{finish_reason:'stop',message:{content:english ?
    'Synthetic QA response: the saved records are the only source for this example. Missing records do not show what did or did not happen.' :
    'Синтетический ответ для проверки: пример опирается только на сохранённые записи. Отсутствие записей не говорит о том, что происходило.'}}]});
};
