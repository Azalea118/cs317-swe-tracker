// Real SQLite/filesystem; adapters stand in for Expo's native bridge and HTTP.
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const source=fs.readFileSync(path.join(__dirname,'../frontend/ui/photo-queue.js'),'utf8');
const core=fs.readFileSync(path.join(__dirname,'../frontend/ui/photo-queue-core.js'),'utf8');
const strip=s=>s.replace(/^import .*;\n/gm,'').replace(/\bexport /g,'');
test('offline title edits survive restart, upload and edit races, account changes and lost replies',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'northpoint-outbox-test-'));
 const native=new DatabaseSync(path.join(dir,'queue.db'));
 const db={execAsync:async s=>native.exec(s),getFirstAsync:async(s,...args)=>native.prepare(s).get(...args),getAllAsync:async(s,...args)=>native.prepare(s).all(...args),runAsync:async(s,...args)=>native.prepare(s).run(...args)};
 db.withExclusiveTransactionAsync=async fn=>{native.exec('BEGIN IMMEDIATE');try{await fn(db);native.exec('COMMIT');}catch(e){native.exec('ROLLBACK');throw e;}};
 class Directory {constructor(...parts){this.uri=path.join(...parts.map(p=>p.uri||p));}create(){fs.mkdirSync(this.uri,{recursive:true});}}
 class File extends Directory {get exists(){return fs.existsSync(this.uri);}get size(){return fs.statSync(this.uri).size;}async copy(target){await new Promise(resolve=>setTimeout(resolve,20));fs.copyFileSync(this.uri,target.uri);}delete(){fs.unlinkSync(this.uri);}}
 const secure=new Map([['device_token','token-a']]),prefs=new Map([['server_url','https://test.invalid']]);
 const a={tracker_id:1,employee_id:2,employee_code:'E2',full_name:'Employee A'},b={tracker_id:3,employee_id:4,employee_code:'E4',full_name:'Employee B'};
 let online=true,failReply=false,failIdentity=false,failCache=false,uploads=0,networkCallback,appCallback;
 const ledger=new Map();const revisions=new Map();let api,editDuringUpload=false,editDuringPatch=false,losePatchReply=false,edits=0;
 const fetch=async(url,options)=>{
  if(!online)throw TypeError('offline');
  const identity=options.headers.Authorization==='Bearer token-a'?a:b;
  if(url.endsWith('/device-me')&&failIdentity)return {ok:false,status:503,json:async()=>({detail:'Unavailable'})};
  if(url.endsWith('/device-me'))return {ok:true,json:async()=>identity};
  if(options.method==='PATCH') {
   const change=JSON.parse(options.body),photo=ledger.get(change.upload_id);
   assert.equal(change.expected_employee_id,identity.employee_id);
   const prior=revisions.get(change.upload_id)||0;
   if(change.revision>prior){if(photo.title!==change.title)edits++;photo.title=change.title;revisions.set(change.upload_id,change.revision);}
   const receipt={id:photo.id,upload_id:change.upload_id,revision:revisions.get(change.upload_id),title:photo.title,...identity};
   if(editDuringPatch){editDuringPatch=false;await api.editPhotoTitle(change.upload_id,'Latest correction','https://test.invalid',a);}
   if(losePatchReply){losePatchReply=false;throw TypeError('lost edit receipt');}
   return {ok:true,json:async()=>receipt};
  }
  const meta=JSON.parse(options.body.parts.metadata);
  assert.equal(meta.expected_employee_id,identity.employee_id);
  uploads++;
  if(!ledger.has(meta.upload_id))ledger.set(meta.upload_id,{id:ledger.size+1,mobile_metadata:{...meta,...identity},owner:identity.full_name,title:meta.title});
  if(editDuringUpload){editDuringUpload=false;await api.editPhotoTitle(meta.upload_id,'Corrected during upload','https://test.invalid',a);}
  if(failReply){failReply=false;throw TypeError('connection lost after server commit');}
  return {ok:true,json:async()=>ledger.get(meta.upload_id)};
 };
 const context={Directory,File,Paths:{document:dir},fetch,SQLite:{openDatabaseAsync:async()=>db},Crypto:{randomUUID:crypto.randomUUID,CryptoDigestAlgorithm:{SHA256:'sha256'},digestStringAsync:async(_,s)=>crypto.createHash('sha256').update(s).digest('hex')},SecureStore:{getItemAsync:async k=>secure.get(k),setItemAsync:async(k,v)=>{if(failCache)throw Error('cache unavailable');secure.set(k,v);},deleteItemAsync:async k=>secure.delete(k)},AsyncStorage:{getItem:async k=>prefs.get(k)},Network:{getNetworkStateAsync:async()=>({isConnected:online,isInternetReachable:online}),addNetworkStateListener:fn=>{networkCallback=fn;return {remove(){}};}},BackgroundTask:{getStatusAsync:async()=>1,BackgroundTaskStatus:{Available:1},registerTaskAsync:async()=>{},BackgroundTaskResult:{Success:1}},TaskManager:{isTaskRegisteredAsync:async()=>true,defineTask:()=>{}},AppState:{currentState:'active',addEventListener:(_,fn)=>{appCallback=fn;return {remove(){}};}},FormData:class{parts={};append(k,v){this.parts[k]=v;}},AbortController,setTimeout,clearTimeout,setInterval,clearInterval,console};
 const load=()=>{const c=vm.createContext({...context});vm.runInContext(strip(core)+'\n'+strip(source)+'\nthis.api={photoIdentity,savePhoto,listPhotos,syncPhotos,startPhotoSync,subscribePhotos,editPhotoTitle};',c);return c.api;};
 const draftFile=path.join(dir,'preview.jpg');fs.writeFileSync(draftFile,'photo bytes');
 const old='2026-10-01T01:02:03.000Z';
 const draft={uri:draftFile,metadata:{title:'Original',upload_id:crypto.randomUUID(),selected_at:old,location_at:old,latitude:8,longitude:124,accuracy_m:12,source:'camera'}};
 api=load();await api.photoIdentity('https://test.invalid','token-a');online=false;
 await api.savePhoto(draft,'https://test.invalid',a);await api.syncPhotos();
 await api.editPhotoTitle(draft.metadata.upload_id,'Offline correction','https://test.invalid',a);await api.syncPhotos();
 let row=(await api.listPhotos('https://test.invalid',a))[0];
 assert.equal(JSON.parse(row.metadata).title,'Offline correction');assert.equal(row.edit_title,'Offline correction');
 api=load();row=(await api.listPhotos('https://test.invalid',a))[0];assert.equal(row.title_pending,1);
 secure.set('device_token','token-b');online=true;await api.syncPhotos();assert.equal(uploads,0);assert.equal(edits,0);
 await assert.rejects(api.editPhotoTitle(row.id,'Forbidden','https://test.invalid',a));
 secure.set('device_token','token-a');editDuringUpload=true;await api.syncPhotos();
 row=(await api.listPhotos('https://test.invalid',a))[0];
 assert.equal(uploads,1);assert.equal(ledger.size,1);assert.equal(row.state,'sent');
 assert.equal(row.title_pending,0);assert.equal(row.edit_title,'Corrected during upload');assert.equal(ledger.get(row.id).title,row.edit_title);
 assert.equal(JSON.parse(row.metadata).selected_at,old);assert.equal(JSON.parse(row.metadata).title,'Offline correction');
 online=false;await api.editPhotoTitle(row.id,'Sent photo offline edit','https://test.invalid',a);await api.syncPhotos();
 native.prepare('UPDATE photo_outbox SET sent_at=? WHERE id=?').run(Date.now()-8*86400000,row.id);
 api=load();await api.syncPhotos();assert.equal((await api.listPhotos('https://test.invalid',a)).length,1);
 online=true;losePatchReply=true;await api.syncPhotos();
 row=(await api.listPhotos('https://test.invalid',a))[0];assert.equal(row.title_pending,1);const committed=edits;
 // Retried edit is idempotent after a crash / missing server reply.
 api=load();native.prepare('UPDATE photo_title_edits SET next_try=0').run();await api.syncPhotos();assert.equal(edits,committed);
 row=(await api.listPhotos('https://test.invalid',a))[0];assert.equal(row.title_pending,0);
 native.prepare('UPDATE photo_outbox SET sent_at=?').run(Date.now());
 online=false;await api.editPhotoTitle(row.id,'First correction','https://test.invalid',a);await api.syncPhotos();
 online=true;editDuringPatch=true;await api.syncPhotos();
 row=(await api.listPhotos('https://test.invalid',a))[0];assert.equal(row.edit_title,'Latest correction');assert.equal(row.title_pending,0);assert.equal(ledger.get(row.id).title,'Latest correction');
 assert.equal(uploads,1);assert.equal(ledger.size,1);
 await assert.rejects(api.editPhotoTitle(row.id,'   ','https://test.invalid',a));
 await assert.rejects(api.editPhotoTitle(row.id,'x'.repeat(121),'https://test.invalid',a));
 // Lost upload receipt plus an offline correction must recover the same photo first.
 draft.metadata.upload_id=crypto.randomUUID();online=false;
 await api.savePhoto(draft,'https://test.invalid',a);await api.syncPhotos();
 online=true;failReply=true;await api.syncPhotos();assert.equal(ledger.size,2);
 online=false;await api.editPhotoTitle(draft.metadata.upload_id,'Correct after lost upload reply','https://test.invalid',a);await api.syncPhotos();
 row=(await api.listPhotos('https://test.invalid',a)).find(r=>r.id===draft.metadata.upload_id);
 assert.equal(JSON.parse(row.metadata).title,'Original');assert.equal(row.title_pending,1);
 api=load();native.prepare("UPDATE photo_outbox SET next_try=0 WHERE state='pending'").run();online=true;await api.syncPhotos();
 row=(await api.listPhotos('https://test.invalid',a)).find(r=>r.id===draft.metadata.upload_id);
 assert.equal(row.state,'sent');assert.equal(row.title_pending,0);assert.equal(ledger.size,2);
 assert.equal(ledger.get(row.id).title,'Correct after lost upload reply');
 // Expired title leases recover after a process dies.
 online=false;await api.editPhotoTitle(row.id,'Recovered edit','https://test.invalid',a);await api.syncPhotos();
 native.prepare("UPDATE photo_title_edits SET lease_key='crashed',lease_until=? WHERE photo_id=?").run(Date.now()-1,row.id);
 api=load();online=true;await api.syncPhotos();assert.equal(ledger.get(row.id).title,'Recovered edit');
 native.close();fs.rmSync(dir,{recursive:true});
});
