const config = require('../config');
const prompts = require('./aiAssistantPrompts');
const BASE = 'https://openrouter.ai/api/v1';
const MAX_RESPONSE_BYTES = 512 * 1024;
function failure(code, uncertain = false) {
  const error = new Error(code);
  error.safeCode = code;
  error.uncertain = uncertain;
  return error;
}
function timeoutMs() {
  const value = Number(config.aiWeeklyTimeoutMs);
  return Number.isFinite(value) && value >= 50 && value <= 60000 ? value : 30000;
}
function describe() {
  const paidMode = config.aiWeeklyPaidEnabled === true;
  return { provider: paidMode ? 'OpenRouter' : 'Google Gemini', providerId: paidMode ? 'openrouter' : 'gemini', paidMode, model: config.aiWeeklyModel };
}
function available() {
  const paid = config.aiWeeklyPaidEnabled === true;
  const key = paid ? config.aiWeeklyOpenrouterApiKey : config.aiWeeklyGeminiApiKey;
  return config.aiWeeklyEnabled === true && typeof key === 'string' && key.trim().length > 0 && typeof config.aiWeeklyModel === 'string' &&
    (paid ? /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+$/.test(config.aiWeeklyModel) : config.aiWeeklyModel === 'gemini-3.5-flash-lite');
}
function inputBound(records, locale, context) {
  return prompts.messages(records,locale,context).reduce((sum,message) => sum + Buffer.byteLength(message.content,'utf8'),4096);
}
// Catalog prices are USD/token; routing max_price is USD/million tokens.
// These limits are deliberately not operator-configurable.
const PAID_MAX_PRICE = Object.freeze({ prompt: 0.10, completion: 0.40, request: 0 });
function acceptablePrice(pricing, paid) {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return false;
  const valid = value => (typeof value === 'string' || typeof value === 'number') &&
    String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
  if (!['prompt', 'completion'].every(key => valid(pricing[key]) &&
      Number(pricing[key]) <= (paid ? PAID_MAX_PRICE[key] / 1000000 : 0))) return false;
  // No fixed request fees or other unbudgeted charges, including unknown future fields.
  return Object.entries(pricing).every(([key, value]) =>
    ['prompt', 'completion'].includes(key) || (valid(value) && Number(value) === 0));
}
async function boundedJson(response, maximum = MAX_RESPONSE_BYTES) {
  if (Number(response.headers.get('content-length')) > maximum) throw failure('PROVIDER_RESPONSE_INVALID');
  const reader = response.body?.getReader();
  if (!reader) throw failure('PROVIDER_RESPONSE_INVALID');
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw failure('PROVIDER_RESPONSE_INVALID');
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (_) { throw failure('PROVIDER_RESPONSE_INVALID'); }
  } finally { await reader.cancel().catch(() => {}); }
}
async function generateOpenRouter(records, locale, model, beforeSend, context) {
  const messages = prompts.messages(records,locale,context);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  let sent = false;
  const headers = { Authorization: `Bearer ${config.aiWeeklyOpenrouterApiKey}`, 'Content-Type': 'application/json' };
  async function catalog(path) {
    const response = await fetch(BASE + path, { headers, signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw failure('MODEL_VERIFICATION_FAILED');
    return boundedJson(response, 8 * 1024 * 1024);
  }
  try {
    if (!available() || model !== config.aiWeeklyModel) throw failure('AI_UNAVAILABLE');
    const paid = !model.endsWith(':free');
    const priceError = paid ? 'PRICE_LIMIT_EXCEEDED' : 'FREE_MODEL_REQUIRED';
    const models = await catalog('/models');
    const item = models.data?.find(row => row.id === model);
    if (!item || !acceptablePrice(item.pricing, paid)) throw failure(priceError);
    if (paid && (!item.architecture?.input_modalities?.includes('text') ||
        !item.architecture?.output_modalities?.includes('text'))) throw failure('MODEL_VERIFICATION_FAILED');
    const endpoints = await catalog(`/models/${model}/endpoints`);
    // Use the documented ZDR catalog, not a nonexistent endpoint.data_policy.
    // Routing filters below enforce the policy again when the request is sent.
    const zdr = await catalog('/endpoints/zdr');
    const privateEndpoints = endpoints.data?.endpoints?.filter(endpoint =>
      typeof endpoint.tag === 'string' && endpoint.tag.length > 0 &&
      zdr.data?.some(privateEndpoint => privateEndpoint.model_id === model &&
        privateEndpoint.tag === endpoint.tag));
    if (!privateEndpoints?.length) throw failure('PRIVATE_ENDPOINT_UNAVAILABLE');
    const eligible = privateEndpoints.filter(endpoint => acceptablePrice(endpoint.pricing, paid) &&
      zdr.data.some(privateEndpoint => privateEndpoint.model_id === model &&
        privateEndpoint.tag === endpoint.tag && acceptablePrice(privateEndpoint.pricing, paid)));
    if (!eligible.length) throw failure(priceError);
    // Compare a conservative byte-based input bound plus the fixed output cap.
    // Allow one endpoint only: routing must not silently choose a pricier peer.
    const inputBound = Buffer.byteLength(JSON.stringify(messages), 'utf8') + 4096;
    const ranked = eligible.map(endpoint => {
      const privatePrice = zdr.data.find(row => row.model_id === model && row.tag === endpoint.tag && acceptablePrice(row.pricing, paid)).pricing;
      const prompt = Math.max(Number(endpoint.pricing.prompt), Number(privatePrice.prompt));
      const completion = Math.max(Number(endpoint.pricing.completion), Number(privatePrice.completion));
      return { tag: endpoint.tag, prompt, completion, score: prompt * inputBound + completion * 700 };
    }).sort((a, b) => a.score - b.score || a.tag.localeCompare(b.tag));
    const selected = ranked[0];
    // Normalize multiplication noise (1e-7 * 1e6 must quote 0.1, not a lower
    // binary artefact that would incorrectly exclude the verified endpoint).
    const perMillion = value => Number((value * 1000000).toPrecision(15));
    const maximum = paid ? { prompt: Math.min(PAID_MAX_PRICE.prompt, perMillion(selected.prompt)), completion: Math.min(PAID_MAX_PRICE.completion, perMillion(selected.completion)), request: 0 } : { prompt: 0, completion: 0 };
    if (!beforeSend()) throw failure('REQUEST_CANCELLED');
    const body = {
      model, stream: false, max_tokens: 700, temperature: 0.2,
      provider: { only: [selected.tag], allow_fallbacks: false,
        data_collection: 'deny', zdr: true, max_price: maximum },
      messages
    };
    // Durable claim already exists. Once fetch might have sent bytes, never automatically resend.
    sent = true;
    const response = await fetch(BASE + '/chat/completions', {
      method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error'
    });
    if (!response.ok) throw failure(response.status >= 400 && response.status < 500 ? 'PROVIDER_REJECTED' : 'PROVIDER_UNCERTAIN', response.status < 400 || response.status >= 500);
    const result = await boundedJson(response);
    const choice = result.choices?.[0];
    const text = choice?.message?.content;
    if (choice?.finish_reason !== 'stop' || typeof text !== 'string' || !text.trim() ||
        text.length > 2000 || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw failure('PROVIDER_RESPONSE_INVALID', true);
    return text.trim();
  } catch (error) {
    if (error.safeCode) { if (sent && error.safeCode === 'PROVIDER_RESPONSE_INVALID') error.uncertain = true; throw error; }
    throw failure(sent ? 'PROVIDER_UNCERTAIN' : 'MODEL_VERIFICATION_FAILED', sent);
  } finally { clearTimeout(timer); }
}
async function generateGemini(records, locale, model, beforeSend, context) {
  const messages = prompts.messages(records,locale,context);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(),timeoutMs());
  let sent = false;
  try {
    if (!available() || config.aiWeeklyPaidEnabled === true || model !== config.aiWeeklyModel) throw failure('AI_UNAVAILABLE');
    const body = {
      systemInstruction: { parts: [{ text: messages[0].content }] },
      contents: [{ role:'user', parts:[{ text:messages[1].content }] }],
      generationConfig: { temperature:0.2, maxOutputTokens:1024, thinkingConfig:{thinkingLevel:'minimal'} }
    };
    if (!beforeSend()) throw failure('REQUEST_CANCELLED');
    sent = true;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method:'POST', headers:{'x-goog-api-key':config.aiWeeklyGeminiApiKey,'Content-Type':'application/json'},
      body:JSON.stringify(body), signal:controller.signal, redirect:'error'
    });
    if (!response.ok) throw failure(response.status === 429 ? 'PROVIDER_BUSY' : response.status >= 400 && response.status < 500 ? 'PROVIDER_REJECTED' : 'PROVIDER_UNCERTAIN',response.status < 400 || response.status >= 500);
    const result = await boundedJson(response);
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.error) throw failure('PROVIDER_RESPONSE_INVALID',true);
    const candidate = result.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (result.promptFeedback?.blockReason || result.candidates?.length !== 1 || candidate?.finishReason !== 'STOP' ||
        candidate.safetyRatings?.some(rating => rating.blocked === true) || !Array.isArray(parts) || !parts.length ||
        parts.some(part => !part || Object.keys(part).some(key => !['text','thoughtSignature','thought'].includes(key)) ||
          typeof part.text !== 'string' || (part.thought !== undefined && part.thought !== false) ||
          (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== 'string'))) throw failure('PROVIDER_RESPONSE_INVALID',true);
    // Gemini 3 may attach an opaque signature to its final visible text part.
    // Do not return, persist or replay that metadata or any reasoning text.
    const text = parts.map(part => part.text).join('');
    if (!text.trim() || text.length > 2000 || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) throw failure('PROVIDER_RESPONSE_INVALID',true);
    return text.trim();
  } catch (error) {
    if (error.safeCode) { if (sent && error.safeCode === 'PROVIDER_RESPONSE_INVALID') error.uncertain = true; throw error; }
    throw failure(sent ? 'PROVIDER_UNCERTAIN' : 'AI_UNAVAILABLE',sent);
  } finally { clearTimeout(timer); }
}
async function generate(records, locale, model, beforeSend = () => true, context = {period:{},selection:{days:7,topic:'summary'}}) {
  if (config.aiWeeklyPaidEnabled !== true) return generateGemini(records,locale,model,beforeSend,context);
  return generateOpenRouter(records,locale,model,beforeSend,context);
}
module.exports = { available, generate, timeoutMs, describe, inputBound };
