// netlify/functions/uber-proxy.js
// Proxy для Uber Vehicle Suppliers API
// v7: используем шифрованный Organization ID из /v1/vehicle-suppliers/orgs

const UBER_LOGIN_URL = 'https://login.uber.com/oauth/v2/token';
const UBER_API_BASE = 'https://api.uber.com';

// Все возможные scopes
const SCOPES_TO_TRY = [
  'supplier.partner.payments',
  'solutions.suppliers.drivers.status.read',
  'solutions.suppliers.metrics.read',
  'vehicle_suppliers.organizations.read',
  'vehicle_suppliers.vehicles.read'
];

const DEFAULT_SCOPES = SCOPES_TO_TRY.join(' ');

let cachedToken = null;
let cachedTokenExpiresAt = 0;
let cachedScopes = null;
let cachedApiOrgId = null; // Шифрованный ID для API запросов

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

// Получаем шифрованный Organization ID для API
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
    
    // === Список организаций (работает!) ===
    if (action === 'orgs') {
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      const r = await callUberAPI(`/v1/vehicle-suppliers/orgs`, tokenResult.access_token);
      return { statusCode: r.ok ? 200 : r.status, headers, body: JSON.stringify(r, null, 2) };
    }
    
    // === ГЛАВНЫЙ ТЕСТ v7 — с правильным API org_id ===
    if (action === 'test-with-real-id') {
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      
      // Шаг 1: получаем шифрованный ID
      const apiOrgId = await getApiOrgId(tokenResult.access_token);
      if (!apiOrgId) {
        return { 
          statusCode: 500, 
          headers, 
          body: JSON.stringify({ error: 'Failed to get API org ID' }, null, 2) 
        };
      }
      
      // Шаг 2: пробуем все endpoints с правильным ID
      const encodedId = encodeURIComponent(apiOrgId);
      const endpoints = [
        `/v1/vehicle-suppliers/vehicles?org_id=${encodedId}`,
        `/v1/vehicle-suppliers/vehicles?org_id=${encodedId}&page_size=50`,
        `/v2/vehicle-suppliers/vehicles?org_id=${encodedId}`,
        `/v2/vehicle-suppliers/vehicles?org_id=${encodedId}&page_size=50`,
        `/v1/vehicle-suppliers/earners?org_id=${encodedId}`,
        `/v1/vehicle-suppliers/earners?org_id=${encodedId}&page_size=50`,
        `/v1/vehicle-suppliers/earners/payments?org_id=${encodedId}`,
        `/v1/vehicle-suppliers/earners/payments?org_id=${encodedId}&page_size=50`,
        `/v1/vehicle-suppliers/drivers?org_id=${encodedId}`,
        `/v1/vehicle-suppliers/drivers?org_id=${encodedId}&page_size=50`,
        `/v1/vehicle-suppliers/reports?org_id=${encodedId}`,
      ];
      
      const results = [];
      for (const ep of endpoints) {
        const r = await callUberAPI(ep, tokenResult.access_token);
        results.push({
          endpoint: ep.substring(0, 80) + '...',
          status: r.status,
          ok: r.ok,
          response: r.ok 
            ? JSON.stringify(r.data).substring(0, 500)
            : (typeof r.data === 'string' ? r.data : (r.data?.message || r.data?.error || JSON.stringify(r.data).substring(0, 300)))
        });
      }
      
      return { 
        statusCode: 200, 
        headers, 
        body: JSON.stringify({
          action: 'test-with-real-id',
          api_org_id: apiOrgId.substring(0, 50) + '...',
          token_scopes: tokenResult.scope,
          working: results.filter(r => r.ok).length,
          not_404: results.filter(r => r.status !== 404).length,
          results
        }, null, 2) 
      };
    }
    
    // === Получить машины ===
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
    
    // === Получить водителей ===
    if (action === 'drivers') {
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      const apiOrgId = await getApiOrgId(tokenResult.access_token);
      if (!apiOrgId) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'No org ID' }, null, 2) };
      }
      const r = await callUberAPI(`/v1/vehicle-suppliers/earners?org_id=${encodeURIComponent(apiOrgId)}&page_size=50`, tokenResult.access_token);
      return { statusCode: r.ok ? 200 : r.status, headers, body: JSON.stringify(r, null, 2) };
    }
    
    // === Получить выплаты ===
    if (action === 'payments') {
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      const apiOrgId = await getApiOrgId(tokenResult.access_token);
      if (!apiOrgId) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'No org ID' }, null, 2) };
      }
      const r = await callUberAPI(`/v1/vehicle-suppliers/earners/payments?org_id=${encodeURIComponent(apiOrgId)}&page_size=50`, tokenResult.access_token);
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
        message: 'Uber API proxy v7 - using encrypted org_id from /orgs',
        actions: {
          'token': 'Получить access token',
          'orgs': '✅ Список организаций (ID для API)',
          'test-with-real-id': '🎯 Тест endpoints с правильным шифрованным ID',
          'vehicles': '🚗 Список автомобилей',
          'drivers': '👤 Список водителей',
          'payments': '💰 Выплаты',
          'fetch': '?endpoint=/v1/...'
        },
        usage: 'https://misterridegroup.com/api/uber/?action=test-with-real-id'
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
