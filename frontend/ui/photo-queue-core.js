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
    const message = [401, 403].includes(status)
      ? 'Sign in again with this employee account. This photo is still saved.'
      : blocked ? (error.message || 'The server rejected this photo. Contact HR.')
      : 'Saved on this phone. Waiting for a connection to the server; retrying automatically.';
    await io.retain(row, blocked, message);
    return blocked ? 'blocked' : 'waiting';
  }
}
