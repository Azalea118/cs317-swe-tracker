import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';

async function deadline(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function Action({ children, onPress, disabled, secondary = false }) {
  return <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} style={[s.button, secondary && s.secondary, disabled && s.disabled]}>
    <Text style={[s.buttonText, secondary && s.secondaryText]}>{children}</Text>
  </TouchableOpacity>;
}

export default function PhotoUploadCard({ username, baseUrl, getToken, onBusy }) {
  const key = `photo_draft_v1:${baseUrl}:${username.trim()}`;
  const [draft, setDraft] = useState(null);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(key);
        if (saved && mounted.current) {
          const value = JSON.parse(saved);
          setDraft(value); setNote(value.metadata?.note || '');
          setMessage(value.metadata ? 'Unconfirmed upload restored. Retry this photo to check or complete it safely.' : 'Your selected photo has been restored.');
        }
        // Recover selection after Android destroys the activity while the picker is open.
        const pending = await ImagePicker.getPendingResultAsync();
        if (!saved && pending && 'canceled' in pending && !pending.canceled && pending.assets?.[0]) {
          const pendingSource = await AsyncStorage.getItem(key + ':picker');
          const value = { asset: pending.assets[0], source: pendingSource === 'camera' ? 'camera' : 'gallery', selectedAt: new Date().toISOString(), requestId: Crypto.randomUUID() };
          await AsyncStorage.setItem(key, JSON.stringify(value));
          if (mounted.current) { setDraft(value); setMessage('Recovered image. Location will be measured before submission.'); }
        }
      } catch { if (mounted.current) setMessage('Could not restore the previous selection. Check the Photo Drawer before selecting it again.'); }
      finally { if (mounted.current) setReady(true); }
    })();
    return () => { mounted.current = false; };
  }, [key]);

  async function run(task) {
    if (locked.current) return;
    locked.current = true; setBusy(true); onBusy(true); setMessage('');
    try { await task(); }
    catch (error) { if (mounted.current) setMessage(error.message || 'Unable to complete this action. Please retry.'); }
    finally { locked.current = false; onBusy(false); if (mounted.current) setBusy(false); }
  }

  function choose(source) {
    run(async () => {
      if (source === 'camera' && !(await ImagePicker.requestCameraPermissionsAsync()).granted) {
        throw new Error('Camera permission is needed. Enable it in Android Settings and try again.');
      }
      await AsyncStorage.setItem(key + ':picker', source);
      /** @type {import('expo-image-picker').ImagePickerOptions} */
      const options = { mediaTypes: ['images'], quality: 0.85, allowsEditing: false };
      const result = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
      await AsyncStorage.removeItem(key + ':picker');
      if (result.canceled) return;
      const asset = result.assets[0];
      if (asset.fileSize > 15 * 1024 * 1024) throw new Error('Choose an image smaller than 15 MB.');
      const value = { asset, source, selectedAt: new Date().toISOString(), requestId: Crypto.randomUUID() };
      await AsyncStorage.setItem(key, JSON.stringify(value));
      setDraft(value); setNote('');
    });
  }

  function upload() {
    run(async () => {
      let value = draft;
      if (!value.metadata) {
        setMessage('Getting your current location…');
        if (!(await Location.requestForegroundPermissionsAsync()).granted) throw new Error('Location permission is required to attach the submission location.');
        const fix = await deadline(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }), 25000, 'No location fix yet. Move outdoors, check Location is on, then retry.');
        const { latitude, longitude, accuracy } = fix.coords;
        if (!Number.isFinite(accuracy) || accuracy < 0 || Date.now() - fix.timestamp > 60000) throw new Error('A fresh location fix with accuracy is required. Please retry outdoors.');
        value = { ...value, metadata: { request_id: value.requestId, source: value.source, selected_at: value.selectedAt,
          location_at: new Date(fix.timestamp).toISOString(), latitude, longitude, accuracy_m: accuracy, note } };
        // Freeze the request before sending. A retry uses exactly this location and ID.
        await AsyncStorage.setItem(key, JSON.stringify(value)); setDraft(value);
      }
      const token = await getToken();
      if (!token) throw new Error('Please sign in again before uploading.');
      const form = new FormData();
      const asset = value.asset;
      const extension = (asset.mimeType || '').split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
      // React Native accepts file URI parts; TypeScript's DOM overload only accepts Blob.
      form.append('file', /** @type {any} */ ({ uri: asset.uri, name: asset.fileName || `photo.${extension}`, type: asset.mimeType || 'image/jpeg' }));
      form.append('metadata', JSON.stringify(value.metadata));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      setMessage('Uploading photo…');
      try {
        const response = await fetch(`${baseUrl}/app2/mobile-upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, signal: ctrl.signal });
        if (response.status === 401) throw new Error('Session expired. Sign out and sign in again, then retry this photo.');
        if (response.status === 403) throw new Error('Ask your administrator to link this tracker to an active employee record, then sign in again.');
        if (response.status === 413) throw new Error('Photo is too large. Choose a photo smaller than 15 MB.');
        if (!response.ok) throw new Error(`Upload not confirmed (${response.status}). Retry this same photo safely; contact your administrator if it continues.`);
        const body = await response.json();
        if (!Number.isInteger(body.id) || !body.owner) throw new Error('Unexpected server response. Retry this same photo to confirm it.');
        await AsyncStorage.removeItem(key);
        setDraft(null); setNote(''); setMessage(`Saved to Photo Drawer as ${body.owner}. Photo #${body.id}.`);
      } catch (error) {
        if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('Connection interrupted; upload is unconfirmed. Retry this same photo safely.');
        throw error;
      } finally { clearTimeout(timer); }
    });
  }

  function discard() {
    Alert.alert('Discard selected photo?', draft?.metadata ? 'The server may already have saved this photo. Check the Photo Drawer before uploading it again.' : 'You can select another photo afterward.', [
      { text: 'Keep photo', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => run(async () => { await AsyncStorage.removeItem(key); setDraft(null); setNote(''); }) },
    ]);
  }

  const disabled = busy || !ready;
  return <View style={s.card}>
    <Text style={s.eyebrow}>FIELD REPORT</Text><Text style={s.title} accessibilityRole="header">Share a work photo</Text>
    <Text style={s.body}>Send a photo to HR with your employee name, date, time and submission location.</Text>
    {!draft ? <View style={s.actions}><Action disabled={disabled} onPress={() => choose('camera')}>Take photo</Action><Action secondary disabled={disabled} onPress={() => choose('gallery')}>Choose photo</Action></View> : <>
      <Image source={{ uri: draft.asset.uri }} style={s.preview} accessibilityLabel="Selected work photo" />
      <Text style={s.body}>{draft.source === 'camera' ? 'Camera' : 'Gallery'} · {new Date(draft.selectedAt).toLocaleString()}</Text>
      <TextInput accessibilityLabel="Photo note" placeholder="Add a note (optional)" multiline maxLength={1000} editable={!disabled && !draft.metadata} value={note} onChangeText={setNote} style={s.input} />
      {draft.metadata && <View style={s.location}><View style={s.radius}><Text style={s.radiusText}>500 m</Text></View><View style={s.locationText}><Text style={s.label}>Submission location</Text><Text style={s.body}>{draft.metadata.latitude.toFixed(5)}, {draft.metadata.longitude.toFixed(5)}{'\n'}GPS accuracy ±{Math.round(draft.metadata.accuracy_m)} m</Text></View></View>}
      <Text style={s.caption}>A fresh location is attached before the first send. The 500 m context area is not GPS accuracy or the photo’s original capture location.</Text>
      <Action disabled={disabled} onPress={upload}>{draft.metadata ? 'Retry / confirm upload' : 'Upload photo'}</Action>
      <Action secondary disabled={disabled} onPress={discard}>Discard selection</Action>
    </>}
    {busy && <ActivityIndicator color="#285587" style={s.spinner} />}
    {!!message && <Text style={s.feedback} accessibilityLiveRegion="polite">{message}</Text>}
  </View>;
}

