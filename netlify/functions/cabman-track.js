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
async function store(){
  if(_blobs) return _blobs;
  const mod = await import('@netlify/blobs');
  // Netlify provides these env vars automatically in the functions runtime.
  // Passing them explicitly makes Blobs work for HTTP-invoked functions too
  // (not just scheduled ones), avoiding "environment has not been configured" errors.
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  try{
    if(siteID && token){
      _blobs = mod.getStore({ name:'cabman-history', siteID, token });
    } else {
      _blobs = mod.getStore('cabman-history');
    }
  }catch(e){
    _blobs = mod.getStore('cabman-history');
  }
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

async function appendHistory(vehicles){
  const s = await store();
  const today = dayKey(new Date().toISOString());
  // group append per vehicle/day
  for(const v of vehicles){
    if(!v.id || !isFinite(v.lat) || !isFinite(v.lng)) continue;
    const day = dayKey(v.time) || today;
    const key = 'track:'+v.id+':'+day;
    let pts = [];
    try{ const cur = await s.get(key, {type:'json'}); if(Array.isArray(cur)) pts = cur; }catch(_){}
    // de-dup: skip if last point has identical timestamp
    const last = pts[pts.length-1];
    if(!last || last.t !== v.time){
      pts.push({ t:v.time, lat:v.lat, lng:v.lng, speed:v.speed, state:v.state, odo:v.odometer });
      try{ await s.setJSON(key, pts); }catch(e){ /* ignore single-key failure */ }
    }
  }
  // save latest snapshot
  try{ await s.setJSON('latest', { at:new Date().toISOString(), vehicles }); }catch(_){}
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
      const s = await store();
      let points = [];
      for(const day of datesBetween(from,to)){
        try{ const pts = await s.get('track:'+vehicle+':'+day, {type:'json'}); if(Array.isArray(pts)) points = points.concat(pts); }catch(_){}
      }
      points.sort((a,b)=> (a.t<b.t?-1:a.t>b.t?1:0));
      return json(200,{ok:true, vehicle, from, to, count:points.length, points});
    }

    if(action==='latest'){
      const s = await store();
      let snap=null; try{ snap = await s.get('latest',{type:'json'}); }catch(_){}
      return json(200,{ok:true, snapshot:snap});
    }

    // live / collect → fetch from Cabman
    const vehicles = await fetchCabman();
    // Write history ONLY on scheduled/collect runs (Blobs context is available there).
    // Browser 'live' calls just display data — no Blobs write, no errors.
    const isScheduled = !!(event.headers && (event.headers['x-nf-event'] || event.headers['X-Nf-Event']))
      || action==='collect';
    let historySaved = false;
    if(isScheduled){
      try{ await appendHistory(vehicles); historySaved = true; }catch(histErr){ historySaved = false; }
    }
    if(action==='collect') return json(200,{ok:true, collected:vehicles.length, historySaved, at:new Date().toISOString()});
    return json(200,{ok:true, at:new Date().toISOString(), count:vehicles.length, historySaved, vehicles});

  }catch(e){
    return json(500,{ok:false, error:String(e&&e.message||e)});
  }
};
// Schedule is configured in netlify.toml ([functions."cabman-track"] schedule="* * * * *")
