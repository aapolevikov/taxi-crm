// Netlify Function: прокси к Nomod API.
// Ключ хранится ТОЛЬКО в переменной окружения Netlify: NOMOD_API_KEY (sk_live_... или sk_test_...)
// Фронт (tourism.html) ключа не видит. Разрешён ограниченный список действий.

const NOMOD_BASE = 'https://api.nomod.com/v1';

exports.handler = async function (event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'POST only' }) };

  const KEY = process.env.NOMOD_API_KEY;
  if (!KEY) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'NOMOD_API_KEY не задан в Netlify Environment variables' }) };

  let req = {};
  try { req = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'bad json' }) }; }

  const action = req.action || '';
  let method = 'GET', path = '', body = null;

  if (action === 'create_link') { method = 'POST'; path = '/links'; body = req.payload || {}; }
  else if (action === 'get_link') { method = 'GET'; path = '/links/' + encodeURIComponent(req.id || ''); }
  else if (action === 'list_charges') { method = 'GET'; path = '/charges' + (req.query ? ('?' + req.query) : ''); }
  else if (action === 'currencies') { method = 'GET'; path = '/currencies'; }
  else return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'unknown action' }) };

  try {
    const resp = await fetch(NOMOD_BASE + path, {
      method: method,
      headers: { 'X-API-KEY': KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body)
    });
    const text = await resp.text();
    return { statusCode: resp.status, headers: cors, body: text || '{}' };
  } catch (e) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: String(e && e.message || e) }) };
  }
};
