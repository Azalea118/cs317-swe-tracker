// Real SQLite/filesystem; adapters stand in for Expo's native bridge and HTTP.
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const source=fs.readFileSync(path.join(__dirname,'../frontend/ui/photo-queue.js'),'utf8');
const core=fs.readFileSync(path.join(__dirname,'../frontend/ui/photo-queue-core.js'),'utf8');
const strip=s=>s.replace(/^import .*;\n/gm,'').replace(/\bexport /g,'');
test('durable offline save, restart, account isolation, reconnect, duplicate reply and lease recovery',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'northpoint-outbox-test-'));
 const native=new DatabaseSync(path.join(dir,'queue.db'));
 const db={execAsync:async s=>native.exec(s),getFirstAsync:async(s,...args)=>native.prepare(s).get(...args),getAllAsync:async(s,...args)=>native.prepare(s).all(...args),runAsync:async(s,...args)=>native.prepare(s).run(...args)};
 db.withExclusiveTransactionAsync=async fn=>{native.exec('BEGIN IMMEDIATE');try{await fn(db);native.exec('COMMIT');}catch(e){native.exec('ROLLBACK');throw e;}};
 class Directory {constructor(...parts){this.uri=path.join(...parts.map(p=>p.uri||p));}create(){fs.mkdirSync(this.uri,{recursive:true});}}
 class File extends Directory {get exists(){return fs.existsSync(this.uri);}get size(){return fs.statSync(this.uri).size;}copy(target){fs.copyFileSync(this.uri,target.uri);}delete(){fs.unlinkSync(this.uri);}}
 const secure=new Map([['device_token','token-a']]),prefs=new Map([['server_url','https://test.invalid']]);
 const a={tracker_id:1,employee_id:2,employee_code:'E2',full_name:'Employee A'},b={tracker_id:3,employee_id:4,employee_code:'E4',full_name:'Employee B'};
 let online=true,failReply=false,uploads=0,networkCallback,appCallback;
 const ledger=new Map();
 const fetch=async(url,options)=>{
  if(!online)throw TypeError('offline');
  const identity=options.headers.Authorization==='Bearer token-a'?a:b;
  if(url.endsWith('/device-me'))return {ok:true,json:async()=>identity};
  const meta=JSON.parse(options.body.parts.metadata);
  assert.equal(meta.expected_employee_id,identity.employee_id);
  uploads++;
  if(!ledger.has(meta.upload_id))ledger.set(meta.upload_id,{id:ledger.size+1,mobile_metadata:{...meta,...identity},owner:identity.full_name});
  if(failReply){failReply=false;throw TypeError('connection lost after server commit');}
  return {ok:true,json:async()=>ledger.get(meta.upload_id)};
 };
 const context={Directory,File,Paths:{document:dir},fetch,SQLite:{openDatabaseAsync:async()=>db},Crypto:{randomUUID:crypto.randomUUID,CryptoDigestAlgorithm:{SHA256:'sha256'},digestStringAsync:async(_,s)=>crypto.createHash('sha256').update(s).digest('hex')},SecureStore:{getItemAsync:async k=>secure.get(k),setItemAsync:async(k,v)=>secure.set(k,v),deleteItemAsync:async k=>secure.delete(k)},AsyncStorage:{getItem:async k=>prefs.get(k)},Network:{getNetworkStateAsync:async()=>({isConnected:online,isInternetReachable:online}),addNetworkStateListener:fn=>{networkCallback=fn;return {remove(){}};}},BackgroundTask:{getStatusAsync:async()=>1,BackgroundTaskStatus:{Available:1},registerTaskAsync:async()=>{},BackgroundTaskResult:{Success:1}},TaskManager:{isTaskRegisteredAsync:async()=>true,defineTask:()=>{}},AppState:{currentState:'active',addEventListener:(_,fn)=>{appCallback=fn;return {remove(){}};}},FormData:class{parts={};append(k,v){this.parts[k]=v;}},AbortController,setTimeout,clearTimeout,setInterval,clearInterval,console};
 const load=()=>{const c=vm.createContext({...context});vm.runInContext(strip(core)+'\n'+strip(source)+'\nthis.api={photoIdentity,savePhoto,listPhotos,syncPhotos,startPhotoSync};',c);return c.api;};
 const draftFile=path.join(dir,'preview.jpg');fs.writeFileSync(draftFile,'photo bytes');
 const old='2026-10-01T01:02:03.000Z';
 const draft={uri:draftFile,metadata:{title:'Gate 2 Inspection',upload_id:crypto.randomUUID(),selected_at:old,location_at:old,latitude:8,longitude:124,accuracy_m:12,source:'camera'}};
 let api=load();await api.photoIdentity('https://test.invalid','token-a');online=false;
 await api.savePhoto(draft,'https://test.invalid',a);await api.syncPhotos();
 let rows=await api.listPhotos('https://test.invalid',a);assert.equal(rows.length,1);assert.equal(rows[0].state,'pending');
 const persisted=path.join(dir,'northpoint-photo-outbox',rows[0].filename);assert(fs.existsSync(persisted));
 fs.unlinkSync(draftFile);
 api=load();assert.equal((await api.photoIdentity('https://test.invalid','token-a')).employee_id,2);
 secure.set('device_token','token-b');online=true;await api.syncPhotos();assert.equal(uploads,0);assert.equal((await api.listPhotos('https://test.invalid',b)).length,0);
 secure.set('device_token','token-a');failReply=true;await api.syncPhotos();
 assert.equal(uploads,1);assert.equal(ledger.size,1);assert(fs.existsSync(persisted));
 rows=await api.listPhotos('https://test.invalid',a);assert.equal(rows[0].state,'pending');assert.equal(JSON.parse(rows[0].metadata).selected_at,old);
 assert.equal(JSON.parse(rows[0].metadata).title,'Gate 2 Inspection');
 const stop=api.startPhotoSync();networkCallback({isConnected:true,isInternetReachable:true});
 for(let i=0;i<100 && (await api.listPhotos('https://test.invalid',a))[0].state!=='sent';i++)await new Promise(r=>setTimeout(r,5));
 stop();await api.syncPhotos();rows=await api.listPhotos('https://test.invalid',a);assert.equal(rows[0].state,'sent');assert.equal(ledger.size,1);assert.equal(uploads,2);assert(!fs.existsSync(persisted));
 fs.writeFileSync(draftFile,'second photo');draft.metadata.upload_id=crypto.randomUUID();online=false;
 await api.savePhoto(draft,'https://test.invalid',a);await api.syncPhotos();
 native.prepare("UPDATE photo_outbox SET lease_until=?,lease_key='crashed' WHERE state='pending'").run(Date.now()-1);
 secure.delete('device_token');online=true;api=load();await api.syncPhotos();assert.equal(uploads,2);
 secure.set('device_token','token-a');await api.syncPhotos();assert.equal(uploads,3);
 assert.equal((await api.listPhotos('https://test.invalid',a)).filter(r=>r.state==='sent').length,2);
 assert(appCallback);native.close();fs.rmSync(dir,{recursive:true});
});
