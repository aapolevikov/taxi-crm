// netlify/functions/uber-report-puller.js
// v1.0 — Автосбор отчётов Uber (поездки + суммы) через портал supplier.uber.com.
//
// Запускается по расписанию (см. netlify.toml). Двухфазная схема, чтобы не упираться
// в таймаут scheduled-функции (генерация отчёта у Uber занимает время):
//
//   ФАЗА A (создание): для окна "вчера+сегодня" (по Дубаю) и для каждого типа отчёта
//     вызываем мутацию GenerateVsPaymentReport -> получаем reportID -> кладём в pending.
//   ФАЗА B (добор): на следующем (или этом же) запуске опрашиваем GetVsPaymentReports;
//     если нужный reportID готов (reportStatus завершён) -> downloadVsPaymentReport ->
//     получаем signedURL -> качаем CSV -> сохраняем СЫРОЙ текст в Blobs -> чистим pending.
//
// Фронт (app.html) потом сам забирает сырые CSV через функцию uber-reports.js (action=list)
// и прогоняет их через уже существующие парсеры _normalizeUberCsv / _normalizeUberPayments.
// Так парсер остаётся ОДИН (на фронте), сервер ничего не дублирует.
//
// Хранилища Blobs:
//   "uber-reports-pending"  ключ "pending"            -> { items: [ {type, day, reportID, createdAt, status} ] }
//   "uber-reports"          ключ "<type>__<YYYY-MM-DD>" -> { csv, fileName, fetchedAt, type, startDate, endDate }
//
// ВАЖНО: connectLambda(event) ОБЯЗАТЕЛЕН перед getStore в Lambda-режиме (как в uber-cron.js).

const { connectLambda, getStore } = require('@netlify/blobs');

const PORTAL_URL = 'https://supplier.uber.com/graphql';

// Типы отчётов (подтверждено разведкой в DevTools):
//   REPORT_TYPE_TRIP_ACTIVITY  — поездки (без денег), даёт Trip UUID, время, способ оплаты
//   REPORT_TYPE_PAYMENTS_ORDER — построчные суммы по Trip UUID ("Paid to you", cash collected)
const REPORT_TYPES = ['REPORT_TYPE_TRIP_ACTIVITY', 'REPORT_TYPE_PAYMENTS_ORDER'];

// ── GraphQL операции (сняты с портала) ──
const Q_GENERATE = `mutation GenerateVsPaymentReport($orgUUID: ID!, $paymentReportType: String!, $startDate: Date!, $endDate: Date!, $childOrgUuids: [ID!], $reportId: ID, $scheduleId: ID, $startTimeUnixMillis: String, $endTimeUnixMillis: String) {
  generateVsPaymentReport(orgUUID: $orgUUID, paymentReportType: $paymentReportType, startDate: $startDate, endDate: $endDate, childOrgUuids: $childOrgUuids, reportId: $reportId, scheduleId: $scheduleId, startTimeUnixMillis: $startTimeUnixMillis, endTimeUnixMillis: $endTimeUnixMillis) {
    reportID
    __typename
  }
}`;

const Q_LIST = `query GetVsPaymentReports($orgUUID: ID!, $pageSize: Int, $pageToken: String) {
  getVsPaymentReports(orgUUID: $orgUUID, pageSize: $pageSize, pageToken: $pageToken) {
    reports {
      reportID
      paymentReportType
      startDate
      endDate
      createdAt
      completedAt
      fileName
      reportStatus
      reportFailedReason
      __typename
    }
    pageInfo { pageSize nextPageToken __typename }
    __typename
  }
}`;

const Q_DOWNLOAD = `query downloadVsPaymentReport($orgUUID: ID!, $reportID: ID!) {
  downloadVsPaymentReport(orgUUID: $orgUUID, reportID: $reportID) {
    signedURL
    __typename
  }
}`;

// ── helpers ──
function portalHeaders(cookie, orgUUID) {
  return {
    'accept': '*/*',
    'content-type': 'application/json',
    'origin': 'https://supplier.uber.com',
    'referer': `https://supplier.uber.com/orgs/${orgUUID}/reports`,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'x-csrf-token': 'x',
    'cookie': cookie
  };
}

