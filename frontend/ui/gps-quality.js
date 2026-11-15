// Tracking only. Photo location requirements remain separate and unchanged.
export function gpsDistance(a, b) {
 const rad = Math.PI / 180, x = (b.lat-a.lat)*rad, y = (b.lon-a.lon)*rad;
 const h = Math.sin(x/2)**2 + Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(y/2)**2;
 return 12742000*Math.asin(Math.sqrt(Math.min(1,Math.max(0,h))));
}
export function filterGpsFixes(locations, previous = null, now = Date.now()) {
 let anchor = previous;
 const points = [];
 for (const fix of [...locations].sort((a,b)=>a.timestamp-b.timestamp)) {
  const c = fix.coords || {}, p = {lat:c.latitude,lon:c.longitude,acc:c.accuracy,ts:Math.floor(fix.timestamp/1000)};
  if (![p.lat,p.lon,p.acc,p.ts].every(Number.isFinite) || Math.abs(p.lat)>90 || Math.abs(p.lon)>180 || p.acc<0 || p.acc>25 || fix.mocked || now-fix.timestamp>120000 || fix.timestamp-now>30000) continue;
  if (anchor) {
   const dt = p.ts-anchor.ts;
   if (dt<=0) continue;
   // Every good stationary fix advances the anchor, not just saved movement.
   // After a genuine reporting gap the backend starts a separate route segment.
   if (dt<=120 && gpsDistance(anchor,p)>45*dt+anchor.acc+p.acc+25) continue;
  }
  points.push(p);anchor=p;
 }
 return {points,anchor};
}
