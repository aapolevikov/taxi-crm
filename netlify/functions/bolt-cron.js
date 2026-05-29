// Mr Ride CRM — Bolt scheduled cron.
// Pulls today's Bolt data via internal bolt-api function and stores the
// per-driver snapshot in Netlify Blobs under key YYYY-MM-DD (Dubai date).
// Schedule this in netlify.toml under [functions."bolt-cron"]:
//   schedule = "0 * * * *"   (every hour, on the hour)

const { getStore, connectLambda } = require('@netlify/blobs');

// Dubai-local date (UTC+4)
function _todayDubai() {
  const t = new Date(Date.now() + 4 * 3600 * 1000);
  return t.toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };
  try {
    connectLambda(event);

    // Use today's Dubai date as the snapshot key. We re-pull and overwrite
    // throughout the day so the "today" record stays fresh.
    const day = _todayDubai();

    // Call our own bolt-api function to get the aggregates.
    // Use full URL (Netlify functions can call siblings via deploy URL).
    const base = process.env.URL || 'https://misterridegroup.com';
    const apiUrl = base + '/.netlify/functions/bolt-api?start=' + day + '&end=' + day;

    const resp = await fetch(apiUrl);
    const json = await resp.json();
    if (!json || !json.ok || !Array.isArray(json.drivers)) {
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          ok: false, reason: 'BOLT_API_BAD',
          dayKey: day, response: json
        })
      };
    }

    // Reshape into the same format that the frontend already expects:
    //   { uuid: { trips, income, hoursOnTrip, mileage, cashEarnings, cardEarnings } }
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

    const store = getStore('bolt-history');
    await store.set(day, JSON.stringify(snapshot));

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: true, dayKey: day, driversStored: Object.keys(snapshot).length
      })
    };
  } catch (e) {
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: false, reason: 'BOLT_CRON_ERROR',
        error: String(e.message || e)
      })
    };
  }
};
