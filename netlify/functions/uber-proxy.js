// netlify/functions/uber-proxy.js
// Proxy для Uber Fleet API - обходит CORS и держит секреты на сервере
// v2: добавлена возможность тестировать разные scopes через URL параметр

const UBER_LOGIN_URL = 'https://login.uber.com/oauth/v2/token';
const UBER_API_BASE = 'https://api.uber.com';

// Список scopes для попытки auto-detect (если параметр scopes не передан)
const SCOPES_TO_TRY = [
  'supplier.partner.payments',
  'solutions.suppliers.drivers.status.read',
  'vehicle_suppliers.organizations.read',
  'vehicle_suppliers.vehicles.read',
  'vehicle_suppliers.fleet.read',
  'vehicle_suppliers.drivers.read'
];

/**
 * Получает access token от Uber
 */
async function getAccessToken(scopes) {
  const clientId = process.env.UBER_CLIENT_ID;
  const clientSecret = process.env.UBER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('UBER_CLIENT_ID or UBER_CLIENT_SECRET is not set in Netlify environment variables');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
    scope: scopes
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
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Non-JSON response (HTTP ${response.status}): ${text.slice(0, 300)}` };
  }

  if (!response.ok) {
    return { ok: false, status: response.status, error: data };
  }

  if (!data.access_token) {
    return { ok: false, error: 'No access_token in response', data: data };
  }

  // Декодируем JWT чтобы узнать какие scopes реально выданы
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
  } catch (e) {
    tokenInfo = { decode_error: e.message };
  }

  return {
    ok: true,
    access_token: data.access_token,
    expires_in: data.expires_in,
    token_info: tokenInfo
  };
}

/**
 * Главный обработчик Netlify Function
 */
exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  try {
    const params = event.queryStringParameters || {};
    const action = params.action || 'probe';

    // === ACTION: probe ===
    // Пробуем получить токен с указанными scopes
    if (action === 'probe') {
      const scopes = params.scopes || 'supplier.partner.payments solutions.suppliers.drivers.status.read';
      const result = await getAccessToken(scopes);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'probe',
          requested_scopes: scopes,
          result: result
        }, null, 2)
      };
    }

    // === ACTION: probe-all ===
    // Перебираем все возможные scopes по одному и смотрим какие проходят
    if (action === 'probe-all') {
      const results = [];

      // Пробуем каждый scope отдельно
      for (const scope of SCOPES_TO_TRY) {
        const r = await getAccessToken(scope);
        results.push({
          scope: scope,
          ok: r.ok,
          error: r.ok ? null : (r.error?.error_description || r.error?.error || JSON.stringify(r.error)),
          granted_scopes: r.ok ? r.token_info?.scopes : null
        });
      }

      // Пробуем все вместе
      const allScopes = SCOPES_TO_TRY.join(' ');
      const allResult = await getAccessToken(allScopes);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'probe-all',
          per_scope_results: results,
          all_at_once: {
            scopes: allScopes,
            ok: allResult.ok,
            error: allResult.ok ? null : allResult.error,
            granted_scopes: allResult.ok ? allResult.token_info?.scopes : null
          }
        }, null, 2)
      };
    }

    // === ACTION: api ===
    // Вызывает конкретный Uber API endpoint
    if (action === 'api') {
      const endpoint = params.endpoint;
      if (!endpoint) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ok: false, error: 'Missing endpoint parameter' })
        };
      }

      const scopes = params.scopes || 'supplier.partner.payments solutions.suppliers.drivers.status.read';
      const tokenResult = await getAccessToken(scopes);

      if (!tokenResult.ok) {
        return {
          statusCode: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ok: false, stage: 'auth', error: tokenResult.error })
        };
      }

      const url = endpoint.startsWith('http') ? endpoint : `${UBER_API_BASE}${endpoint}`;

      const response = await fetch(url, {
        method: event.httpMethod === 'POST' ? 'POST' : 'GET',
        headers: {
          'Authorization': `Bearer ${tokenResult.access_token}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: event.httpMethod === 'POST' ? event.body : undefined
      });

      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: response.ok,
          status: response.status,
          endpoint: url,
          data: data
        }, null, 2)
      };
    }

    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: `Unknown action: ${action}` })
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: false,
        error: error.message,
        stack: error.stack
      })
    };
  }
};
