// netlify/functions/uber-proxy.js
// Proxy для Uber Partners API
// v4: используем правильные имена scopes (partner.*) на основе подсказки Uber

const UBER_LOGIN_URL = 'https://login.uber.com/oauth/v2/token';
const UBER_API_BASE = 'https://api.uber.com';

// Все возможные partner.* scopes для тестирования
const PARTNER_SCOPES_TO_TRY = [
  'partner.payments',
  'partner.payments.internal_driver_id',
  'partner.accounts',
  'partner.me',
  'partner.trips',
  'partner.vehicles',
  'partner.drivers'
];

// Уже подтверждённые (работают)
const APPROVED_SCOPES = [
  'supplier.partner.payments',
  'solutions.suppliers.drivers.status.read',
  'vehicle_suppliers.organizations.read',
  'vehicle_suppliers.vehicles.read'
];

const DEFAULT_SCOPES = APPROVED_SCOPES.join(' ');

let cachedToken = null;
let cachedTokenExpiresAt = 0;
let cachedScopes = null;

async function getAccessToken(scopes) {
  const now = Date.now();
  const scopesKey = scopes || DEFAULT_SCOPES;

  if (cachedToken && cachedScopes === scopesKey && cachedTokenExpiresAt > now + 60_000) {
    return { ok: true, access_token: cachedToken, from_cache: true };
  }

  const clientId = process.env.UBER_CLIENT_ID;
  const clientSecret = process.env.UBER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return { ok: false, error: 'UBER_CLIENT_ID or UBER_CLIENT_SECRET not set' };
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
    scope: scopesKey
  });

  const response = await fetch(UBER_LOGIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: body.toString()
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch (e) { return { ok: false, error: `Non-JSON: ${text.slice(0, 300)}` }; }

  if (!response.ok || !data.access_token) {
    return { ok: false, status: response.status, error: data };
  }

  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + (data.expires_in || 3600) * 1000;
  cachedScopes = scopesKey;

  let tokenInfo = null;
  try {
    const parts = data.access_token.split('.');
    if (parts.length >= 2) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
      tokenInfo = {
        scopes: payload.scopes || payload.scope || null,
        client_id: payload.client_id || null,
        expires_at: payload.exp ? new Date(payload.exp * 1000).toISOString() : null
      };
    }
  } catch (e) {}

  return { ok: true, access_token: data.access_token, expires_in: data.expires_in, token_info: tokenInfo };
}

async function callUberApi(endpoint, scopes, method, body) {
  const tokenResult = await getAccessToken(scopes);
  if (!tokenResult.ok) {
    return { ok: false, stage: 'auth', error: tokenResult.error };
  }

  const url = endpoint.startsWith('http') ? endpoint : `${UBER_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    method: method || 'GET',
    headers: {
      'Authorization': `Bearer ${tokenResult.access_token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: body
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 1000) }; }

  return { ok: response.ok, status: response.status, endpoint: url, data: data };
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  const respond = (statusCode, body) => ({
    statusCode,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body, null, 2)
  });

  try {
    const params = event.queryStringParameters || {};
    const action = params.action || 'probe';

    // === ACTION: probe ===
    if (action === 'probe') {
      const scopes = params.scopes || DEFAULT_SCOPES;
      const result = await getAccessToken(scopes);
      return respond(200, {
        action: 'probe',
        requested_scopes: scopes,
        result: result.ok ? { ok: true, token_info: result.token_info } : result
      });
    }

    // === ACTION: probe-partner ===
    // Пробуем все partner.* scopes по одному
    if (action === 'probe-partner') {
      const results = [];
      for (const scope of PARTNER_SCOPES_TO_TRY) {
        const r = await getAccessToken(scope);
        results.push({
          scope: scope,
          ok: r.ok,
          error: r.ok ? null : (r.error?.error_description || r.error?.error || JSON.stringify(r.error)),
          granted_scopes: r.ok ? r.token_info?.scopes : null
        });
      }
      return respond(200, { action: 'probe-partner', results });
    }

    // === ACTION: try-partner-endpoints ===
    // Пробуем правильные partner endpoints с partner scopes
    if (action === 'try-partner-endpoints') {
      // Сначала получим все рабочие partner scopes
      const workingScopes = [];
      for (const scope of PARTNER_SCOPES_TO_TRY) {
        const r = await getAccessToken(scope);
        if (r.ok) workingScopes.push(scope);
      }

      // Теперь пробуем endpoints с этими scopes
      const allWorkingScopes = workingScopes.join(' ');
      const endpoints = [
        '/v1/partners/payments',
        '/v1/partners/trips',
        '/v1/partners/me',
        '/v1.2/partners/me',
        '/v1/partners/vehicles',
        '/v1/partners/drivers',
        '/v1/partners/accounts'
      ];

      const results = [];
      for (const ep of endpoints) {
        const r = await callUberApi(ep, allWorkingScopes);
        results.push({
          endpoint: ep,
          status: r.status,
          ok: r.ok,
          data_preview: typeof r.data === 'object'
            ? JSON.stringify(r.data).slice(0, 300)
            : String(r.data).slice(0, 300)
        });
      }

      return respond(200, {
        action: 'try-partner-endpoints',
        working_scopes: workingScopes,
        endpoint_results: results
      });
    }

    // === ACTION: api ===
    if (action === 'api') {
      const endpoint = params.endpoint;
      if (!endpoint) {
        return respond(400, { ok: false, error: 'Missing endpoint parameter' });
      }
      const scopes = params.scopes || DEFAULT_SCOPES;
      const result = await callUberApi(
        endpoint,
        scopes,
        event.httpMethod === 'POST' ? 'POST' : 'GET',
        event.httpMethod === 'POST' ? event.body : undefined
      );
      return respond(200, result);
    }

    return respond(400, {
      ok: false,
      error: `Unknown action: ${action}`,
      available_actions: ['probe', 'probe-partner', 'try-partner-endpoints', 'api']
    });

  } catch (error) {
    return respond(500, {
      ok: false,
      error: error.message,
      stack: error.stack
    });
  }
};
