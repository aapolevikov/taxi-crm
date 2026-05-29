// Mr Ride CRM — Bolt Fleet Integration API
// Netlify Function. Fetches drivers + aggregated orders per driver
// for a given period. Mirrors uber-portal.js in structure so the
// frontend can consume it the same way.
//
// Usage:
//   GET /.netlify/functions/bolt-api?start=2026-05-29&end=2026-05-29
//   GET /.netlify/functions/bolt-api?start=2026-05-29&end=2026-05-29&debug=1
//
// Returns:
//   {
//     ok: true,
//     period: { start, end },
//     count: N,
//     drivers: [
//       {
//         uuid, name, phone, status,
//         totalTrips, totalEarnings,
//         cashEarnings, cardEarnings,
//         hoursOnline,            // not always available from orders alone
//         acceptanceRate,         // 0..1 if returned by API
//         cancellationRate,       // 0..1 if returned by API
//         rating,                 // ★ if returned
//       }
//     ]
//   }

const BOLT_BASE = 'https://node.bolt.eu/fleet-integration-gateway';

async function getToken() {
  const id = process.env.BOLT_CLIENT_ID;
  const secret = process.env.BOLT_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error('BOLT_CLIENT_ID or BOLT_CLIENT_SECRET missing');
  }
  const r = await fetch('https://oidc.bolt.eu/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      grant_type: 'client_credentials',
      scope: 'fleet-integration:api'
    }).toString()
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) {
    throw new Error('Token request failed: ' + JSON.stringify(d));
  }
  return d.access_token;
}

