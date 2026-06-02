// cabman-probe.js — ОДНОРАЗОВАЯ РАЗВЕДКА Cabman API (DT / GetIVDData)
// Назначение: дёрнуть endpoint с тремя заголовками авторизации и вернуть
// СЫРОЙ ответ, чтобы понять структуру данных (поля, формат) перед интеграцией.
//
// Учётные данные берутся из Netlify env (НЕ хардкодим пароль в коде):
//   CABMAN_URL         = https://app.cabman.ae/dtcabmanrestservice/api/trackingServices/GetIVDData
//   CABMAN_UNIQUE_ID   = 81
//   CABMAN_USERNAME    = Mister_Ride_Limousine
//   CABMAN_PASSWORD    = (пароль)
//
// Открой в браузере:
//   https://<твой-сайт>/.netlify/functions/cabman-probe
// и пришли весь ответ.

exports.handler = async function (event) {
  const URL = process.env.CABMAN_URL
    || 'https://app.cabman.ae/dtcabmanrestservice/api/trackingServices/GetIVDData';
  const UNIQUE_ID = process.env.CABMAN_UNIQUE_ID || '';
  const USERNAME  = process.env.CABMAN_USERNAME  || '';
  const PASSWORD  = process.env.CABMAN_PASSWORD  || '';

  const missing = [];
  if (!UNIQUE_ID) missing.push('CABMAN_UNIQUE_ID');
  if (!USERNAME)  missing.push('CABMAN_USERNAME');
  if (!PASSWORD)  missing.push('CABMAN_PASSWORD');
  if (missing.length) {
    return json(500, { ok:false, error:'Missing env vars', missing });
  }

  // Cabman/DT использует заголовки InterfaceUniqueId / InterfaceUserName / InterfacePassword.
  // Пробуем несколько вариантов метода/заголовков, т.к. в письме была опечатка "InterfacePasswor".
  const headerVariants = [
    { InterfaceUniqueId: UNIQUE_ID, InterfaceUserName: USERNAME, InterfacePassword: PASSWORD },
    { InterfaceUniqueId: UNIQUE_ID, InterfaceUserName: USERNAME, InterfacePasswor:  PASSWORD },
  ];

  const attempts = [];
  for (const method of ['GET','POST']) {
    for (const hv of headerVariants) {
      try {
        const opts = {
          method,
          headers: { 'Accept':'application/json, text/plain, */*', ...hv },
        };
        if (method === 'POST') {
          opts.headers['Content-Type'] = 'application/json';
          opts.body = '{}';
        }
        const res = await fetch(URL, opts);
        const text = await res.text();
        attempts.push({
          method,
          headerKey: Object.keys(hv).join(','),
          status: res.status,
          ok: res.ok,
          contentType: res.headers.get('content-type') || '',
          bodyPreview: text.slice(0, 4000),
          bodyLength: text.length,
        });
        // если получили успешный непустой ответ — на нём и останавливаемся
        if (res.ok && text && text.trim() && text.trim() !== '[]' && text.trim() !== '{}') {
          return json(200, { ok:true, url:URL, winner:{ method, headerKey:Object.keys(hv).join(',') }, attempts });
        }
      } catch (e) {
        attempts.push({ method, headerKey:Object.keys(hv).join(','), error: String(e && e.message || e) });
      }
    }
  }

  return json(200, { ok:false, url:URL, note:'No successful non-empty response; see attempts', attempts });
};

function json(code, obj) {
  return {
    statusCode: code,
    headers: { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' },
    body: JSON.stringify(obj, null, 2),
  };
}
