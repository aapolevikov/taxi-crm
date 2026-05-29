// Mr Ride CRM — Bolt history reader from Netlify Blobs.
// Reads accumulated daily snapshots written by bolt-cron and returns
// the entire history (or a date range) as JSON. Mirrors uber-history.js.

const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    connectLambda(event);
    const store = getStore('bolt-history');
    const qp = event.queryStringParameters || {};
    // Optional date range filter (?from=YYYY-MM-DD&to=YYYY-MM-DD)
    const from = qp.from || null;
    const to   = qp.to   || null;

    // List all stored keys (each key = YYYY-MM-DD)
    const list = await store.list();
    const keys = (list && list.blobs) ? list.blobs.map(b => b.key) : [];
    const filtered = keys.filter(k => {
      if (from && k < from) return false;
      if (to   && k > to)   return false;
      return true;
    });

    const history = {};
    for (const day of filtered) {
      try {
        const raw = await store.get(day);
        if (!raw) continue;
        history[day] = (typeof raw === 'string') ? JSON.parse(raw) : raw;
      } catch (e) { /* skip broken day */ }
    }

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: true, count: Object.keys(history).length, history })
    };
  } catch (e) {
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: false, reason: 'BOLT_HISTORY_ERROR',
        error: String(e.message || e)
      })
    };
  }
};
