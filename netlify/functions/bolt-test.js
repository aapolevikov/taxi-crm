// Mr Ride CRM — Bolt Fleet Integration API connection test
// Netlify Function. Validates that BOLT_CLIENT_ID + BOLT_CLIENT_SECRET
// work and returns sample data from /test endpoint.
// Once this succeeds we can build the full bolt-api.js + bolt-cron.js.

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const clientId = process.env.BOLT_CLIENT_ID;
  const clientSecret = process.env.BOLT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({
        ok: false,
        stage: 'env',
        error: 'BOLT_CLIENT_ID or BOLT_CLIENT_SECRET is missing in Netlify env'
      })
    };
  }

  // STEP 1 — Get access token via OAuth2 Client Credentials flow
  let token, tokenError;
  try {
    const tokenResp = await fetch('https://oidc.bolt.eu/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        scope: 'fleet-integration:api'
      }).toString()
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData.access_token) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          ok: false,
          stage: 'token',
          status: tokenResp.status,
          response: tokenData
        })
      };
    }
    token = tokenData.access_token;
  } catch (e) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: false,
        stage: 'token-exception',
        error: String(e.message || e)
      })
    };
  }

  // STEP 2 — Call /test endpoint to verify the token works
  let testResult;
  try {
    const testResp = await fetch(
      'https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1/test',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      }
    );
    const testData = await testResp.json();
    testResult = { status: testResp.status, body: testData };
  } catch (e) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        stage: 'token-ok',
        token_acquired: true,
        test_endpoint_error: String(e.message || e)
      })
    };
  }

  // STEP 3 — Also try /getCompanies (GET) to verify a real endpoint works
  let companiesResult;
  try {
    const cResp = await fetch(
      'https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1/getCompanies',
      {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + token }
      }
    );
    const cData = await cResp.json();
    companiesResult = { status: cResp.status, body: cData };
  } catch (e) {
    companiesResult = { error: String(e.message || e) };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      stage: 'all-good',
      token_acquired: true,
      token_preview: token.substring(0, 20) + '...',
      test_endpoint: testResult,
      get_companies: companiesResult
    }, null, 2)
  };
};
