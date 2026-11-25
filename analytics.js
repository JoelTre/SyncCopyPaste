// Aggregate counters only; no pairing credentials, file names, or device IDs.
const endpoint = 'https://synccopypaste.joel-tregurtha.workers.dev/analytics';
const settingKey = 'synccopypaste-analytics-enabled';
let enabled = true;
try { enabled = localStorage.getItem(settingKey) !== 'false'; } catch {}
let counters = {};
let sending = false, pending = null;
export function analyticsEnabled() { return enabled; }
export function count(name, value = 1) {
  if (!enabled || !Number.isFinite(value) || value < 0) return;
  counters[name] = (counters[name] || 0) + value;
}
export function transferReceived(category, bytes, milliseconds) {
  count(`${category}_files`); count(`${category}_bytes`, bytes);
  if (Number.isFinite(milliseconds) && milliseconds > 0) { count(`${category}_timed_bytes`, bytes); count(`${category}_milliseconds`, milliseconds); }
}
async function post(payload, keepalive = false) {
  const response = await fetch(endpoint, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),keepalive});
  if (!response.ok) throw new Error('Analytics unavailable');
}
export async function flush(keepalive = false) {
  if (!enabled || sending || (!pending && !Object.keys(counters).length)) return;
  sending = true;
  if (!pending) { pending = {id:crypto.randomUUID(), counters}; counters = {}; }
  const batch = pending;
  try { await post(batch, keepalive); if (pending === batch) pending = null; } catch {}
  finally { sending = false; }
}
export function setAnalyticsEnabled(value) {
  enabled = value;
  try { localStorage.setItem(settingKey, String(value)); } catch {}
  if (!value) { counters = {}; pending = null; void post({id:crypto.randomUUID(), counters:{opt_outs:1}}, true).catch(() => {}); }
  location.reload();
}
setInterval(() => void flush(), 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flush(true); });

window.addEventListener('storage', event => { if (event.key === settingKey) { enabled = event.newValue !== 'false'; if (!enabled) { counters = {}; pending = null; } const toggle = document.getElementById('analytics-enabled'); if (toggle) toggle.checked = enabled; } });
