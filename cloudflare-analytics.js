// The beacon runs only while this browser has analytics enabled.
const analyticsSettingKey = 'synccopypaste-analytics-enabled';
let analyticsAllowed = true;
try { analyticsAllowed = localStorage.getItem(analyticsSettingKey) !== 'false'; } catch {}
if (analyticsAllowed) {
  const beacon = document.createElement('script');
  beacon.type = 'module';
  beacon.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  beacon.dataset.cfBeacon = JSON.stringify({token: '9f32147a49bb440da41e4f767608acf7'});
  document.head.appendChild(beacon);
}
// A loaded beacon cannot be stopped reliably; reload to apply a changed setting.
window.addEventListener('storage', event => {
  if (event.key === analyticsSettingKey && (event.newValue !== 'false') !== analyticsAllowed) location.reload();
});
