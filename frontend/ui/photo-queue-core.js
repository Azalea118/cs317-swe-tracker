// Pure queue policy: exercised without native modules in tests/photo-queue.test.mjs.
export function sameEmployee(a, b) {
  return a?.tracker_id === b?.tracker_id && a?.employee_id === b?.employee_id &&
    a?.employee_code === b?.employee_code;
}
export function retryDelay(attempts) {
  return Math.min(900000, 15000 * 2 ** Math.min(attempts, 6));
}
export function confirmedUpload(saved, row) {
  return Number.isSafeInteger(saved?.id) && saved.id > 0 &&
    saved.mobile_metadata?.upload_id === row.id && sameEmployee(saved.mobile_metadata, row);
}
// A lost reply is NOT a failed upload: retain file/id and retry idempotently.
export async function deliverPhoto(row, io) {
  try {
    const saved = await io.send(row);
    if (!confirmedUpload(saved, row)) throw Error('The server did not confirm this photo. It remains saved for retry.');
    await io.confirm(row, saved);
    return 'sent';
  } catch (error) {
    const status = error.status || 0;
    const blocked = status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
    const message = photoSyncError(error, 'Photo');
    await io.retain(row, blocked, message);
    return blocked ? 'blocked' : 'waiting';
  }
}

export function photoSyncError(error, item = 'Photo') {
  const code = error.status;
  if ([401,403].includes(code)) return `${item} saved on this phone. The HR server refused access (${code}). Ask HR to check mobile access and the server update, then tap Sync Now.`;
  if (code === 404) return `${item} saved on this phone. The photo or update service was not found (404). Ask HR to check the server update or whether this photo was deleted.`;
  if (code === 429) return `${item} saved on this phone. The server is busy (429). We will retry automatically.`;
  if (code) return `${item} saved on this phone. The server returned ${code}: ${error.message || 'Please try Sync Now or ask HR for help.'}`;
  return `${item} saved on this phone. ${error.name === 'AbortError' ? 'The HR server took too long to reply.' : error.message || 'Could not reach the HR server.'} We will retry automatically.`;
}