async function boltPost(path, token, body) {
  const r = await fetch(BOLT_BASE + path, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const d = await r.json();
  return { status: r.status, body: d };
}

// Fetch all pages of a paginated endpoint (Bolt uses limit/offset)
async function fetchAllPages(path, token, baseBody, dataKey) {
  const out = [];
  let offset = 0;
  const limit = 500;
  for (let i = 0; i < 50; i++) { // hard cap on pages to avoid runaways
    const { status, body } = await boltPost(path, token, {
      ...baseBody,
      limit,
      offset
    });
    if (status !== 200 || !body || body.code !== 0) {
      const err = new Error(path + ' failed: ' + JSON.stringify(body));
      err.sentBody = { ...baseBody, limit, offset };
      err.responseBody = body;
      throw err;
    }
    const chunk = (body.data && body.data[dataKey]) || [];
    out.push(...chunk);
    if (chunk.length < limit) break;
    offset += limit;
  }
  return out;
}

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const qp = event.queryStringParameters || {};
  const debug = qp.debug === '1';
  const todayDubai = new Date(Date.now() + 4 * 3600 * 1000)
    .toISOString().slice(0, 10);
  const start = qp.start || todayDubai;
  const end = qp.end || todayDubai;

  // Parse YYYY-MM-DD into Dubai-local day start (UTC+4) → unix seconds
  const start_ts = Math.floor(new Date(start + 'T00:00:00+04:00').getTime() / 1000);
  const end_ts   = Math.floor(new Date(end   + 'T23:59:59+04:00').getTime() / 1000);

  const companyId = parseInt(process.env.BOLT_COMPANY_ID, 10);
  if (!companyId) {
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ ok: false, error: 'BOLT_COMPANY_ID not set in env' })
    };
  }

  try {
    const token = await getToken();
    // Different Bolt endpoints accept different shapes: some want
    // company_id (singular int), others want company_ids (array).
    // We send both keys so each endpoint reads whichever it expects.
    const baseBody = {
      company_id: companyId,
      company_ids: [companyId],
      start_ts,
      end_ts
    };

    // STEP A — Drivers list (full roster, not just active in period)
    const drivers = await fetchAllPages(
      '/fleetIntegration/v1/getDrivers',
      token,
      baseBody,
      'drivers'
    );

    // STEP B — Orders in the period (detailed list)
    const orders = await fetchAllPages(
      '/fleetIntegration/v1/getFleetOrders',
      token,
      baseBody,
      'orders'
    );

    // STEP C — State logs (online sessions) — may be heavy; tolerate failures
    let stateLogs = [];
    try {
      stateLogs = await fetchAllPages(
        '/fleetIntegration/v1/getFleetStateLogs',
        token,
        baseBody,
        'state_logs'
      );
    } catch (e) {
      // Non-fatal: continue without online hours
      stateLogs = [];
    }

    // ─── Aggregate per driver ───
    // Index helpers
    const byDriverUuid = new Map();
    for (const d of drivers) {
      const uuid = d.id || d.uuid || d.driver_id || d.driverUuid;
      if (!uuid) continue;
      byDriverUuid.set(String(uuid), {
        uuid: String(uuid),
        name: d.name || [d.first_name, d.last_name].filter(Boolean).join(' ') || '',
        phone: d.phone || d.phone_number || '',
        status: d.state || d.status || '',
        rating: d.rating || null,
        acceptanceRate: d.acceptance_rate != null ? d.acceptance_rate
                       : d.acceptanceRate != null ? d.acceptanceRate : null,
        cancellationRate: d.cancellation_rate != null ? d.cancellation_rate
                         : d.cancellationRate != null ? d.cancellationRate : null,
        totalTrips: 0,
        totalEarnings: 0,
        cashEarnings: 0,
        cardEarnings: 0,
        hoursOnline: 0
      });
    }

    // Order → driver aggregation
    for (const o of orders) {
      const dUuid = String(o.driver_id || o.driver_uuid || o.driverId || '');
      if (!dUuid) continue;
      const rec = byDriverUuid.get(dUuid);
      if (!rec) continue;
      // Only count completed (Bolt has finished_state or status field)
      const finished = (o.status === 'finished' || o.status === 'completed' ||
                       o.state === 'finished'  || o.finished_state === 'finished');
      if (!finished) continue;
      rec.totalTrips += 1;
      const earn = parseFloat(o.driver_earnings || o.driver_amount ||
                              o.earnings || o.amount || o.ride_price || 0) || 0;
      rec.totalEarnings += earn;
      const payMethod = String(o.payment_method || o.pay_method || '').toLowerCase();
      if (payMethod.includes('cash')) rec.cashEarnings += earn;
      else rec.cardEarnings += earn;
    }

    // State logs → online hours
    // Bolt state log records typically have driver_id, state ('online'/'busy'/'offline'),
    // start_ts, end_ts (or duration). We sum durations where state implies active work.
    for (const log of stateLogs) {
      const dUuid = String(log.driver_id || log.driver_uuid || '');
      if (!dUuid) continue;
      const rec = byDriverUuid.get(dUuid);
      if (!rec) continue;
      const state = String(log.state || log.status || '').toLowerCase();
      if (!state || state === 'offline') continue;
      let durSec = 0;
      if (log.duration_seconds) durSec = log.duration_seconds;
      else if (log.duration) durSec = log.duration;
      else if (log.start_ts && log.end_ts) durSec = log.end_ts - log.start_ts;
      if (durSec > 0) rec.hoursOnline += durSec / 3600;
    }

    const driverList = Array.from(byDriverUuid.values()).map(d => ({
      ...d,
      totalEarnings: +d.totalEarnings.toFixed(2),
      cashEarnings: +d.cashEarnings.toFixed(2),
      cardEarnings: +d.cardEarnings.toFixed(2),
      hoursOnline: +d.hoursOnline.toFixed(4)
    }));

    const resp = {
      ok: true,
      period: { start, end, start_ts, end_ts },
      company_id: companyId,
      count: driverList.length,
      drivers: driverList
    };
    if (debug) {
      resp.debug = {
        driversRaw: drivers.length,
        ordersRaw: orders.length,
        stateLogsRaw: stateLogs.length,
        sampleDriver: drivers[0] || null,
        sampleOrder: orders[0] || null,
        sampleStateLog: stateLogs[0] || null
      };
    }

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify(resp, null, debug ? 2 : 0)
    };
  } catch (e) {
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: false,
        reason: 'BOLT_API_ERROR',
        error: String(e.message || e),
        sentBody: e.sentBody || null,
        responseBody: e.responseBody || null,
        stack: debug ? String(e.stack || '') : undefined
      }, null, 2)
    };
  }
};
