// netlify/functions/uber-proxy.js
// Proxy для Uber Fleet Supplier API
// v3: используем только одобренные scopes, добавлены тесты реальных endpoints

const UBER_LOGIN_URL = 'https://login.uber.com/oauth/v2/token';
const UBER_API_BASE = 'https://api.uber.com';

// Одобренные scopes (подтверждены тестом 27.05.2026)
const APPROVED_SCOPES = [
  'supplier.partner.payments',
  'solutions.suppliers.drivers.status.read',
  'vehicle_suppliers.organizations.read',
  'vehicle_suppliers.vehicles.read'
];

const DEFAULT_SCOPES = APPROVED_SCOPES.join(' ');

// Кэш токена в памяти функции
let cachedToken = null;
let cachedTokenExpiresAt = 0;
let cachedScopes = null;

/**
 * Получает access token от Uber (с кэшированием)
 */
async function getAccessToken(scopes) {
  const now = Date.now();
  const scopesKey = scopes || DEFAULT_SCOPES;

  // Используем кэш если scopes совпадают и токен валиден ещё минимум 60 сек
  if (cachedToken && cachedScopes === scopesKey && cachedTokenExpiresAt > now + 60_000) {
    return { ok: true, access_token: cachedToken, from_cache: true };
  }

  const clientId = process.env.UBER_CLIENT_ID;
  const clientSecret = process.env.UBER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return { ok: false, error: 'UBER_CLIENT_ID or UBER_CLIENT_SECRET not set in Netlify env' };
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
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Non-JSON response (HTTP ${response.status}): ${text.slice(0, 300)}` };
  }

  if (!response.ok || !data.access_token) {
    return { ok: false, status: response.status, error: data };
  }

  // Кэшируем
  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + (data.expires_in || 3600) * 1000;
  cachedScopes = scopesKey;

  // Декодируем JWT для информации
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

  return {
    ok: true,
    access_token: data.access_token,
    expires_in: data.expires_in,
    token_info: tokenInfo,
    from_cache: false
  };
}

/**
 * Вызывает Uber API endpoint с автоматической аутентификацией
 */
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

  return {
    ok: response.ok,
    status: response.status,
    endpoint: url,
    data: data
  };
}

/**
 * Главный обработчик Netlify Function
 */
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
    // Просто получает токен с дефолтными или указанными scopes
    if (action === 'probe') {
      const scopes = params.scopes || DEFAULT_SCOPES;
      const result = await getAccessToken(scopes);
      return respond(200, {
        action: 'probe',
        requested_scopes: scopes,
        result: result.ok ? {
          ok: true,
          message: 'Token obtained',
          token_info: result.token_info,
          from_cache: result.from_cache
        } : result
      });
    }

    // === ACTION: organizations ===
    // Получает информацию об организации
    if (action === 'organizations') {
      const result = await callUberApi(
        '/v1/suppliers/organizations',
        'vehicle_suppliers.organizations.read'
      );
      return respond(200, { action: 'organizations', ...result });
    }

    // === ACTION: vehicles ===
    // Получает список автомобилей
    if (action === 'vehicles') {
      const orgId = params.org_id || process.env.UBER_ORG_ID || '';
      const endpoint = orgId
        ? `/v1/suppliers/organizations/${orgId}/vehicles`
        : '/v1/suppliers/vehicles';
      const result = await callUberApi(endpoint, 'vehicle_suppliers.vehicles.read');
      return respond(200, { action: 'vehicles', org_id: orgId, ...result });
    }

    // === ACTION: drivers-status ===
    // Получает статусы водителей (онлайн/оффлайн)
    if (action === 'drivers-status') {
      const result = await callUberApi(
        '/v1/suppliers/drivers/status',
        'solutions.suppliers.drivers.status.read'
      );
      return respond(200, { action: 'drivers-status', ...result });
    }

    // === ACTION: payments ===
    // Получает выплаты водителям
    if (action === 'payments') {
      const result = await callUberApi(
        '/v1/partners/payments',
        'supplier.partner.payments'
      );
      return respond(200, { action: 'payments', ...result });
    }

    // === ACTION: try-endpoints ===
    // Перебирает кучу разных endpoints чтобы найти рабочие
    if (action === 'try-endpoints') {
      const endpointsToTry = [
        { path: '/v1/suppliers/organizations', scope: 'vehicle_suppliers.organizations.read' },
        { path: '/v1/suppliers/vehicles', scope: 'vehicle_suppliers.vehicles.read' },
        { path: '/v1/suppliers/drivers/status', scope: 'solutions.suppliers.drivers.status.read' },
        { path: '/v1/partners/payments', scope: 'supplier.partner.payments' },
        { path: '/v1/fleet/drivers', scope: DEFAULT_SCOPES },
        { path: '/v1/fleet/vehicles', scope: DEFAULT_SCOPES },
        { path: '/v1/fleet/trips', scope: DEFAULT_SCOPES },
        { path: '/v1/fleet/payments/driver-payouts', scope: DEFAULT_SCOPES },
        { path: '/v1/organizations', scope: 'vehicle_suppliers.organizations.read' },
        { path: '/v1/vehicles', scope: 'vehicle_suppliers.vehicles.read' }
      ];

      const results = [];
      for (const ep of endpointsToTry) {
        const r = await callUberApi(ep.path, ep.scope);
        results.push({
          endpoint: ep.path,
          status: r.status,
          ok: r.ok,
          data_preview: r.ok
            ? JSON.stringify(r.data).slice(0, 200)
            : (r.data?.message || r.data?.error || JSON.stringify(r.data).slice(0, 200))
        });
      }

      return respond(200, {
        action: 'try-endpoints',
        results: results
      });
    }

    // === ACTION: api ===
    // Универсальный прокси к любому endpoint
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
      available_actions: ['probe', 'organizations', 'vehicles', 'drivers-status', 'payments', 'try-endpoints', 'api']
    });

  } catch (error) {
    return respond(500, {
      ok: false,
      error: error.message,
      stack: error.stack
    });
  }
};
