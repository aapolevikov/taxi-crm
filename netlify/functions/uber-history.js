// netlify/functions/uber-history.js
// v1.0 — Читалка накопленной Uber-истории из Netlify Blobs.
// CRM зовёт: GET /.netlify/functions/uber-history?start=YYYY-MM-DD&end=YYYY-MM-DD
// Возвращает историю в ТОЙ ЖЕ форме, что хранится в localStorage CRM:
//   { ok:true, history: { "YYYY-MM-DD": { "<uuid>": {trips,hoursOnline,income}, ... }, ... } }
//
// Если период не задан — отдаёт последние 31 день (на основе ключей в сторе).
//
// ВАЖНО: connectLambda(event) перед getStore (Lambda-режим).

const { connectLambda, getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8'
};

function datesBetween(from, to) {
  const out = [];
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try { connectLambda(event); } catch (e) {}

  try {
    const store = getStore({ name: 'uber-history', consistency: 'strong' });
    const qs = event.queryStringParameters || {};

    let days;
    if (qs.start && qs.end) {
      days = datesBetween(qs.start, qs.end);
    } else {
      // Нет периода → берём все ключи стора (это и есть имеющиеся даты).
      const listed = await store.list();
      days = (listed && listed.blobs ? listed.blobs.map(b => b.key) : []).sort();
    }

    const history = {};
    // Тянем дни параллельно, мягко игнорируя отсутствующие.
    await Promise.all(days.map(async (day) => {
      try {
        const rec = await store.get(day, { type: 'json' });
        if (rec) {
          // Убираем служебное поле _meta из выдачи в CRM (оставляем только водителей).
          const clean = {};
          Object.keys(rec).forEach(k => { if (k !== '_meta') clean[k] = rec[k]; });
          history[day] = clean;
        }
      } catch (e) { /* день отсутствует — пропускаем */ }
    }));

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: true, count: Object.keys(history).length, history })
    };
  } catch (err) {
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: false, reason: 'EXCEPTION', error: String(err && err.message || err), history: {} })
    };
  }
};
