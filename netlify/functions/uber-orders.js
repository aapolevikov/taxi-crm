// netlify/functions/uber-orders.js
//
// Storage for Uber trips imported from "trip_activity" CSV reports
// downloaded from supplier.uber.com. Each trip is uniquely identified by
// trip_uuid; we shard storage by month (YYYY-MM derived from end_ms) so
// upserts stay small and individual months can be re-imported without
// touching the rest.
//
// API:
//   GET  /uber-orders?action=list                 → { ok, trips:[...] }
//   POST /uber-orders?action=upsert  body:{trips:[...]}  → { ok, added, updated, months:[...] }
//
// Blobs layout:
//   store name: "uber-orders"
//   key:        "<YYYY-MM>"
//   value:      { trips: [ {trip_uuid, driver_uuid, ...}, ... ] }

const { getStore, connectLambda } = require('@netlify/blobs');

const STORE_NAME = 'uber-orders';
const MAX_MONTHS_FOR_LIST = 36;   // hard cap to avoid runaway responses

function monthKey(endMs){
  const d = new Date(Number(endMs) || Date.now());
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return y + '-' + m;
}

function jsonResp(statusCode, body){
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  try {
    connectLambda(event);
  } catch (e) {
    // connectLambda is only required outside the Netlify runtime; ignore if it
    // throws when running in production.
  }

  const action = (event.queryStringParameters && event.queryStringParameters.action) || '';
  const method = event.httpMethod || 'GET';
  let store;
  try { store = getStore(STORE_NAME); }
  catch (e) { return jsonResp(500, { ok:false, error:'Blobs store unavailable: ' + (e.message || e) }); }

  // ─────────────────────────── LIST ───────────────────────────
  if (action === 'list' && method === 'GET') {
    try {
      const list = await store.list();
      const keys = (list && list.blobs ? list.blobs : []).map(b => b.key);
      // Newest months first
      keys.sort().reverse();
      const monthsToFetch = keys.slice(0, MAX_MONTHS_FOR_LIST);
      const out = [];
      for (const key of monthsToFetch) {
        try {
          const raw = await store.get(key, { type: 'json' });
          if (raw && Array.isArray(raw.trips)) out.push(...raw.trips);
        } catch (e) {
          console.warn('[uber-orders] failed to read', key, e.message);
        }
      }
      out.sort((a, b) => (b.end_ms || 0) - (a.end_ms || 0));
      return jsonResp(200, { ok: true, trips: out, months: monthsToFetch });
    } catch (e) {
      console.error('[uber-orders] list failed', e);
      return jsonResp(500, { ok:false, error: e.message || String(e) });
    }
  }

  // ─────────────────────────── UPSERT ───────────────────────────
  if (action === 'upsert' && method === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (e) { return jsonResp(400, { ok:false, error:'invalid JSON body' }); }
    const incoming = Array.isArray(body.trips) ? body.trips : [];
    if (!incoming.length) return jsonResp(200, { ok:true, added:0, updated:0, months:[] });

    // Bucket by month, drop trips without identifying info
    const byMonth = new Map();
    for (const t of incoming) {
      if (!t || !t.trip_uuid || !t.driver_uuid || !t.end_ms) continue;
      const k = monthKey(t.end_ms);
      if (!byMonth.has(k)) byMonth.set(k, []);
      byMonth.get(k).push(t);
    }
    if (!byMonth.size) return jsonResp(200, { ok:true, added:0, updated:0, months:[] });

    let added = 0, updated = 0;
    const monthsTouched = [];
    for (const [mk, trips] of byMonth.entries()) {
      let existing = null;
      try { existing = await store.get(mk, { type: 'json' }); } catch (e) {}
      const current = (existing && Array.isArray(existing.trips)) ? existing.trips : [];
      const byUuid = new Map(current.map(t => [t.trip_uuid, t]));
      for (const t of trips) {
        if (byUuid.has(t.trip_uuid)) {
          byUuid.set(t.trip_uuid, t);
          updated++;
        } else {
          byUuid.set(t.trip_uuid, t);
          added++;
        }
      }
      const merged = Array.from(byUuid.values()).sort((a, b) => (b.end_ms || 0) - (a.end_ms || 0));
      try {
        await store.setJSON(mk, { trips: merged, updated_at: Date.now() });
        monthsTouched.push(mk);
      } catch (e) {
        console.error('[uber-orders] failed to write', mk, e);
        return jsonResp(500, { ok:false, error: 'write failed for ' + mk + ': ' + (e.message || e) });
      }
    }
    return jsonResp(200, { ok:true, added, updated, months: monthsTouched });
  }

  return jsonResp(400, { ok:false, error: 'unknown action; use ?action=list (GET) or ?action=upsert (POST)' });
};
