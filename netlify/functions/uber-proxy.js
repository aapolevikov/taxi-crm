// netlify/functions/uber-proxy.js
// Proxy для Uber Vehicle Suppliers API
// v9: добавлены per-driver endpoints (payments/timeline/performance)
// vehicles: /v2/vehicle-suppliers/vehicles
// drivers:  /v1/vehicle-suppliers/drivers
// payments: /v1/vehicle-suppliers/earners/payments (с поддержкой driver_id)
// timeline: /v1/vehicle-suppliers/driver/timeline-info (POST)
// performance: /v1/vehicle-suppliers/suppliers/{org_id}/performance-data (POST)

const UBER_LOGIN_URL = 'https://login.uber.com/oauth/v2/token';
const UBER_API_BASE = 'https://api.uber.com';

const SCOPES_TO_TRY = [
  'supplier.partner.payments',
  'solutions.suppliers.drivers.status.read',
  'solutions.suppliers.metrics.read',
  'vehicle_suppliers.organizations.read',
  'vehicle_suppliers.vehicles.read',
  // v9: новые scopes для per-driver данных
  'supplier.driver.activity.read',
  'supplier.performance.read',
  'supplier.transactions.read'
];

const DEFAULT_SCOPES = SCOPES_TO_TRY.join(' ');

