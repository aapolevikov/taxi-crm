// Mr Ride CRM — Bolt scheduled cron + backfill.
//
// Two modes:
//   1. Default (no params): pulls TODAY's Bolt data and stores it in Blobs
//      under key YYYY-MM-DD. Used by the scheduled hourly run.
//   2. Backfill (?from=YYYY-MM-DD&to=YYYY-MM-DD): pulls every day in the
//      range and stores each one. Use this once to seed history.
//
// Schedule (in netlify.toml):
//   [functions."bolt-cron"]
//     schedule = "0 * * * *"   (every hour, on the hour)

const { getStore, connectLambda } = require('@netlify/blobs');

// Dubai-local date (UTC+4)
function _todayDubai() {
  const t = new Date(Date.now() + 4 * 3600 * 1000);
  return t.toISOString().slice(0, 10);
}

function _datesBetween(from, to) {
  const out = [];
  const start = new Date(from + 'T00:00:00Z');
  const end   = new Date(to   + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function _fetchDaySnapshot(day, base) {
  const apiUrl = base + '/.netlify/functions/bolt-api?start=' + day + '&end=' + day;
  const resp = await fetch(apiUrl);
  const json = await resp.json();
  if (!json || !json.ok || !Array.isArray(json.drivers)) {
    return { ok: false, day, response: json };
  }
  const snapshot = {};
  json.drivers.forEach(d => {
    if (!d.uuid) return;
    snapshot[d.uuid] = {
      trips:        Number(d.totalTrips)    || 0,
      income:       Number(d.totalEarnings) || 0,
      hoursOnTrip:  Number(d.hoursOnTrip)   || 0,
      mileage:      Number(d.mileage)       || 0,
      cashEarnings: Number(d.cashEarnings)  || 0,
      cardEarnings: Number(d.cardEarnings)  || 0
    };
  });
  return { ok: true, day, snapshot };
}

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };
  try {
    connectLambda(event);
    const store = getStore('bolt-history');
    const base = process.env.URL || 'https://misterridegroup.com';

    const qp = (event && event.queryStringParameters) || {};

    // BACKFILL MODE — fill a date range one-shot
    if (qp.from && qp.to) {
      const days = _datesBetween(qp.from, qp.to);
      const results = [];
      for (const day of days) {
        const res = await _fetchDaySnapshot(day, base);
        if (res.ok) {
          await store.set(day, JSON.stringify(res.snapshot));
          results.push({ day, driversStored: Object.keys(res.snapshot).length });
        } else {
          results.push({ day, error: 'bad response', response: res.response });
        }
      }
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          ok: true,
          mode: 'backfill',
          from: qp.from, to: qp.to,
          daysProcessed: results.length,
          results
        }, null, 2)
      };
    }

    // DEFAULT MODE — pull today's data and store it
    const day = _todayDubai();
    const res = await _fetchDaySnapshot(day, base);
    if (!res.ok) {
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          ok: false, reason: 'BOLT_API_BAD',
          dayKey: day, response: res.response
        })
      };
    }
    await store.set(day, JSON.stringify(res.snapshot));
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: true, mode: 'hourly',
        dayKey: day, driversStored: Object.keys(res.snapshot).length
      })
    };
  } catch (e) {
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: false, reason: 'BOLT_CRON_ERROR',
        error: String(e.message || e),
        stack: String(e.stack || '')
      })
    };
  }
};
