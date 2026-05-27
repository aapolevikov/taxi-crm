// netlify/functions/uber-proxy.js
// Proxy для Uber Partners/Suppliers API
// v5: используем Organization ID и правильные endpoints

const UBER_LOGIN_URL = 'https://login.uber.com/oauth/v2/token';
const UBER_API_BASE = 'https://api.uber.com';

// Organization ID из supplier.uber.com URL
const ORG_ID = '7923787a-0861-4597-905a-62dabed048a5';

// Подтверждённые рабочие scopes (получены через Client Credentials)
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
    return { ok: false, error: 'UBER_CLIENT_ID or UBER_CLIENT_SECRET not set in Netlify env' };
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
        error: data.error_description || data.error || 'Unknown error', 
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
  const action = params.action || 'token';
  
  try {
    // === Получить access token ===
    if (action === 'token') {
      const result = await getAccessToken();
      return { 
        statusCode: result.ok ? 200 : 400, 
        headers, 
        body: JSON.stringify(result, null, 2) 
      };
    }
    
    // === Финальный тест: попробовать ВСЕ возможные endpoints с Org ID ===
    if (action === 'discover') {
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      
      const candidates = [
        // С Organization ID
        `/v1/vehicle_suppliers/organizations/${ORG_ID}/vehicles`,
        `/v1/vehicle_suppliers/organizations/${ORG_ID}/drivers`,
        `/v1/vehicle_suppliers/organizations/${ORG_ID}`,
        `/v1/suppliers/${ORG_ID}/vehicles`,
        `/v1/suppliers/${ORG_ID}/drivers`,
        `/v1/suppliers/${ORG_ID}`,
        `/v1/organizations/${ORG_ID}/vehicles`,
        `/v1/organizations/${ORG_ID}/drivers`,
        `/v1/organizations/${ORG_ID}`,
        `/v1/orgs/${ORG_ID}/vehicles`,
        `/v1/orgs/${ORG_ID}/drivers`,
        `/v1/solutions/suppliers/organizations/${ORG_ID}/drivers/status`,
        `/v1/solutions/suppliers/${ORG_ID}/drivers/status`,
        // Без ID
        `/v1/vehicle_suppliers/organizations`,
        `/v1/vehicle_suppliers/vehicles`,
        `/v1/suppliers/organizations`,
        `/v1/suppliers/vehicles`,
        `/v1/suppliers/drivers/status`,
        `/v1/solutions/suppliers/drivers/status`,
        `/v1/supplier/partner/payments`,
        // С query параметром org_id
        `/v1/vehicle_suppliers/vehicles?organization_id=${ORG_ID}`,
        `/v1/vehicles?organization_id=${ORG_ID}`,
        `/v1/drivers?organization_id=${ORG_ID}`,
      ];
      
      const results = [];
      for (const ep of candidates) {
        const r = await callUberAPI(ep, tokenResult.access_token);
        results.push({
          endpoint: ep,
          status: r.status,
          ok: r.ok,
          response: r.ok 
            ? (typeof r.data === 'object' ? Object.keys(r.data).slice(0, 5) : 'data') 
            : (r.data?.message || r.data?.error || r.data?.code || JSON.stringify(r.data).substring(0, 200))
        });
      }
      
      return { 
        statusCode: 200, 
        headers, 
        body: JSON.stringify({
          action: 'discover',
          org_id: ORG_ID,
          total: results.length,
          working: results.filter(r => r.ok).length,
          not_404: results.filter(r => r.status !== 404).length,
          results
        }, null, 2) 
      };
    }
    
    // === Получить полный ответ от конкретного endpoint ===
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
    
    // === Простые ярлыки для UI ===
    if (action === 'vehicles') {
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      const r = await callUberAPI(`/v1/vehicle_suppliers/organizations/${ORG_ID}/vehicles`, tokenResult.access_token);
      return { statusCode: r.ok ? 200 : r.status, headers, body: JSON.stringify(r, null, 2) };
    }
    
    if (action === 'drivers') {
      const tokenResult = await getAccessToken();
      if (!tokenResult.ok) {
        return { statusCode: 400, headers, body: JSON.stringify(tokenResult, null, 2) };
      }
      const r = await callUberAPI(`/v1/solutions/suppliers/organizations/${ORG_ID}/drivers/status`, tokenResult.access_token);
      return { statusCode: r.ok ? 200 : r.status, headers, body: JSON.stringify(r, null, 2) };
    }
    
    // === Информация ===
    return { 
      statusCode: 200, 
      headers, 
      body: JSON.stringify({
        message: 'Uber API proxy v5',
        org_id: ORG_ID,
        actions: {
          'token': 'Получить access token',
          'discover': 'Перебрать ~23 кандидата endpoints и показать какие работают',
          'fetch': 'Запросить конкретный endpoint. ?endpoint=/v1/...',
          'vehicles': 'Список автомобилей',
          'drivers': 'Список водителей с статусом'
        },
        usage: 'https://misterridegroup.com/api/uber/?action=discover'
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