// Дата по Дубаю (UTC+4) со сдвигом в днях. offsetDays=0 -> сегодня, -1 -> вчера.
function dubaiDate(offsetDays) {
  const now = new Date();
  const dubai = new Date(now.getTime() + 4 * 3600000 + (offsetDays || 0) * 86400000);
  return dubai.toISOString().slice(0, 10); // YYYY-MM-DD
}
// Unix-ms для начала/конца дубайского дня (в UTC это день-04:00 .. следующий-03:59:59)
function dubaiDayMs(ymd, endOfDay) {
  const [y, m, d] = ymd.split('-').map(Number);
  // 00:00 Дубай = (день) 00:00 UTC - 4ч  =>  UTC.setUTCHours(-4)
  const base = Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  return base - 4 * 3600000;
}

// Завершённый ли статус отчёта (терпимо к формулировкам Uber).
function isComplete(s) {
  const v = String(s || '').toUpperCase();
  return v.includes('COMPLETE') || v.includes('SUCCESS') || v.includes('DONE') || v.includes('READY');
}
function isFailed(s) {
  const v = String(s || '').toUpperCase();
  return v.includes('FAIL') || v.includes('ERROR');
}

// Запрос к порталу с детектом протухшей сессии. Возвращает {ok, data} | {expired:true} | {err}.
async function portalCall(cookie, orgUUID, operationName, query, variables) {
  let resp, text;
  try {
    resp = await fetch(PORTAL_URL, {
      method: 'POST',
      headers: portalHeaders(cookie, orgUUID),
      body: JSON.stringify({ operationName, variables, query })
    });
    text = await resp.text();
  } catch (e) {
    return { err: 'NETWORK ' + String(e && e.message || e) };
  }
  const status = resp.status;
  const looksLikeLogin = /login|auth\.uber\.com|<html/i.test(String(text).slice(0, 300));
  if (status === 401 || status === 403 || (status >= 300 && status < 400) || looksLikeLogin) {
    return { expired: true };
  }
  let json;
  try { json = JSON.parse(text); } catch (e) { return { err: 'BAD_JSON ' + String(text).slice(0, 160) }; }
  if (json.errors) return { err: 'GRAPHQL ' + JSON.stringify(json.errors).slice(0, 240) };
  return { ok: true, data: json.data || {} };
}

// Берём cookie сначала из Blobs (свежий, от расширения), иначе из env.
async function getCookie() {
  try {
    const sec = getStore('uber-secrets');
    const rec = await sec.get('cookie', { type: 'json' });
    if (rec && rec.cookie && /sid=/.test(rec.cookie)) return rec.cookie;
  } catch (e) { /* нет стора — ок */ }
  return process.env.UBER_PORTAL_COOKIE || '';
}