let cachedToken = null;
let cachedTokenExpiresAt = 0;
let cachedScopes = null;
let cachedApiOrgId = null;

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
  
  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('grant_type', 'client_credentials');
  params.append('scope', scopesKey);
  
  try {
    const response = await fetch(UBER_LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      return { 
        ok: false, 
        error: data.error_description || data.error, 
        status: response.status,
        raw: data
      };
    }
    
    cachedToken = data.access_token;
    cachedTokenExpiresAt = now + (data.expires_in * 1000);
    cachedScopes = scopesKey;
    
    return { 
      ok: true, 
      access_token: data.access_token,
      expires_in: data.expires_in,
      scope: data.scope,
      from_cache: false
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function callUberAPI(endpoint, token, method = 'GET', body = null) {
  const url = `${UBER_API_BASE}${endpoint}`;
  
  try {
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    };
    if (body) options.body = JSON.stringify(body);
    
    const response = await fetch(url, options);
    const text = await response.text();
    
    let data;
    try { 
      data = JSON.parse(text); 
    } catch { 
      data = { raw_text: text.substring(0, 500) };
    }
    
    return { 
      ok: response.ok, 
      status: response.status, 
      endpoint, 
      data 
    };
  } catch (err) {
    return { ok: false, endpoint, error: err.message };
  }
}

async function getApiOrgId(token) {
  if (cachedApiOrgId) return cachedApiOrgId;
  
  const r = await callUberAPI('/v1/vehicle-suppliers/orgs', token);
  if (r.ok && r.data?.organizations?.length > 0) {
    cachedApiOrgId = r.data.organizations[0].id;
    return cachedApiOrgId;
  }
  return null;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  
  const params = event.queryStringParameters || {};
  const action = params.action || 'info';
  
  try {
    // === Token ===
    if (action === 'token') {
      const result = await getAccessToken();
      return { 
        statusCode: result.ok ? 200 : 400, 
        headers, 
        body: JSON.stringify(result, null, 2) 
      };
    }
    
    // === Список организаций ===
    if (action === 'orgs') {
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      const r = await callUberAPI(`/v1/vehicle-suppliers/orgs`, tokenResult.access_token);
      return { statusCode: r.ok ? 200 : r.status, headers, body: JSON.stringify(r, null, 2) };
    }
    
    // === 🚗 МАШИНЫ ===
    if (action === 'vehicles') {
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      const apiOrgId = await getApiOrgId(tokenResult.access_token);
      if (!apiOrgId) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'No org ID' }, null, 2) };
      }
      const r = await callUberAPI(`/v2/vehicle-suppliers/vehicles?org_id=${encodeURIComponent(apiOrgId)}&page_size=50`, tokenResult.access_token);
      return { statusCode: r.ok ? 200 : r.status, headers, body: JSON.stringify(r, null, 2) };
    }
    
    // === 👤 ВОДИТЕЛИ (с правильным endpoint!) ===
    if (action === 'drivers') {
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      const apiOrgId = await getApiOrgId(tokenResult.access_token);
      if (!apiOrgId) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'No org ID' }, null, 2) };
      }
      // ПРАВИЛЬНЫЙ endpoint: /v1/vehicle-suppliers/drivers (не /earners!)
      const r = await callUberAPI(`/v1/vehicle-suppliers/drivers?org_id=${encodeURIComponent(apiOrgId)}&page_size=50&include_assigned_vehicles=true`, tokenResult.access_token);
      return { statusCode: r.ok ? 200 : r.status, headers, body: JSON.stringify(r, null, 2) };
    }
    
    // === 💰 ВЫПЛАТЫ (за последние 24 часа) ===
    if (action === 'payments') {
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      const apiOrgId = await getApiOrgId(tokenResult.access_token);
      if (!apiOrgId) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'No org ID' }, null, 2) };
      }
      // Время в миллисекундах для последних 24 часов
      const endTime = Date.now();
      const startTime = endTime - (24 * 60 * 60 * 1000);
      const r = await callUberAPI(`/v1/vehicle-suppliers/earners/payments?org_id=${encodeURIComponent(apiOrgId)}&page_size=50&start_time=${startTime}&end_time=${endTime}`, tokenResult.access_token);
      return { statusCode: r.ok ? 200 : r.status, headers, body: JSON.stringify(r, null, 2) };
    }
    
    // === 📊 СТАТУС ВОДИТЕЛЕЙ В РЕАЛЬНОМ ВРЕМЕНИ ===
    if (action === 'drivers-status') {
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      const apiOrgId = await getApiOrgId(tokenResult.access_token);
      if (!apiOrgId) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'No org ID' }, null, 2) };
      }
      const r = await callUberAPI(`/v1/vehicle-suppliers/drivers/status?org_id=${encodeURIComponent(apiOrgId)}&page_size=50`, tokenResult.access_token);
      return { statusCode: r.ok ? 200 : r.status, headers, body: JSON.stringify(r, null, 2) };
    }
    
    // === 📍 LIVE LOCATION ВОДИТЕЛЕЙ ===
    if (action === 'drivers-location') {
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      const apiOrgId = await getApiOrgId(tokenResult.access_token);
      if (!apiOrgId) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'No org ID' }, null, 2) };
      }
      const r = await callUberAPI(`/v1/vehicle-suppliers/drivers/live-location?org_id=${encodeURIComponent(apiOrgId)}&page_size=50`, tokenResult.access_token);
      return { statusCode: r.ok ? 200 : r.status, headers, body: JSON.stringify(r, null, 2) };
    }
    
    // === 💰 v9: PER-DRIVER PAYMENTS (выплаты по конкретному водителю за 24ч) ===
    // Док: /v1/vehicle-suppliers/earners/payments?driver_id=...
    // Должен работать с текущим scope supplier.partner.payments
    if (action === 'driver-payments') {
      const driverId = params.driver_id;
      if (!driverId) {
        return { 
          statusCode: 400, 
          headers, 
          body: JSON.stringify({ error: 'Missing ?driver_id=...' }, null, 2) 
        };
      }
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      const apiOrgId = await getApiOrgId(tokenResult.access_token);
      if (!apiOrgId) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'No org ID' }, null, 2) };
      }
      const endTime = Date.now();
      const startTime = endTime - (24 * 60 * 60 * 1000);
      const r = await callUberAPI(
        `/v1/vehicle-suppliers/earners/payments?org_id=${encodeURIComponent(apiOrgId)}&page_size=50&start_time=${startTime}&end_time=${endTime}&driver_id=${encodeURIComponent(driverId)}`,
        tokenResult.access_token
      );
      return { statusCode: r.ok ? 200 : r.status, headers, body: JSON.stringify(r, null, 2) };
    }
    
    // === ⏱️ v9: DRIVER TIMELINE INFO (события водителя за период) ===
    // Док: POST /v1/vehicle-suppliers/driver/timeline-info
    // Требует scope supplier.driver.activity.read (может не быть)
    if (action === 'driver-timeline') {
      const driverId = params.driver_id;
      if (!driverId) {
        return { 
          statusCode: 400, 
          headers, 
          body: JSON.stringify({ error: 'Missing ?driver_id=...' }, null, 2) 
        };
      }
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      const apiOrgId = await getApiOrgId(tokenResult.access_token);
      if (!apiOrgId) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'No org ID' }, null, 2) };
      }
      const endTime = Date.now();
      const startTime = endTime - (24 * 60 * 60 * 1000);
      const r = await callUberAPI(
        `/v1/vehicle-suppliers/driver/timeline-info`,
        tokenResult.access_token,
        'POST',
        {
          org_id: apiOrgId,
          driver_id: driverId,
          start_time: startTime,
          end_time: endTime
        }
      );
      return { statusCode: r.ok ? 200 : r.status, headers, body: JSON.stringify(r, null, 2) };
    }
    
    // === 📊 v9: PERFORMANCE DATA (метрики по водителям/машинам за период) ===
    // Док: POST /v1/vehicle-suppliers/suppliers/{org_id}/performance-data
    // Отдаёт hours_online, hours_on_trip, total_trips, total_earnings
    // Data freshness SLA: 1-2 часа для драйверов, 5-10 минут для машин
    if (action === 'performance-data') {
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      const apiOrgId = await getApiOrgId(tokenResult.access_token);
      if (!apiOrgId) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'No org ID' }, null, 2) };
      }
      const endTime = Date.now();
      // дефолт: последние 7 дней
      const days = parseInt(params.days || '7', 10);
      const startTime = endTime - (days * 24 * 60 * 60 * 1000);
      // dimension: DRIVER | VEHICLE  (по умолчанию DRIVER)
      const dimension = params.dimension || 'DRIVER';
      const r = await callUberAPI(
        `/v1/vehicle-suppliers/suppliers/${encodeURIComponent(apiOrgId)}/performance-data`,
        tokenResult.access_token,
        'POST',
        {
          dimension: dimension,
          start_time: startTime,
          end_time: endTime
        }
      );
      return { statusCode: r.ok ? 200 : r.status, headers, body: JSON.stringify(r, null, 2) };
    }
    
    // === Универсальный fetch ===
    if (action === 'fetch') {
      const endpoint = params.endpoint;
      if (!endpoint) {
        return { 
          statusCode: 400, 
          headers, 
          body: JSON.stringify({ error: 'Missing ?endpoint=...' }, null, 2) 
        };
      }
      
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      
      const r = await callUberAPI(endpoint, tokenResult.access_token);
      return { 
        statusCode: 200, 
        headers, 
        body: JSON.stringify(r, null, 2) 
      };
    }
    
    // === Info ===
    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({
        message: 'Uber API proxy v9 - per-driver endpoints added',
        actions: {
          'token': 'Получить access token',
          'orgs': '✅ Список организаций',
          'vehicles': '🚗 Список автомобилей',
          'drivers': '👤 Список водителей',
          'drivers-status': '📊 Статус водителей real-time',
          'drivers-location': '📍 Live location водителей',
          'payments': '💰 Выплаты по всем за 24ч',
          'driver-payments': '💰 v9: Выплаты по конкретному (?driver_id=...)',
          'driver-timeline': '⏱️ v9: События водителя (?driver_id=...)',
          'performance-data': '📊 v9: Метрики (часы/поездки/доход) ?days=7&dimension=DRIVER',
          'fetch': '?endpoint=/v1/...'
        },
        usage: 'https://misterridegroup.com/api/uber/?action=driver-payments&driver_id=...'
      }, null, 2) 
    };
    
  } catch (err) {
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ error: err.message, stack: err.stack }, null, 2) 
    };
  }
};
