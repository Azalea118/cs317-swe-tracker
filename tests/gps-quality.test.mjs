import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../frontend/ui/gps-quality.js',import.meta.url),'utf8');
const {filterGpsFixes}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const now=Date.now();
const fix=(seconds,lat=8.157,acc=10)=>({timestamp:now+seconds*1000,coords:{latitude:lat,longitude:125.127,accuracy:acc}});
test('rejects coarse, stale, future and malformed tracking fixes',()=>{
 const result=filterGpsFixes([fix(-5,8.157,411),fix(-121),fix(31),fix(-3,91),fix(-2,8.157,-1),fix(-1)],null,now);
 assert.equal(result.points.length,1);
 assert.equal(result.points[0].acc,10);
});
test('stationary quality anchor prevents a teleport after long stationary time',()=>{
 let anchor=null;
 for(let t=-600;t<=-3;t+=3)anchor=filterGpsFixes([fix(t)],anchor,now+t*1000).anchor;
 const result=filterGpsFixes([fix(0,8.6)],anchor,now);
 assert.equal(result.points.length,0);assert.equal(result.anchor.lat,8.157);
 const recovered=filterGpsFixes([fix(3,8.1571)],result.anchor,now+3000);
 assert.equal(recovered.points.length,1);
});
test('normal walking/driving and resuming after a reporting gap remain possible',()=>{
 let result=filterGpsFixes([fix(-10),fix(-7,8.1573),fix(-4,8.1576)],null,now);
 assert.equal(result.points.length,3);
 result=filterGpsFixes([fix(180,8.2)],result.anchor,now+180000);
 assert.equal(result.points.length,1);
});
