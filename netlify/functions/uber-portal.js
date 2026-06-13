// netlify/functions/uber-portal.js
// v1.2 — Тянет поездки/часы/доход водителей из портала supplier.uber.com
//        + список водителей в Netlify Blobs (uber-config/drivers), управление из CRM:
//          action=list-drivers | add-driver&uuid= | remove-driver&uuid= | migrate-env
// через GraphQL GetPerformanceReport, используя сохранённую cookie-сессию.
//
// ВАЖНО: cookie хранятся в переменной окружения Netlify UBER_PORTAL_COOKIE,
// НЕ в коде. Сессия портала живёт ~24ч, потом истекает — функция вернёт
// ok:false с reason:"SESSION_EXPIRED", и CRM создаст задачу на обновление.
//
// Параметры (query string или POST body):
//   start  — начало периода, YYYY-MM-DD (по умолчанию: 7 дней назад)
//   end    — конец периода,  YYYY-MM-DD (по умолчанию: сегодня)
//   uuids  — список UUID водителей через запятую (по умолчанию: из ENV UBER_PORTAL_DRIVERS)

const PORTAL_URL = 'https://supplier.uber.com/graphql';
const { connectLambda, getStore } = require('@netlify/blobs');
const DRIVERS_STORE = 'uber-config';
const DRIVERS_KEY = 'drivers';
async function _loadDriverList(){
  try{
    const st = getStore(DRIVERS_STORE);
    const rec = await st.get(DRIVERS_KEY, { type: 'json' });
    if (rec && Array.isArray(rec.uuids)) return rec.uuids.slice();
  }catch(e){}
  return String(process.env.UBER_PORTAL_DRIVERS||'').split(',').map(function(x){return x.trim();}).filter(Boolean);
}
async function _saveDriverList(arr){
  const st = getStore(DRIVERS_STORE);
  const uniq = Array.from(new Set((arr||[]).map(function(x){return String(x).trim();}).filter(Boolean)));
  await st.setJSON(DRIVERS_KEY, { uuids: uniq, updated_at: new Date().toISOString() });
  return uniq;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8'
};

// Поля, которые тянем (точно как делает портал)
const METRICS = [
  'vs:TotalEarningsLabel', 'vs:TotalEarnings', 'vs:EarningsPerHourLabel',
  'vs:TripsPerOnlineHour', 'vs:HoursOnline', 'vs:HoursOnTrip', 'vs:HoursOnJob',
  'vs:TotalTrips', 'vs:CashEarningsLabel', 'vs:CashEarnings',
  'vs:DriverAcceptanceRate', 'vs:DriverCancellationRate',
  'vs:FirstOnlineTime', 'vs:LastOnlineTime', 'vs:FirstTripTime', 'vs:LastTripTime'
];

const QUERY = `query GetPerformanceReport($performanceReportRequest: PerformanceReportRequest__Input!) {
  getPerformanceReport(performanceReportRequest: $performanceReportRequest) {
    uuid
    totalEarningsLabel
    totalEarnings
    earningsPerHourLabel
    tripsPerOnlineHour
    hoursOnline
    totalTrips
    hoursOnJob
    hoursOnTrip
    hoursToTrip
    hoursAvailableForTrip
    ... on DriverPerformanceDetail {
      cashEarningsLabel
      cashEarnings
      driverAcceptanceRate
      driverCancellationRate
      firstOnlineTime
      lastOnlineTime
      firstTripTime
      lastTripTime
      __typename
    }
    __typename
  }
}`;

