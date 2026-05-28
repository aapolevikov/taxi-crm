// netlify/functions/uber-portal.js
// v1.0 — Тянет поездки/часы/доход водителей из портала supplier.uber.com
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
    let uuids = qs.uuids || body.uuids || process.env.UBER_PORTAL_DRIVERS || '';
    uuids = String(uuids).split(',').map(s => s.trim()).filter(Boolean);

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
