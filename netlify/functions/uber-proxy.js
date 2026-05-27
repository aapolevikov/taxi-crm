// netlify/functions/uber-proxy.js
// Proxy для Uber Vehicle Suppliers API
// v6: ПРАВИЛЬНЫЕ endpoints с ДЕФИСОМ (vehicle-suppliers), не с подчёркиванием!
// Документация: developer.uber.com/docs/vehicles

const UBER_LOGIN_URL = 'https://login.uber.com/oauth/v2/token';
const UBER_API_BASE = 'https://api.uber.com';

// Organization ID из supplier.uber.com URL
const ORG_ID = '7923787a-0861-4597-905a-62dabed048a5';

// Все возможные scopes, попробуем сразу несколько
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
      // Если scope не одобрен — пробуем без него
      if (data.error === 'invalid_scope' && scopesKey.includes(' ')) {
        // Удаляем по одному scope и пробуем снова
        const scopesList = scopesKey.split(' ');
        for (let i = 0; i < scopesList.length; i++) {
          const reduced = scopesList.filter((_, idx) => idx !== i).join(' ');
          const retry = await fetch(UBER_LOGIN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: clientId,
              client_secret: clientSecret,
              grant_type: 'client_credentials',
              scope: reduced
            }).toString()
          });
          if (retry.ok) {
            const rd = await retry.json();
            cachedToken = rd.access_token;
            cachedTokenExpiresAt = now + (rd.expires_in * 1000);
            cachedScopes = reduced;
            return { 
              ok: true, 
              access_token: rd.access_token,
              expires_in: rd.expires_in,
              scope: rd.scope,
              note: `Removed invalid scope: ${scopesList[i]}`,
              from_cache: false
            };
          }
        }
      }
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
    
    // === ГЛАВНЫЙ ТЕСТ v6 — правильные endpoints с дефисом ===
    if (action === 'test-real') {
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      
      const realEndpoints = [
        // Из официальной документации Uber
        `/v1/vehicle-suppliers/orgs`,
        `/v1/vehicle-suppliers/vehicles`,
        `/v1/vehicle-suppliers/vehicles?org_id=${ORG_ID}`,
        `/v2/vehicle-suppliers/vehicles?org_id=${ORG_ID}`,
        `/v2/vehicle-suppliers/vehicles?org_id=${ORG_ID}&page_size=10`,
        `/v1/vehicle-suppliers/earners/payments?org_id=${ORG_ID}`,
        `/v1/vehicle-suppliers/earners?org_id=${ORG_ID}`,
        `/v1/vehicle-suppliers/drivers?org_id=${ORG_ID}`,
        // Solutions
        `/v1/solutions/vehicles`,
        `/v1/solutions/vehicles?org_id=${ORG_ID}`,
        `/v1/solutions/suppliers/drivers/status?org_id=${ORG_ID}`,
        // Reports
        `/v1/vehicle-suppliers/reports?org_id=${ORG_ID}`,
      ];
      
      const results = [];
      for (const ep of realEndpoints) {
        const r = await callUberAPI(ep, tokenResult.access_token);
        results.push({
          endpoint: ep,
          status: r.status,
          ok: r.ok,
          response: r.ok 
            ? JSON.stringify(r.data).substring(0, 300)
            : (r.data?.message || r.data?.error || r.data?.code || JSON.stringify(r.data).substring(0, 300))
        });
      }
      
      return { 
        statusCode: 200, 
        headers, 
        body: JSON.stringify({
          action: 'test-real',
          org_id: ORG_ID,
          token_scopes: tokenResult.scope,
          working: results.filter(r => r.ok).length,
          not_404: results.filter(r => r.status !== 404).length,
          results
        }, null, 2) 
      };
    }
    
    // === Универсальный fetch ===
    if (action === 'fetch') {
      const endpoint = params.endpoint;
      if (!endpoint) {
        return { 
          statusCode: 400, 
          headers, 
          body: JSON.stringify({ error: 'Missing ?endpoint=... parameter' }, null, 2) 
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
    
    // === Простые ярлыки ===
    if (action === 'orgs') {
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      const r = await callUberAPI(`/v1/vehicle-suppliers/orgs`, tokenResult.access_token);
      return { statusCode: r.ok ? 200 : r.status, headers, body: JSON.stringify(r, null, 2) };
    }
    
    if (action === 'vehicles') {
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      const r = await callUberAPI(`/v2/vehicle-suppliers/vehicles?org_id=${ORG_ID}&page_size=50`, tokenResult.access_token);
      return { statusCode: r.ok ? 200 : r.status, headers, body: JSON.stringify(r, null, 2) };
    }
    
    if (action === 'payments') {
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      const r = await callUberAPI(`/v1/vehicle-suppliers/earners/payments?org_id=${ORG_ID}&page_size=50`, tokenResult.access_token);
      return { statusCode: r.ok ? 200 : r.status, headers, body: JSON.stringify(r, null, 2) };
    }
    
    // === Info ===
    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({
        message: 'Uber API proxy v6 - REAL endpoints with hyphen!',
        org_id: ORG_ID,
        critical_fix: 'vehicle-suppliers (с дефисом!), не vehicle_suppliers',
        actions: {
          'token': 'Получить access token',
          'test-real': '🎯 ГЛАВНЫЙ ТЕСТ — правильные endpoints из документации Uber',
          'orgs': 'Список организаций',
          'vehicles': 'Список автомобилей',
          'payments': 'Выплаты водителей',
          'fetch': '?endpoint=/v1/vehicle-suppliers/orgs'
        },
        usage: 'https://misterridegroup.com/api/uber/?action=test-real'
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
