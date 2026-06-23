// cabman-track.js — Cabman GPS: live snapshot + history accumulation
//
// Modes (query param ?action=):
//   live    (default) → fetch current positions from Cabman, return them, AND append to history
//   collect           → same fetch+append but minimal response (used by scheduled run)
//   history           → return accumulated track points for ?vehicle=L93211&from=YYYY-MM-DD&to=YYYY-MM-DD
//   vehicles          → list of known vehicle IDs seen in history
//
// Storage (Netlify Blobs store "cabman-history"):
//   key  track:<VEHICLEID>:<YYYY-MM-DD>  → JSON array of points {t, lat, lng, speed, state, odo}
//   key  latest                          → JSON snapshot of last live fetch (all vehicles)
//
// Env vars: CABMAN_URL, CABMAN_UNIQUE_ID, CABMAN_USERNAME, CABMAN_PASSWORD
// Retention: history older than RETENTION_DAYS is pruned lazily on read.

const RETENTION_DAYS = 90;

let _blobs = null;
async function store(event){
  if(_blobs) return _blobs;
  const mod = await import('@netlify/blobs');

  // 1) ПРИОРИТЕТ: явные креды (site ID + персональный токен Netlify).
  // Такой токен не протухает между запросами, в отличие от контекста
  // connectLambda(event), который на HTTP-запросах из браузера может дать
  // "Failed to decode token: Token expired" при записи.
  const siteID = process.env.NETLIFY_SITE_ID || process.env.CABMAN_BLOBS_SITE_ID;
  const token  = process.env.NETLIFY_BLOBS_TOKEN || process.env.CABMAN_BLOBS_TOKEN;
  if(siteID && token){
    try{
      _blobs = mod.getStore({ name:'cabman-history', siteID, token });
      return _blobs;
    }catch(_){ /* упадём в режим connectLambda ниже */ }
  }

  // 2) Запасной режим: контекст из invocation event (для scheduled-запусков
  // работает стабильно; на HTTP-запросах токен может протухать).
  try{
    if(event && typeof mod.connectLambda === 'function'){
      mod.connectLambda(event);
    }
  }catch(_){}
  _blobs = mod.getStore('cabman-history');
  return _blobs;
}

async function fetchCabman(){
  const URL = process.env.CABMAN_URL;
  const headers = {
    'Accept':'application/json',
    'InterfaceUniqueId': process.env.CABMAN_UNIQUE_ID || '',
    'InterfaceUserName': process.env.CABMAN_USERNAME || '',
    'InterfacePassword': process.env.CABMAN_PASSWORD || '',
  };
  const res = await fetch(URL, { method:'GET', headers });
  const text = await res.text();
  if(!res.ok) throw new Error('Cabman HTTP '+res.status+': '+text.slice(0,200));
  let data; try{ data = JSON.parse(text); }catch(e){ throw new Error('Cabman bad JSON: '+text.slice(0,200)); }
  const arr = (data && data.IVDDataResult) || [];
  return arr.map(v => ({
    id: v.VehicleID,
    type: v.VehicleType || '',
    fuel: v.FuelTypeName || '',
    company: v.CompanyName || '',
    lat: Number(v.lat),
    lng: Number(v.lng),
    speed: Number(v.speed)||0,
    state: !!v.state,              // engine on/off
    odometer: Number(v.odometer)||0,
    status: v.Status || '',
    seat: v.SeatSensorStatus || '',
    seatVal: Number(v.SeatSensorValue)||0,
    device: v.device_id || '',
    time: v.gmt || v.LastReportedTime || '',
  }));
}

function dayKey(iso){ return (iso||'').slice(0,10); } // 'YYYY-MM-DD'

