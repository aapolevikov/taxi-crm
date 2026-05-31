// netlify/functions/uber-reports.js
// v1.0 — HTTP-эндпоинт, через который фронт (app.html) забирает СЫРЫЕ CSV-отчёты Uber,
// собранные cron-функцией uber-report-puller.js в Blobs store "uber-reports".
//
// Фронт прогоняет полученные CSV через свои существующие парсеры
// (_normalizeUberCsv для поездок, _normalizeUberPayments для сумм) — парсер один, на фронте.
//
// Маршруты:
//   GET /.netlify/functions/uber-reports?action=list
//       -> { ok, items: [ { key, type, startDate, endDate, fetchedAt, csv } ... ] }
//       Возвращает последние сохранённые отчёты (по умолчанию за 14 дней, чтобы не раздувать ответ).
//   GET /.netlify/functions/uber-reports?action=list&days=3
//       -> то же, но окно меньше.
//
// connectLambda(event) обязателен перед getStore.

const { connectLambda, getStore } = require('@netlify/blobs');

function dubaiDate(offsetDays) {
  const now = new Date();
  const dubai = new Date(now.getTime() + 4 * 3600000 + (offsetDays || 0) * 86400000);
  return dubai.toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  try { connectLambda(event); } catch (e) {}

  const params = (event && event.queryStringParameters) || {};
  const action = params.action || 'list';

  if (action !== 'list') {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'unknown action' }) };
  }

  const days = Math.max(1, Math.min(60, parseInt(params.days, 10) || 14));
  const cutoff = dubaiDate(-days); // YYYY-MM-DD, всё что новее берём

  const store = getStore('uber-reports');
  let listing;
  try {
    listing = await store.list(); // { blobs: [ {key}, ... ] }
  } catch (e) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'list_failed', items: [] }) };
  }

  const keys = ((listing && listing.blobs) || []).map(b => b.key);
  // key формат: "<type>__<YYYY-MM-DD>"; фильтруем по дате окна
  const wanted = keys.filter(k => {
    const day = k.split('__')[1] || '';
    return day >= cutoff;
  });

  const items = [];
  for (const key of wanted) {
    try {
      const rec = await store.get(key, { type: 'json' });
      if (rec && rec.csv) {
        items.push({
          key,
          type: rec.type || key.split('__')[0],
          startDate: rec.startDate || '',
          endDate: rec.endDate || '',
          fetchedAt: rec.fetchedAt || '',
          csv: rec.csv
        });
      }
    } catch (e) { /* skip broken key */ }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, items })
  };
};
