// netlify/functions/uber-cron.js
// v1.0 — Scheduled-функция автосбора Uber-истории.
// Запускается по расписанию (см. netlify.toml, секция [functions."uber-cron"]).
// Каждый запуск:
//   1) тянет агрегаты с портала Uber за СЕГОДНЯ (та же логика, что в uber-portal.js),
//   2) пишет их в Netlify Blobs под ключом-датой YYYY-MM-DD.
// История накапливается на сервере (одна для всех устройств), независимо от того,
// открыта CRM или нет. Почасовой запуск перезаписывает запись за сегодня свежими
// агрегатами — портал отдаёт агрегат за день целиком, поэтому дублей нет.
//
// Хранилище: Blobs store "uber-history", ключ = дата, значение (JSON):
//   { "<uuid>": { trips, hoursOnline, income }, ... , "_meta": {...} }
//
// ВАЖНО: в Lambda-режиме среду Blobs нужно инициализировать вручную через
// connectLambda(event) ПЕРЕД getStore — иначе getStore падает в проде.

const { connectLambda, getStore } = require('@netlify/blobs');

const PORTAL_URL = 'https://supplier.uber.com/graphql';

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
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0));
  return dt.getTime();
}

// "Сегодня" по дубайскому времени (UTC+4), чтобы день закрывался по местному.
function todayDubai() {
  const now = new Date();
  const dubai = new Date(now.getTime() + 4 * 3600000); // сдвиг на +4ч
  return dubai.toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  // Инициализация среды Blobs для Lambda-режима — обязательно перед getStore.
  try { connectLambda(event); } catch (e) { /* в dev может не требоваться */ }

  const cookie = process.env.UBER_PORTAL_COOKIE;
  const orgUUID = process.env.UBER_PORTAL_ORG || '7923787a-0861-4597-905a-62dabed048a5';

  if (!cookie) {
    console.warn('[uber-cron] UBER_PORTAL_COOKIE не задан — пропуск запуска');
    return { statusCode: 200, body: 'NO_COOKIE' };
  }

  const day = todayDubai();
  let uuids = (process.env.UBER_PORTAL_DRIVERS || '').split(',').map(s => s.trim()).filter(Boolean);

  const variables = {
    performanceReportRequest: {
      orgUUID: orgUUID,
      dimensions: ['vs:driver'],
      metrics: METRICS,
      timeRange: {
        startsAt: { value: ymdToMs(day, false) },
        endsAt:   { value: ymdToMs(day, true) }
      }
    }
  };
  if (uuids.length) {
    variables.performanceReportRequest.dimensionFilterClause = [{
      dimensionName: 'vs:driver',
      operator: 'OPERATOR_IN',
      expressions: uuids
    }];
  }

  let report = [];
  try {
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
    const looksLikeLogin = /login|auth\.uber\.com|<html/i.test(text.slice(0, 300));

    if (status === 401 || status === 403 || (status >= 300 && status < 400) || looksLikeLogin) {
      // Сессия истекла — НЕ перезаписываем уже собранные данные за день, просто выходим.
      console.warn('[uber-cron] SESSION_EXPIRED — день', day, 'пропущен (cookie истекла)');
      return { statusCode: 200, body: 'SESSION_EXPIRED' };
    }

    let json;
    try { json = JSON.parse(text); }
    catch (e) {
      console.warn('[uber-cron] BAD_RESPONSE:', text.slice(0, 200));
      return { statusCode: 200, body: 'BAD_RESPONSE' };
    }
    if (json.errors) {
      console.warn('[uber-cron] GRAPHQL_ERROR:', JSON.stringify(json.errors).slice(0, 300));
      return { statusCode: 200, body: 'GRAPHQL_ERROR' };
    }
    report = (json.data && json.data.getPerformanceReport) || [];
  } catch (err) {
    console.error('[uber-cron] EXCEPTION при запросе портала:', String(err && err.message || err));
    return { statusCode: 200, body: 'EXCEPTION' };
  }

  // Нормализуем в ту же форму, что пишет CRM в localStorage:
  //   { "<uuid>": { trips, hoursOnline, income } }
  const dayRecord = {};
  report.forEach(r => {
    if (!r || !r.uuid) return;
    dayRecord[r.uuid] = {
      trips:       Number(r.totalTrips) || 0,
      hoursOnline: Math.round((Number(r.hoursOnline) || 0) * 100) / 100,
      income:      Math.round((Number(r.totalEarnings) || 0) * 100) / 100
    };
  });
  dayRecord._meta = { updatedAt: new Date().toISOString(), source: 'uber-cron', count: report.length };

  // Пишем в Blobs (strong consistency — чтобы читалка сразу видела свежее).
  try {
    const store = getStore('uber-history');
    await store.setJSON(day, dayRecord);
    console.log('[uber-cron] OK — день', day, '· водителей:', report.length);
    return { statusCode: 200, body: 'OK ' + day + ' (' + report.length + ')' };
  } catch (err) {
    console.error('[uber-cron] Blobs write FAILED:', String(err && err.message || err));
    return { statusCode: 200, body: 'BLOBS_WRITE_FAILED' };
  }
};