exports.handler = async (event) => {
  try { connectLambda(event); } catch (e) { /* dev */ }

  const cookie = await getCookie();
  const orgUUID = process.env.UBER_PORTAL_ORG || '7923787a-0861-4597-905a-62dabed048a5';
  if (!cookie) { console.warn('[uber-report-puller] NO_COOKIE'); return { statusCode: 200, body: 'NO_COOKIE' }; }

  const pendingStore = getStore('uber-reports-pending');
  const reportsStore = getStore('uber-reports');

  // Окно: вчера + сегодня (по Дубаю). День закрывается после 00:00 местного.
  const startDate = dubaiDate(-1);
  const endDate = dubaiDate(0);
  const startMs = String(dubaiDayMs(startDate, false));
  const endMs = String(dubaiDayMs(endDate, true));

  // Текущий pending-список
  let pending;
  try { pending = (await pendingStore.get('pending', { type: 'json' })) || { items: [] }; }
  catch (e) { pending = { items: [] }; }
  if (!pending.items) pending.items = [];

  const log = [];

  // ── ФАЗА B: добираем уже созданные отчёты (которые висят в pending) ──
  if (pending.items.length) {
    const listRes = await portalCall(cookie, orgUUID, 'GetVsPaymentReports', Q_LIST,
      { orgUUID, pageSize: 25 });
    if (listRes.expired) { console.warn('[uber-report-puller] SESSION_EXPIRED (list)'); return { statusCode: 200, body: 'SESSION_EXPIRED' }; }
    if (listRes.err) { log.push('LIST_ERR ' + listRes.err); }
    else {
      const reports = (listRes.data.getVsPaymentReports && listRes.data.getVsPaymentReports.reports) || [];
      const byId = {};
      reports.forEach(r => { if (r && r.reportID) byId[r.reportID] = r; });

      const stillPending = [];
      for (const item of pending.items) {
        const r = byId[item.reportID];
        if (!r) {
          // ещё не появился в списке — даём ему дожить (но не вечно)
          const ageMin = (Date.now() - (item.createdAt || 0)) / 60000;
          if (ageMin < 180) stillPending.push(item); else log.push('DROP_STALE ' + item.reportID);
          continue;
        }
        if (isComplete(r.reportStatus)) {
          // качаем signedURL
          const dl = await portalCall(cookie, orgUUID, 'downloadVsPaymentReport', Q_DOWNLOAD,
            { orgUUID, reportID: item.reportID });
          if (dl.expired) { console.warn('[uber-report-puller] SESSION_EXPIRED (download)'); return { statusCode: 200, body: 'SESSION_EXPIRED' }; }
          const url = dl.ok && dl.data.downloadVsPaymentReport && dl.data.downloadVsPaymentReport.signedURL;
          if (!url) { log.push('NO_URL ' + item.reportID); stillPending.push(item); continue; }
          let csv = '';
          try {
            const fr = await fetch(url);
            csv = await fr.text();
          } catch (e) { log.push('CSV_FETCH_ERR ' + String(e && e.message || e)); stillPending.push(item); continue; }
          const key = item.type + '__' + item.day; // например REPORT_TYPE_TRIP_ACTIVITY__2026-05-31
          try {
            await reportsStore.setJSON(key, {
              csv: csv,
              fileName: r.fileName || '',
              type: item.type,
              startDate: r.startDate || item.startDate,
              endDate: r.endDate || item.endDate,
              fetchedAt: new Date().toISOString()
            });
            log.push('SAVED ' + key + ' (' + csv.length + 'b)');
          } catch (e) { log.push('BLOBS_WRITE_ERR ' + String(e && e.message || e)); stillPending.push(item); }
        } else if (isFailed(r.reportStatus)) {
          log.push('REPORT_FAILED ' + item.reportID + ' ' + (r.reportFailedReason || ''));
          // не возвращаем в pending — пересоздадим ниже
        } else {
          stillPending.push(item); // ещё генерится
        }
      }
      pending.items = stillPending;
    }
  }

  // ── ФАЗА A: создаём отчёты за окно для тех типов, которых ещё нет в pending ──
  for (const type of REPORT_TYPES) {
    const already = pending.items.some(it => it.type === type && it.day === endDate);
    if (already) { log.push('SKIP_EXISTS ' + type); continue; }
    const gen = await portalCall(cookie, orgUUID, 'GenerateVsPaymentReport', Q_GENERATE, {
      orgUUID,
      paymentReportType: type,
      startDate, endDate,
      childOrgUuids: [orgUUID],
      startTimeUnixMillis: startMs,
      endTimeUnixMillis: endMs
    });
    if (gen.expired) { console.warn('[uber-report-puller] SESSION_EXPIRED (generate)'); return { statusCode: 200, body: 'SESSION_EXPIRED' }; }
    if (gen.err) { log.push('GEN_ERR ' + type + ' ' + gen.err); continue; }
    const rid = gen.data.generateVsPaymentReport && gen.data.generateVsPaymentReport.reportID;
    if (!rid) { log.push('GEN_NO_ID ' + type); continue; }
    pending.items.push({ type, day: endDate, reportID: rid, createdAt: Date.now(), startDate, endDate });
    log.push('CREATED ' + type + ' ' + rid);
  }

  // Сохраняем pending
  try { await pendingStore.setJSON('pending', pending); } catch (e) { log.push('PENDING_WRITE_ERR ' + String(e && e.message || e)); }

  console.log('[uber-report-puller]', startDate, '..', endDate, '|', log.join(' | '));
  return { statusCode: 200, body: 'OK ' + startDate + '..' + endDate + ' | ' + log.join(' | ') };
};