const s = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 20, padding: 22, marginTop: 18, borderWidth: 1, borderColor: '#e1e7ef', gap: 12 },
  eyebrow: { color: '#637186', fontSize: 12, fontWeight: '700', letterSpacing: 1.5 },
  title: { color: '#1e3857', fontSize: 23, fontWeight: '700' },
  body: { color: '#637186', fontSize: 15, lineHeight: 23 },
  actions: { gap: 10, marginTop: 4 },
  button: { minHeight: 52, backgroundColor: '#285587', borderRadius: 12, alignItems: 'center', justifyContent: 'center', padding: 14 },
  secondary: { backgroundColor: '#edf3fa' }, buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 }, secondaryText: { color: '#285587' }, disabled: { opacity: 0.5 },
  preview: { width: '100%', height: 210, borderRadius: 12, resizeMode: 'cover' },
  input: { borderWidth: 1, borderColor: '#cbd5e2', color: '#22344b', borderRadius: 12, padding: 12, minHeight: 80, textAlignVertical: 'top', fontSize: 16 },
  location: { flexDirection: 'row', gap: 12, alignItems: 'center', padding: 12, backgroundColor: '#edf3fa', borderRadius: 12 },
  radius: { width: 64, height: 64, borderRadius: 32, borderWidth: 2, borderStyle: 'dashed', borderColor: '#285587', alignItems: 'center', justifyContent: 'center' }, radiusText: { color: '#285587', fontWeight: '700', fontSize: 12 }, locationText: { flex: 1 }, label: { color: '#22344b', fontWeight: '700' },
  caption: { color: '#637186', fontSize: 12, lineHeight: 19 }, feedback: { color: '#1e3857', backgroundColor: '#edf3fa', borderRadius: 10, padding: 12, fontSize: 14, lineHeight: 22 }, spinner: { marginTop: 5 },
});
