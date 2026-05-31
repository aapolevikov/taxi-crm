// netlify/functions/update-uber-cookie.js
// v1.0 — Принимает свежий cookie supplier.uber.com от Chrome-расширения и сохраняет его
// в Blobs store "uber-secrets" под ключом "cookie". Пуллеры читают cookie ОТСЮДА, если он
// там есть, иначе падают обратно на process.env.UBER_PORTAL_COOKIE.
//
// ВАЖНО — БЕЗОПАСНОСТЬ:
//   * Эндпоинт защищён общим секретом UBER_REFRESH_TOKEN (env). Расширение шлёт его в
//     заголовке "x-refresh-token". Без совпадения — 401. Это не даёт посторонним писать cookie.
//   * Cookie — чувствительные данные. Они живут только в Blobs (не в логах). Не логируем значение.
//   * Это НЕ автологин: расширение лишь пересылает cookie из уже залогиненной тобой сессии.
//
// Маршрут:
//   POST /.netlify/functions/update-uber-cookie
//   headers: { "x-refresh-token": "<UBER_REFRESH_TOKEN>", "content-type": "application/json" }
//   body: { "cookie": "<полная строка cookie>" }
//   -> { ok: true, savedAt }

const { connectLambda, getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  try { connectLambda(event); } catch (e) {}

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'method' }) };
  }

  const secret = process.env.UBER_REFRESH_TOKEN || '';
  const got = (event.headers && (event.headers['x-refresh-token'] || event.headers['X-Refresh-Token'])) || '';
  if (!secret || got !== secret) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'bad_json' }) }; }
  const cookie = (body && body.cookie || '').trim();
  // Простая валидация: cookie портала всегда содержит sid= и jwt-session=
  if (!cookie || cookie.length < 50 || !/sid=/.test(cookie)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'cookie_invalid' }) };
  }

  try {
    const store = getStore('uber-secrets');
    await store.setJSON('cookie', { cookie, savedAt: new Date().toISOString() });
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'store_failed' }) };
  }

  // Не возвращаем сам cookie. Только факт сохранения.
  return { statusCode: 200, body: JSON.stringify({ ok: true, savedAt: new Date().toISOString(), length: cookie.length }) };
};