function ymdToMs(ymd, endOfDay) {
  // YYYY-MM-DD -> ms (UTC). Для end берём конец дня.
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0));
  return dt.getTime();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  try { connectLambda(event); } catch (e) {}

  try {
    const _qs = event.queryStringParameters || {};
    let _b = {}; if (event.body) { try { _b = JSON.parse(event.body); } catch(e){} }
    const action = _qs.action || _b.action || '';
    if (action === 'list-drivers') {
      const list = await _loadDriverList();
      return { statusCode:200, headers:CORS, body:JSON.stringify({ ok:true, uuids:list, count:list.length }) };
    }
    if (action === 'add-driver') {
      const uuid = String(_qs.uuid || _b.uuid || '').trim();
      if (!/^[0-9a-fA-F-]{20,}$/.test(uuid)) return { statusCode:200, headers:CORS, body:JSON.stringify({ ok:false, error:'bad uuid' }) };
      const list = await _loadDriverList();
      if (!list.includes(uuid)) list.push(uuid);
      const saved = await _saveDriverList(list);
      return { statusCode:200, headers:CORS, body:JSON.stringify({ ok:true, added:uuid, uuids:saved, count:saved.length }) };
    }
    if (action === 'remove-driver') {
      const uuid = String(_qs.uuid || _b.uuid || '').trim();
      const list = (await _loadDriverList()).filter(function(x){return x !== uuid;});
      const saved = await _saveDriverList(list);
      return { statusCode:200, headers:CORS, body:JSON.stringify({ ok:true, removed:uuid, uuids:saved, count:saved.length }) };
    }
    if (action === 'migrate-env') {
      const envList = String(process.env.UBER_PORTAL_DRIVERS||'').split(',').map(function(x){return x.trim();}).filter(Boolean);
      const cur = await _loadDriverList();
      const merged = Array.from(new Set(cur.concat(envList)));
      const saved = await _saveDriverList(merged);
      return { statusCode:200, headers:CORS, body:JSON.stringify({ ok:true, migrated:envList.length, uuids:saved, count:saved.length }) };
    }
  } catch(e){
    return { statusCode:200, headers:CORS, body:JSON.stringify({ ok:false, error:'Blobs error: '+(e&&e.message||e) }) };
  }

  try {
    const cookie = process.env.UBER_PORTAL_COOKIE;
    const orgUUID = process.env.UBER_PORTAL_ORG || '7923787a-0861-4597-905a-62dabed048a5';

    if (!cookie) {
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          ok: false,
          reason: 'NO_COOKIE',
          error: 'UBER_PORTAL_COOKIE не задан в переменных окружения Netlify'
        })
      };
    }

    // Параметры из query или body
    const qs = event.queryStringParameters || {};
    let body = {};
    if (event.body) { try { body = JSON.parse(event.body); } catch (e) {} }

    const today = new Date();
    const defEnd = today.toISOString().slice(0, 10);
    const weekAgo = new Date(today.getTime() - 7 * 86400000).toISOString().slice(0, 10);

    const start = qs.start || body.start || weekAgo;
    const end   = qs.end   || body.end   || defEnd;

    // Список водителей: из параметра, иначе из ENV, иначе пустой (портал вернёт всех)
    // all=1 → игнорируем фиксированный список и просим у портала ВСЕХ водителей
    // (нужно, чтобы найти UUID новых водителей, которых ещё нет в env).
    const wantAll = (qs.all==='1' || qs.all==='true' || body.all===true);
    let uuids;
    if (wantAll) { uuids = []; }
    else if (qs.uuids || body.uuids) { uuids = String(qs.uuids||body.uuids).split(',').map(function(x){return x.trim();}).filter(Boolean); }
    else { uuids = await _loadDriverList(); }

    const variables = {
      performanceReportRequest: {
        orgUUID: orgUUID,
        dimensions: ['vs:driver'],
        metrics: METRICS,
        timeRange: {
          startsAt: { value: ymdToMs(start, false) },
          endsAt:   { value: ymdToMs(end, true) }
        }
      }
    };
    // Фильтр по водителям добавляем только если список задан
    if (uuids.length) {
      variables.performanceReportRequest.dimensionFilterClause = [{
        dimensionName: 'vs:driver',
        operator: 'OPERATOR_IN',
        expressions: uuids
      }];
    }

    const resp = await fetch(PORTAL_URL, {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'content-type': 'application/json',
        'origin': 'https://supplier.uber.com',
        'referer': `https://supplier.uber.com/orgs/${orgUUID}/performance`,
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        'x-csrf-token': 'x',
        'cookie': cookie
      },
      body: JSON.stringify({
        operationName: 'GetPerformanceReport',
        variables: variables,
        query: QUERY
      })
    });

    const status = resp.status;
    const text = await resp.text();

    // Признаки истёкшей сессии: редирект на логин, 401/403, html вместо json
    const looksLikeLogin = /login|auth\.uber\.com|<html/i.test(text.slice(0, 300));
    if (status === 401 || status === 403 || (status >= 300 && status < 400) || looksLikeLogin) {
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          ok: false,
          reason: 'SESSION_EXPIRED',
          status: status,
          error: 'Сессия портала истекла или недействительна — нужно обновить UBER_PORTAL_COOKIE'
        })
      };
    }

    let json;
    try { json = JSON.parse(text); }
    catch (e) {
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ ok: false, reason: 'BAD_RESPONSE', status, error: 'Ответ портала не JSON', sample: text.slice(0, 200) })
      };
    }

    if (json.errors) {
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ ok: false, reason: 'GRAPHQL_ERROR', status, errors: json.errors })
      };
    }

    const report = (json.data && json.data.getPerformanceReport) || [];
    // Нормализуем в простой массив
    const drivers = report.map(r => ({
      uuid: r.uuid,
      totalEarnings: r.totalEarnings,        // строка вида "3012.67" или число
      totalTrips: r.totalTrips,
      hoursOnline: r.hoursOnline,
      hoursOnTrip: r.hoursOnTrip,
      hoursOnJob: r.hoursOnJob,
      cashEarnings: r.cashEarnings,
      acceptanceRate: r.driverAcceptanceRate,
      cancellationRate: r.driverCancellationRate
    }));

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: true,
        status: status,
        period: { start, end },
        count: drivers.length,
        drivers: drivers
      })
    };

  } catch (err) {
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: false, reason: 'EXCEPTION', error: String(err && err.message || err) })
    };
  }
};
