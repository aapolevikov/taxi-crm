// netlify/functions/yango-proxy.js
// Proxy для Yango Fleet API (https://fleet-api.yango.tech)
// Обходит CORS ограничения браузера

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Accept-Language, X-Client-ID, X-API-Key, X-Target-Url, X-Park-ID, X-Idempotency-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  const targetUrl = event.headers['x-target-url'];
  if (!targetUrl) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing X-Target-Url header' }) };
  }

  if (!targetUrl.startsWith('https://fleet-api.yango.tech')) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Only Yango Fleet API URLs allowed' }) };
  }

  try {
    const proxyHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-Language': event.headers['accept-language'] || 'ru'
    };
    if (event.headers['x-client-id']) proxyHeaders['X-Client-ID'] = event.headers['x-client-id'];
    if (event.headers['x-api-key']) proxyHeaders['X-API-Key'] = event.headers['x-api-key'];
    if (event.headers['x-park-id']) proxyHeaders['X-Park-ID'] = event.headers['x-park-id'];
    if (event.headers['x-idempotency-token']) proxyHeaders['X-Idempotency-Token'] = event.headers['x-idempotency-token'];

    const response = await fetch(targetUrl, {
      method: event.httpMethod,
      headers: proxyHeaders,
      body: event.httpMethod === 'GET' ? undefined : event.body
    });

    const data = await response.text();
    return {
      statusCode: response.status,
      headers: { ...corsHeaders, 'Content-Type': response.headers.get('content-type') || 'application/json' },
      body: data
    };
  } catch (error) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: error.message }) };
  }
};
