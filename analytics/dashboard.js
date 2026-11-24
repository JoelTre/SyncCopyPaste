const endpoint = 'https://synccopypaste.joel-tregurtha.workers.dev/analytics/summary';
const $ = id => document.getElementById(id);
try { document.documentElement.dataset.theme = localStorage.getItem('synccopypaste-theme') || 'light'; } catch {}
const number = value => new Intl.NumberFormat(undefined, {maximumFractionDigits: 0}).format(value);
function dataSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B','KB','MB','GB','TB','PB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
  return `${new Intl.NumberFormat(undefined,{maximumFractionDigits: power ? 2 : 0}).format(bytes / 1000 ** power)} ${units[power]}`;
}
function rate(bytes, milliseconds) { return milliseconds > 0 ? `${new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(bytes * 8 / milliseconds / 1000)} Mbps` : '—'; }
async function refresh() {
  $('refresh').disabled = true; $('status').textContent = 'Loading analytics…';
  try {
    const response = await fetch(endpoint, {cache:'no-store', signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error('Analytics unavailable');
    const body = await response.json();
    if (!body.metrics || typeof body.metrics !== 'object') throw new Error('Invalid analytics response');
    const m = body.metrics, value = key => Number.isFinite(m[key]) && m[key] >= 0 ? m[key] : 0;
    const categories = ['shared','explorer','clipboard'];
    for (const category of categories) {
      $(`${category}-files`).textContent = number(value(`${category}_files`));
      $(`${category}-bytes`).textContent = dataSize(value(`${category}_bytes`));
      $(`${category}-rate`).textContent = rate(value(`${category}_timed_bytes`),value(`${category}_milliseconds`));
    }
    const sum = key => categories.reduce((total,category) => total + value(`${category}_${key}`),0);
    $('pairs').textContent = number(value('pairs')); $('attempts').textContent = number(value('connection_attempts'));
    $('connections').textContent = number(value('connections')); $('optouts').textContent = number(value('opt_outs'));
    $('files').textContent = number(sum('files')); $('bytes').textContent = dataSize(sum('bytes'));
    $('rtt').textContent = value('rtt_samples') ? `${new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(value('rtt_sum_ms') / value('rtt_samples'))} ms` : '—';
    $('rate').textContent = rate(sum('timed_bytes'),sum('milliseconds'));
    $('status').textContent = `Updated ${new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}`;
  } catch { $('status').textContent = 'Could not load analytics. Please try again.'; }
  finally { $('refresh').disabled = false; }
}
$('refresh').addEventListener('click', refresh);
void refresh();
