const https = require('https');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Action, X-Fleet-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  const action = event.headers['x-action'] || 'token';
  const fleetId = event.headers['x-fleet-id'] || '';
  const clientId = process.env.UBER_CLIENT_ID;
  const clientSecret = process.env.UBER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  try {
    if (action === 'token') {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        scope: 'fleet.drivers fleet.vehicles fleet.trips fleet.financials',
      }).toString();
      const r = await req({
        hostname: 'auth.uber.com',
        path: '/oauth/v2/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      }, body);
      return { statusCode: r.status, headers: { ...cors, 'Content-Type': 'application/json' }, body: r.body };
    }

    const token = (event.headers['authorization'] || '').replace('Bearer ', '');
    const paths = {
      drivers: '/v1/fleet/drivers?fleet_id=' + fleetId + '&limit=100',
      vehicles: '/v1/fleet/vehicles?fleet_id=' + fleetId + '&limit=100',
      trips: '/v1/fleet/trips?fleet_id=' + fleetId + '&limit=50',
      payments: '/v1/fleet/payments/driver-payouts?fleet_id=' + fleetId,
    };
    if (!paths[action]) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Unknown action' }) };

    const r = await req({
      hostname: 'api.uber.com',
      path: paths[action],
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    });
    return { statusCode: r.status, headers: { ...cors, 'Content-Type': 'application/json' }, body: r.body };

  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};

function req(options, body = '') {
  return new Promise((resolve, reject) => {
    const r = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
