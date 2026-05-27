// netlify/functions/uber-proxy.js
// Proxy для Uber Fleet API - обходит CORS и держит секреты на сервере
// Использует Client Credentials grant для получения access token

const UBER_LOGIN_URL = 'https://login.uber.com/oauth/v2/token';
const UBER_API_BASE = 'https://api.uber.com';

// Кэш токена в памяти функции (живёт между вызовами пока функция тёплая)
let cachedToken = null;
let cachedTokenExpiresAt = 0;

/**
 * Получает access token от Uber (с кэшированием)
 */
async function getAccessToken(scopes) {
  const now = Date.now();

  // Если токен есть и валиден ещё минимум 60 секунд - используем его
  if (cachedToken && cachedTokenExpiresAt > now + 60_000) {
    return cachedToken;
  }

  const clientId = process.env.UBER_CLIENT_ID;
  const clientSecret = process.env.UBER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('UBER_CLIENT_ID or UBER_CLIENT_SECRET is not set in Netlify environment variables');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
    scope: scopes || 'supplier.partner.payments solutions.suppliers.drivers.status.read'
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
    throw new Error(`Uber OAuth returned non-JSON (HTTP ${response.status}): ${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`Uber OAuth error (HTTP ${response.status}): ${JSON.stringify(data)}`);
  }

  if (!data.access_token) {
    throw new Error(`Uber OAuth: no access_token in response: ${JSON.stringify(data)}`);
  }

  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + (data.expires_in || 3600) * 1000;

  return cachedToken;
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

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  try {
    // Параметры из query string или из тела
    const params = event.queryStringParameters || {};
    const action = params.action || 'probe';

    // === ACTION: probe ===
    // Просто получаем токен и возвращаем какие scopes одобрены
    if (action === 'probe') {
      const requestedScopes = params.scopes || 'supplier.partner.payments solutions.suppliers.drivers.status.read';
      const token = await getAccessToken(requestedScopes);

      // Декодируем JWT чтобы посмотреть какие scopes реально выданы
      let tokenInfo = null;
      try {
        const parts = token.split('.');
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
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          message: 'Token obtained successfully',
          requested_scopes: requestedScopes,
          token_preview: token.slice(0, 20) + '...',
          token_info: tokenInfo
        })
      };
    }

    // === ACTION: api ===
    // Универсальный прокси к любому Uber API endpoint
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
      const token = await getAccessToken(scopes);

      const url = endpoint.startsWith('http') ? endpoint : `${UBER_API_BASE}${endpoint}`;

      const response = await fetch(url, {
        method: event.httpMethod === 'POST' ? 'POST' : 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
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
        })
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
