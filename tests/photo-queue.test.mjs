import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
// Data URL keeps this test runnable with the project's CommonJS package defaults.
const source=await readFile(new URL('../frontend/ui/photo-queue-core.js',import.meta.url),'utf8');
const {sameEmployee,retryDelay,confirmedUpload,deliverPhoto}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const row={id:'photo-id',tracker_id:2,employee_id:3,employee_code:'EMP3',metadata:'original timestamp and GPS'};
const saved={id:14,mobile_metadata:{upload_id:row.id,...row}};
test('receipt must match upload UUID and original employee',()=>{
 assert(confirmedUpload(saved,row));
 for(const key of ['tracker_id','employee_id','employee_code','upload_id'])assert(!confirmedUpload({...saved,mobile_metadata:{...saved.mobile_metadata,[key]:'wrong'}},row));
 assert(!confirmedUpload({},row));assert(!sameEmployee(row,{...row,employee_id:4}));
});
test('retry delay grows and is bounded',()=>{assert.equal(retryDelay(0),15000);assert.equal(retryDelay(3),120000);assert.equal(retryDelay(100),900000);});
test('confirmed upload commits before cleanup; metadata not changed',async()=>{
 let confirmed=false;
 assert.equal(await deliverPhoto(row,{send:async r=>{assert.equal(r.metadata,row.metadata);return saved;},confirm:async()=>{confirmed=true;},retain:async()=>assert.fail('must not retain')}),'sent');
 assert(confirmed);
});
test('lost reply and restart retry preserve same id and metadata',async()=>{
 let retained=0,commits=0,ids=[];
 const io={send:async r=>{ids.push(r.id);throw Error('offline');},confirm:async()=>commits++,retain:async(r,blocked)=>{assert(!blocked);assert.equal(r.metadata,row.metadata);retained++;}};
 assert.equal(await deliverPhoto(row,io),'waiting');assert.equal(commits,0);assert.equal(retained,1);
 io.send=async r=>{ids.push(r.id);return saved;};
 assert.equal(await deliverPhoto(JSON.parse(JSON.stringify(row)),io),'sent');assert.equal(commits,1);assert.deepEqual(ids,['photo-id','photo-id']);
});
for(const status of [401,403,408,429,500,502])test(`HTTP ${status} retains photo for automatic retry`,async()=>{
 assert.equal(await deliverPhoto(row,{send:async()=>{throw Object.assign(Error('error'),{status});},confirm:async()=>assert.fail(),retain:async(_,blocked)=>assert(!blocked)}),'waiting');
});
for(const status of [409,413,415,422])test(`HTTP ${status} preserves photo and flags attention`,async()=>{
 assert.equal(await deliverPhoto(row,{send:async()=>{throw Object.assign(Error('error'),{status});},confirm:async()=>assert.fail(),retain:async(_,blocked)=>assert(blocked)}),'blocked');
});
test('bad receipt never deletes local photo',async()=>{
 let kept=false;
 assert.equal(await deliverPhoto(row,{send:async()=>({id:1}),confirm:async()=>assert.fail(),retain:async()=>{kept=true;}}),'waiting');assert(kept);
});
test('database commit failure retains image for idempotent retry',async()=>{
 let kept=false;await deliverPhoto(row,{send:async()=>saved,confirm:async()=>{throw Error('disk');},retain:async()=>{kept=true;}});assert(kept);
});