async function appendHistory(vehicles, event){
  const s = await store(event);
  // Метка времени = момент опроса Cabman (НЕ v.time/gmt прибора, который у
  // стоящих машин «застывает»). Так ключ-дата всегда = сегодня по UTC и
  // совпадает с тем, что ищет action=history.
  const nowIso = new Date().toISOString();
  const today  = dayKey(nowIso);
  const nowMinute = nowIso.slice(0,16); // 'YYYY-MM-DDTHH:MM' — дедуп по минуте
  for(const v of vehicles){
    if(!v.id || !isFinite(v.lat) || !isFinite(v.lng)) continue;
    const key = 'track:'+v.id+':'+today;
    let pts = [];
    try{ const cur = await s.get(key, {type:'json'}); if(Array.isArray(cur)) pts = cur; }catch(_){}
    const last = pts[pts.length-1];
    if(!last || (last.t||'').slice(0,16) !== nowMinute){
      pts.push({ t:nowIso, lat:v.lat, lng:v.lng, speed:v.speed, state:v.state, odo:v.odometer, tDev:v.time });
      try{ await s.setJSON(key, pts); }catch(e){ /* ignore single-key failure */ }
    }
  }
  // save latest snapshot
  try{ await s.setJSON('latest', { at:nowIso, vehicles }); }catch(_){}
}

function json(code, obj){
  return { statusCode:code, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body:JSON.stringify(obj) };
}

function datesBetween(from, to){
  const out=[]; const d=new Date(from+'T00:00:00Z'); const end=new Date(to+'T00:00:00Z');
  while(d<=end){ out.push(d.toISOString().slice(0,10)); d.setUTCDate(d.getUTCDate()+1); }
  return out;
}

