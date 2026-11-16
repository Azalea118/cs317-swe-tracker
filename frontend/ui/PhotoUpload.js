import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Alert, Image, Linking, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import {ImageManipulator, SaveFormat} from 'expo-image-manipulator';
import * as Location from 'expo-location';
import {photoIdentity, savePhoto, listPhotos, subscribePhotos, syncPhotosNow, ensurePhotoBackgroundTask, editPhotoTitle} from './photo-queue';

async function uploadHaptic(success) {
 try {
  if(Platform.OS==='android')await Haptics.performAndroidHapticsAsync(success?Haptics.AndroidHaptics.Confirm:Haptics.AndroidHaptics.Reject);
  else await Haptics.notificationAsync(success?Haptics.NotificationFeedbackType.Success:Haptics.NotificationFeedbackType.Error);
 } catch { /* Visual feedback remains if haptics are disabled. */ }
}
function Action({label,onPress,disabled=false,secondary=false}) {
 return <TouchableOpacity onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled}} style={[styles.button,secondary&&styles.secondary,disabled&&styles.disabled]}><Text style={[styles.buttonText,secondary&&styles.secondaryText]}>{label}</Text></TouchableOpacity>;
}
export default function PhotoUpload({baseUrl,getToken,onBusyChange,onIdentity}) {
 const [title,setTitle]=useState('');
 const [editing,setEditing]=useState(null),[editTitle,setEditTitle]=useState(''),[editError,setEditError]=useState('');
 const [identity,setIdentity]=useState(null),[draft,setDraft]=useState(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('Checking your employee account…'),[failed,setFailed]=useState(false);
 const [rows,setRows]=useState([]),[queueMessage,setQueueMessage]=useState(''),[backgroundReady,setBackgroundReady]=useState(true);
 const [outboxOpen,setOutboxOpen]=useState(false),[banner,setBanner]=useState(null),[locationOpen,setLocationOpen]=useState(false),[locationHelp,setLocationHelp]=useState(false);
 const [manualSync,setManualSync]=useState(false);
 const lastNotice=useRef('');
 const showBanner=useCallback((title,detail,tone='info',key='')=>{
  if(key&&lastNotice.current===key)return;
  lastNotice.current=key;
  setBanner({title,detail,tone});
 },[]);
 useEffect(()=>{
  if(!banner)return;
  const timer=setTimeout(()=>setBanner(null),8000);
  return()=>clearTimeout(timer);
 },[banner]);
 const lock=useRef(false),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;onBusyChange(false);};},[onBusyChange]);
 const loadIdentity=useCallback(async()=>{
  try {
   const info=await photoIdentity(baseUrl,await getToken());
   if(mounted.current){setIdentity(info);onIdentity(info.full_name);setFailed(false);setMessage('');}
   return info;
  } catch(error){if(mounted.current){setFailed(true);setMessage(error.message);}return null;}
 },[baseUrl,getToken,onIdentity]);
 useEffect(()=>{void loadIdentity();},[loadIdentity]);
 useEffect(()=>{
  let active=true;
  const refresh=async()=>{
   if(!identity)return;
   try {const saved=await listPhotos(baseUrl,identity);if(active)setRows(saved);}
   catch {if(active)setQueueMessage('Could not read saved photos. Keep the app installed and try reopening it.');}
  };
  const unsubscribe=subscribePhotos(event=>{
   if(!active)return;
   const notices={
    'title-saved':['Title saved on this phone','The correction will sync automatically when connected.','info'],
    'title-sent':['Title updated','HR can see the correction.','success'],
    saved:['Photo saved on this phone','It will send automatically when connected.','warning'],
    sending:['Sending photo…','You can check progress in Photo outbox.','info'],
    sent:['✓ Photo sent successfully','HR can now see this photo.','success'],
    waiting:['Photo saved — waiting to send','We will retry automatically. See Photo outbox for details.','warning'],
    blocked:['Photo needs attention','Open Photo outbox to read the problem and retry.','error'],
    paused:['Sending is paused',event.message||'Your saved photos remain in Photo outbox.','warning']
   };
   if(event.type==='verified')setBanner(current=>current?.title==='Sending is paused'?null:current);
   const notice=notices[event.type];
   if(notice)showBanner(notice[0],notice[1],notice[2],`${event.id||''}:${event.type}:${event.message||''}`);
   if(event.type==='paused'&&active)setQueueMessage(event.message);
   else if(active)setQueueMessage('');
   if(['sent','blocked'].includes(event.type))void uploadHaptic(event.type==='sent');
   void refresh();
  });
  void refresh();
  void ensurePhotoBackgroundTask().then(ok=>{if(active)setBackgroundReady(ok);});
  const timer=setInterval(()=>void refresh(),5000);
  return()=>{active=false;unsubscribe();clearInterval(timer);};
 },[baseUrl,identity,showBanner]);
 async function run(action) {
  if(lock.current)return;
  lock.current=true;setBusy(true);onBusyChange(true);setFailed(false);
  try{await action();}catch(error){if(mounted.current){setFailed(true);setMessage(error.message||'Could not save this photo. Keep the preview and try again.');void uploadHaptic(false);}}
  finally{lock.current=false;if(mounted.current){setBusy(false);onBusyChange(false);}}
 }
 const choose=source=>run(async()=>{
  if(source==='camera'){
   const permission=await ImagePicker.requestCameraPermissionsAsync();
   if(!permission.granted)throw Error('Camera access is off. Open phone Settings and allow Camera for Northpoint.');
  }
  const permission=await Location.requestForegroundPermissionsAsync();
  if(!permission.granted)throw Error('Location access is off. Open phone Settings and allow precise location.');
  /** @type {ImagePicker.ImagePickerOptions} */
  const options={mediaTypes:['images'],allowsEditing:false,quality:0.85};
  const result=source==='camera'?await ImagePicker.launchCameraAsync(options):await ImagePicker.launchImageLibraryAsync(options);
  if(result.canceled){setMessage('No photo selected.');return;}
  const selectedAt=new Date().toISOString();
  setMessage('Finding your location. Stay here for a moment…');
  let timer;
  let location;
  try{location=await Promise.race([Location.getCurrentPositionAsync({accuracy:Location.Accuracy.High}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Location is taking too long. Move near a window or outside, then select the photo again.')),30000);})]);}
  finally{clearTimeout(timer);}
  const {latitude,longitude,accuracy}=location.coords;
  if(!Number.isFinite(accuracy)||accuracy>25||accuracy<0)throw Error('Your location is not accurate enough yet. Enable precise location and move outside, then select the photo again.');
  if(Math.abs(Date.now()-location.timestamp)>120000||Math.abs(Date.parse(selectedAt)-location.timestamp)>120000)throw Error('The location reading is too old. Please select the photo again.');
  const asset=result.assets[0],context=ImageManipulator.manipulate(asset.uri);
  if(Math.max(asset.width,asset.height)>2000)context.resize(asset.width>=asset.height?{width:2000}:{height:2000});
  const rendered=await context.renderAsync();
  const photo=await rendered.saveAsync({format:SaveFormat.JPEG,compress:0.85});
  setTitle('');setLocationOpen(false);setLocationHelp(false);
  setDraft({uri:photo.uri,metadata:{upload_id:Crypto.randomUUID(),latitude,longitude,accuracy_m:accuracy,location_at:new Date(location.timestamp).toISOString(),selected_at:selectedAt,source}});
  setMessage('');
 });
 const send=()=>run(async()=>{
  if(!draft||!identity)return;
  setMessage('Saving this photo on your phone…');
  if(!title.trim())throw Error('Please enter a photo title before sending.');
  await savePhoto({...draft,metadata:{...draft.metadata,title:title.trim()}},baseUrl,identity);
  if(!mounted.current)return;
  setDraft(null);setMessage('Photo saved on this phone. It will send automatically when connected.');
  setRows(await listPhotos(baseUrl,identity));
 });
 const titleEditor=row=>editing===row.id?<View style={styles.location}>
  <Text style={styles.locationTitle}>Edit Photo Title / Area Supervised</Text>
  <TextInput accessibilityLabel="Edit photo title, required" value={editTitle} onChangeText={value=>{setEditTitle(value);setEditError('');}} maxLength={120} editable={!busy} multiline style={styles.titleInput}/>
  {!!editError&&<Text style={styles.error} accessibilityLiveRegion="polite">{editError}</Text>}
  {!editTitle.trim()&&<Text style={styles.note}>Please enter a photo title before saving.</Text>}
  <Action label="Save" disabled={busy||!editTitle.trim()} onPress={()=>run(async()=>{
   try {
    await editPhotoTitle(row.id,editTitle,baseUrl,identity);
    setRows(await listPhotos(baseUrl,identity));setEditing(null);setEditError('');
   } catch(error){setEditError(error.message||'Could not save the title. Please try again.');}
  })}/>
  <Action label="Cancel" secondary disabled={busy} onPress={()=>{setEditing(null);setEditError('');}}/>
 </View>:<Action label="Edit Title" secondary disabled={busy} onPress={()=>{setEditing(row.id);setEditTitle(row.edit_title||JSON.parse(row.metadata).title||'Untitled Photo');setEditError('');}}/>;
 const pending=rows.filter(row=>row.state!=='sent');
 const pendingTitles=rows.filter(row=>row.title_pending).length;
 const attention=pending.filter(row=>row.state==='blocked').length;
 return <View style={styles.card}>
  <Text style={styles.heading} accessibilityRole="header">Send a work photo</Text>
  {!identity&&<Text style={styles.body}>Checking your linked employee account.</Text>}
  {!identity&&<Action label="Check My Account" onPress={()=>run(loadIdentity)} disabled={busy} secondary/>}
  {!draft&&identity&&<><Action label="Take a Photo" onPress={()=>choose('camera')} disabled={busy}/><Action label="Choose from Gallery" onPress={()=>choose('gallery')} disabled={busy} secondary/></>}
  {draft&&<><Image source={{uri:draft.uri}} style={styles.preview} accessibilityLabel="Photo ready to save and send"/>
   <Text style={styles.body}>{new Date(draft.metadata.selected_at).toLocaleString()}</Text>
   <View style={styles.location}>
    <View style={styles.locationHeader}><TouchableOpacity onPress={()=>setLocationOpen(open=>!open)} accessibilityRole="button" accessibilityLabel="Location details" accessibilityState={{expanded:locationOpen}} style={styles.locationToggle}>
     <View style={styles.outboxLabel}><Text style={styles.locationTitle}>✓ Location ready</Text>{draft.metadata.source==='gallery'&&<Text style={styles.note}>Gallery photo</Text>}<Text style={styles.note}>Accuracy ±{Math.round(draft.metadata.accuracy_m)} m</Text></View>
     <Text style={styles.outboxArrow} accessible={false}>{locationOpen?'▴':'▾'}</Text>
    </TouchableOpacity>
    {draft.metadata.source==='gallery'&&<TouchableOpacity style={styles.helpButton} onPress={()=>setLocationHelp(open=>!open)} accessibilityRole="button" accessibilityLabel="About gallery photo location" accessibilityState={{expanded:locationHelp}}><Text style={styles.helpIcon}>?</Text></TouchableOpacity>}</View>
    {locationHelp&&draft.metadata.source==='gallery'&&<Text style={styles.helpText} accessibilityLiveRegion="polite">This location was recorded when you selected the photo. Gallery photos may have been taken elsewhere. Tap ? again to close.</Text>}
    {locationOpen&&<><Text style={styles.body}>{draft.metadata.latitude.toFixed(6)}, {draft.metadata.longitude.toFixed(6)}</Text>
     {draft.metadata.source==='camera'&&<Text style={styles.note}>Recorded when you selected this camera photo.</Text>}
     <Text style={styles.note}>HR can view this location with a 250 m surrounding area.</Text></>}
   </View>
   <Text style={styles.locationTitle}>Photo Title / Area Supervised</Text>
   <TextInput accessibilityLabel="Photo Title / Area Supervised, required" placeholder="Enter area or site name, e.g., Gate 2 Inspection" placeholderTextColor="#526176" value={title} onChangeText={setTitle} maxLength={120} editable={!busy} multiline style={{fontSize:18,lineHeight:26,minHeight:64,borderWidth:1,borderColor:'#697e97',borderRadius:10,padding:12,color:'#1e3857',backgroundColor:'#fff'}}/>
   {!title.trim()&&<Text style={styles.note}>Please enter a photo title before sending.</Text>}
   <Action label="Send Photo" onPress={send} disabled={busy||!title.trim()}/>
   <Action label="Discard Preview" secondary disabled={busy} onPress={()=>Alert.alert('Discard this preview?','This preview has not been saved to your outbox.',[{text:'Keep Photo',style:'cancel'},{text:'Discard',style:'destructive',onPress:()=>{setDraft(null);setMessage('Preview discarded.');}}])}/>
  </>}
  {busy&&<ActivityIndicator size="large" color="#285587"/>}
  {!!message&&(busy||!!draft||failed||!identity)&&<Text accessibilityLiveRegion="polite" style={[styles.message,failed&&styles.error]}>{message}</Text>}
  {!!banner&&<View accessibilityLiveRegion="polite" style={[styles.feedback,banner.tone==='success'&&styles.successBox,banner.tone==='error'&&styles.errorBox,banner.tone==='warning'&&styles.warningBox]}>
   <Text style={[styles.feedbackTitle,banner.tone==='success'&&styles.successText,banner.tone==='error'&&styles.error]}>{banner.title}</Text>
   <Text style={styles.body}>{banner.detail}</Text>
  </View>}
  {failed&&/access is off|precise location/i.test(message)&&<Action label="Open Phone Settings" onPress={()=>Linking.openSettings()} disabled={busy} secondary/>}
  {!!draft&&<Text style={styles.note}>Send Photo saves it for automatic upload, even offline.</Text>}
  <TouchableOpacity style={styles.outboxToggle} onPress={()=>setOutboxOpen(open=>!open)} accessibilityRole="button"
   accessibilityLabel={`Photo outbox, ${pending.length} waiting${attention?`, ${attention} need attention`:''}`}
   accessibilityHint={outboxOpen?'Hide saved and sent photos':'Show saved and sent photos'} accessibilityState={{expanded:outboxOpen}}>
   <View style={styles.outboxLabel}><Text style={styles.outboxTitle}>Photo outbox · {pending.length} waiting</Text>
    {!!pendingTitles&&<Text style={styles.note}>{pendingTitles} title {pendingTitles===1?'update':'updates'} waiting to sync</Text>}
    {!!attention&&<Text style={styles.error}>{attention} need attention</Text>}
   </View>
   <Text style={styles.outboxArrow} accessible={false}>{outboxOpen?'▴':'▾'}</Text>
  </TouchableOpacity>
  {outboxOpen&&<View style={styles.outboxContents}>
  {!!queueMessage&&banner?.title!=='Sending is paused'&&<Text style={styles.message} accessibilityLiveRegion="polite">{queueMessage}</Text>}
  {!backgroundReady&&<Text style={styles.note}>Background sending is unavailable in phone settings. Saved photos will send automatically while this app is open.</Text>}
  <Action label={manualSync?'Syncing…':'Sync Now'} disabled={busy||!identity} onPress={()=>run(async()=>{
   setManualSync(true);
   try {await syncPhotosNow(baseUrl,identity);setRows(await listPhotos(baseUrl,identity));}
   finally {setManualSync(false);}
  })}/>
  {rows.map(row=>{
   const syncing=(row.state!=='sent'&&row.lease_until>Date.now()) || (row.title_pending&&row.title_lease_until>Date.now());
   const pendingTitle=!!row.title_pending, synced=row.state==='sent'&&!pendingTitle;
   const label=syncing?'Syncing…':synced?'Synced':'Waiting to sync';
   return <View key={row.id} style={styles.outboxItem}>
    <View style={styles.itemTop}><Text style={styles.locationTitle}>{row.edit_title||JSON.parse(row.metadata).title||'Untitled Photo'}</Text>
     <View style={[styles.statusBadge,synced&&styles.syncedBadge]}><Text style={styles.statusText}>{label}</Text></View>
    </View>
    <Text style={styles.note}>{new Date(JSON.parse(row.metadata).selected_at).toLocaleString()}</Text>
    {row.state==='sent'&&pendingTitle&&<Text style={styles.note}>Photo uploaded · Title correction pending</Text>}
    {!synced&&!syncing&&<Text accessibilityLiveRegion="polite" style={styles.itemNote}>{pendingTitle?row.title_message:row.message}</Text>}
    {syncing&&<ActivityIndicator color="#285587"/>}
    {titleEditor(row)}
   </View>;
  })}
  {!rows.length&&<Text style={styles.body}>No saved photos yet.</Text>}
  {!!(pending.length||pendingTitles)&&<Text style={styles.note}>Syncing retries automatically. If an item stays waiting, tap Sync Now and read its note above.</Text>}
  </View>}
 </View>;
}
const styles=StyleSheet.create({
 outboxItem:{backgroundColor:'#fff',borderWidth:1,borderColor:'#cbd8e7',borderRadius:14,padding:16,gap:12},
 itemTop:{gap:10,alignItems:'flex-start'},statusBadge:{backgroundColor:'#edf3fa',borderRadius:16,paddingVertical:6,paddingHorizontal:12},syncedBadge:{backgroundColor:'#dfeaf7'},statusText:{fontSize:15,lineHeight:21,fontWeight:'700',color:'#234e7d'},itemNote:{fontSize:16,lineHeight:24,color:'#405670'},

 titleInput:{fontSize:18,lineHeight:26,minHeight:64,borderWidth:1,borderColor:'#697e97',borderRadius:10,padding:12,color:'#1e3857',backgroundColor:'#fff'},
 outboxToggle:{minHeight:56,flexDirection:'row',alignItems:'center',gap:12,padding:14,borderWidth:1,borderColor:'#b8c9dd',borderRadius:10,backgroundColor:'#edf3fa'},outboxLabel:{flex:1,gap:4},outboxTitle:{fontSize:18,lineHeight:26,fontWeight:'700',color:'#1e3857'},outboxArrow:{fontSize:25,color:'#285587'},outboxContents:{gap:12},
 card:{marginTop:20,padding:20,backgroundColor:'#fff',borderColor:'#cbd5e2',borderWidth:1,borderRadius:18,gap:12},
 heading:{fontSize:24,lineHeight:32,fontWeight:'700',color:'#1e3857'},body:{fontSize:17,lineHeight:26,color:'#33465e'},
 button:{minHeight:56,justifyContent:'center',alignItems:'center',padding:14,borderRadius:10,backgroundColor:'#285587'},
 secondary:{backgroundColor:'#edf3fa',borderColor:'#285587',borderWidth:1},buttonText:{fontSize:18,lineHeight:26,fontWeight:'700',color:'#fff',textAlign:'center'},secondaryText:{color:'#1e3857'},disabled:{opacity:0.5},
 preview:{width:'100%',height:240,resizeMode:'contain',backgroundColor:'#edf3fa',borderRadius:12},
 locationHeader:{flexDirection:'row',alignItems:'center',gap:8},helpButton:{width:48,height:48,alignItems:'center',justifyContent:'center'},helpIcon:{width:26,height:26,lineHeight:24,textAlign:'center',borderRadius:13,borderWidth:1,borderColor:'#697586',backgroundColor:'#e5e7eb',color:'#374151',fontSize:18,fontWeight:'700'},helpText:{fontSize:16,lineHeight:24,color:'#374151',backgroundColor:'#f3f4f6',padding:12,borderRadius:8},
 locationToggle:{flex:1,minHeight:48,flexDirection:'row',alignItems:'center',gap:12},
 location:{backgroundColor:'#edf3fa',padding:14,borderRadius:10,gap:4},locationTitle:{fontSize:18,fontWeight:'700',color:'#1e3857'},
 feedback:{padding:16,borderRadius:12,borderWidth:1,borderColor:'#cbd5e2',backgroundColor:'#f4f7fb',gap:8},feedbackTitle:{fontSize:23,lineHeight:31,fontWeight:'700',color:'#1e3857'},successBox:{backgroundColor:'#edf3fa',borderColor:'#adc4df',borderWidth:1},errorBox:{backgroundColor:'#fff0ef',borderColor:'#963232',borderWidth:2},warningBox:{backgroundColor:'#fff5dd',borderColor:'#896000',borderWidth:2},successText:{color:'#175637'},warningText:{color:'#694900'},
 message:{fontSize:17,lineHeight:26,fontWeight:'600',color:'#1e3857'},error:{color:'#963232'},note:{fontSize:15,lineHeight:23,color:'#526176'}
});