exports.handler = async function(event){
  const action = (event.queryStringParameters && event.queryStringParameters.action) || 'live';

  try{
    if(action==='history'){
      const q = event.queryStringParameters || {};
      const vehicle = q.vehicle;
      const from = q.from, to = q.to;
      if(!vehicle || !from || !to) return json(400,{ok:false,error:'need vehicle, from, to'});
      const s = await store(event);
      let points = [];
      for(const day of datesBetween(from,to)){
        try{ const pts = await s.get('track:'+vehicle+':'+day, {type:'json'}); if(Array.isArray(pts)) points = points.concat(pts); }catch(_){}
      }
      points.sort((a,b)=> (a.t<b.t?-1:a.t>b.t?1:0));
      return json(200,{ok:true, vehicle, from, to, count:points.length, points});
    }

    if(action==='latest'){
      const s = await store(event);
      let snap=null; try{ snap = await s.get('latest',{type:'json'}); }catch(_){}
      return json(200,{ok:true, snapshot:snap});
    }

    // ИМПОРТ: принимает распарсенные точки из Cabman CSV (POST JSON) и сохраняет в Blobs.
    // Тело: { vehicle:"L24628", points:[{t,lat,lng,speed,state,odo,addr,reason,src}, ...] }
    // Точки группируются по дню (UTC) под ключом track:<vehicle>:<YYYY-MM-DD>.
    // Cabman-точки (src:'cabman') приоритетнее само-собранных при дедупе по минуте.
    if(action==='import'){
      let body={};
      try{ body = JSON.parse(event.body||'{}'); }catch(e){ return json(400,{ok:false,error:'bad JSON body'}); }
      const vehicle = body.vehicle;
      const incoming = Array.isArray(body.points) ? body.points : [];
      if(!vehicle || !incoming.length) return json(400,{ok:false,error:'need vehicle and points'});
      const s = await store(event);

      // группируем входящие точки по дню (UTC)
      const byDay = {};
      for(const p of incoming){
        if(!p || !p.t) continue;
        const day = dayKey(p.t);
        (byDay[day] = byDay[day] || []).push(p);
      }

      let savedDays = 0, savedPoints = 0;
      for(const day of Object.keys(byDay)){
        const key = 'track:'+vehicle+':'+day;
        let existing = [];
        try{ const e = await s.get(key,{type:'json'}); if(Array.isArray(e)) existing = e; }catch(_){}
        // объединяем по минуте: Cabman перезаписывает само-собранную точку той же минуты
        const byMin = {};
        for(const p of existing){ const mk=(p.t||'').slice(0,16); if(mk) byMin[mk]=p; }
        for(const p of byDay[day]){
          const mk=(p.t||'').slice(0,16); if(!mk) continue;
          const cur = byMin[mk];
          if(!cur || p.src==='cabman' || cur.src!=='cabman') byMin[mk]=p; // cabman приоритетнее
        }
        const merged = Object.keys(byMin).sort().map(k=>byMin[k]);
        try{ await s.setJSON(key, merged); savedDays++; savedPoints += byDay[day].length; }
        catch(e){ return json(200,{ok:false, where:'setJSON', key, error:String(e&&e.message||e)}); }
      }
      return json(200,{ok:true, vehicle, savedDays, savedPoints, days:Object.keys(byDay)});
    }

    // ДИАГНОСТИКА: пишем точку и тут же читаем обратно, без проглатывания ошибок
    if(action==='diag'){
      const out = { ok:true, steps:[] };
      let s;
      try{ s = await store(event); out.steps.push('store: ok'); }
      catch(e){ return json(200,{ok:false, where:'store', error:String(e&&e.message||e)}); }
      let vehicles;
      try{ vehicles = await fetchCabman(); out.steps.push('fetchCabman: '+vehicles.length+' vehicles'); }
      catch(e){ return json(200,{ok:false, where:'fetchCabman', error:String(e&&e.message||e)}); }
      const v = vehicles.find(x=>x.id && isFinite(x.lat) && isFinite(x.lng));
      if(!v) return json(200,{ok:false, where:'pick', error:'no valid vehicle', sample:vehicles[0]||null});
      const nowIso = new Date().toISOString();
      const key = 'track:'+v.id+':'+dayKey(nowIso);
      out.key = key;
      let before=null;
      try{ before = await s.get(key,{type:'json'}); out.beforeCount = Array.isArray(before)?before.length:(before===null?'null':typeof before); }
      catch(e){ out.steps.push('get-before ERROR: '+String(e&&e.message||e)); }
      const pts = Array.isArray(before)?before:[];
      pts.push({ t:nowIso, lat:v.lat, lng:v.lng, speed:v.speed, state:v.state, odo:v.odometer, tDev:v.time });
      try{ await s.setJSON(key, pts); out.steps.push('setJSON: ok, wrote '+pts.length); }
      catch(e){ return json(200,{ok:false, where:'setJSON', key, error:String(e&&e.message||e)}); }
      let after=null;
      try{ after = await s.get(key,{type:'json'}); out.afterCount = Array.isArray(after)?after.length:(after===null?'null':typeof after); }
      catch(e){ out.steps.push('get-after ERROR: '+String(e&&e.message||e)); }
      return json(200, out);
    }

    // live / collect → fetch from Cabman
    const vehicles = await fetchCabman();
    // Write history on scheduled runs AND on manual collect. connectLambda gives
    // Blobs context in both. Plain 'live' (browser auto-refresh) skips writing.
    const isScheduled = !!(event.headers && (event.headers['x-nf-event'] || event.headers['X-Nf-Event']))
      || action==='collect';
    let historySaved = false;
    if(isScheduled){
      try{ await appendHistory(vehicles, event); historySaved = true; }catch(histErr){ historySaved = false; }
    }
    if(action==='collect') return json(200,{ok:true, collected:vehicles.length, historySaved, at:new Date().toISOString()});
    return json(200,{ok:true, at:new Date().toISOString(), count:vehicles.length, historySaved, vehicles});

  }catch(e){
    return json(500,{ok:false, error:String(e&&e.message||e)});
  }
};
// Schedule is configured in netlify.toml ([functions."cabman-track"] schedule="* * * * *")

// Расписание перенесено сюда из netlify.toml (блок в toml ломал сборку).
// Netlify читает этот экспорт и запускает функцию по cron раз в минуту.
exports.config = { schedule: "* * * * *" };
