const endpoint = 'https://synccopypaste.joel-tregurtha.workers.dev/analytics/summary';
const $ = id => document.getElementById(id);
const menu = $('menu'), menuButton = $('menu-button');
function closeMenu() { menu.hidden = true; menuButton.setAttribute('aria-expanded', 'false'); }
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f9fbfd' : '#111820';
  $('theme-button').innerHTML = theme === 'dark' ? '<i class="fa-solid fa-sun"></i> <span>Light mode</span>' : '<i class="fa-solid fa-moon"></i> <span>Dark mode</span>';
  try { localStorage.setItem('synccopypaste-theme', theme); } catch {}
}
try { setTheme(localStorage.getItem('synccopypaste-theme') || 'light'); } catch { setTheme('light'); }
menuButton.addEventListener('click', () => { menu.hidden = !menu.hidden; menuButton.setAttribute('aria-expanded', String(!menu.hidden)); });
document.addEventListener('click', event => { if (!menuButton.contains(event.target) && !menu.contains(event.target)) closeMenu(); });
$('theme-button').addEventListener('click', () => { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); closeMenu(); });
$('about-button').addEventListener('click', () => { location.href = '../?dialog=about'; });
$('how-button').addEventListener('click', () => { location.href = '../?dialog=how'; });
const number = value => new Intl.NumberFormat(undefined, {maximumFractionDigits: 0}).format(value);
function dataSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B','KB','MB','GB','TB','PB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
  return `${new Intl.NumberFormat(undefined,{maximumFractionDigits: power ? 2 : 0}).format(bytes / 1000 ** power)} ${units[power]}`;
}
function rate(bytes, milliseconds) { return milliseconds > 0 ? `${new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(bytes * 8 / milliseconds / 1000)} Mbps` : '—'; }
let metrics = null;
function render() {
  if (!metrics) return;
  const m = metrics, value = key => Number.isFinite(m[key]) && m[key] >= 0 ? m[key] : 0;
  const categories = ['shared','explorer','clipboard'];
  for (const category of categories) {
    $(`${category}-files`).textContent = number(value(`${category}_files`));
    $(`${category}-bytes`).textContent = dataSize(value(`${category}_bytes`));
    $(`${category}-rate`).textContent = rate(value(`${category}_timed_bytes`),value(`${category}_milliseconds`));
  }
  const sum = key => categories.reduce((total,category) => total + value(`${category}_${key}`),0);
  $('pairs').textContent = number(value('pairs'));
  $('attempts').textContent = number(value('connection_attempts'));
  $('connections').textContent = number(value('connections'));
  $('optouts').textContent = number(value('opt_outs'));
  $('files').textContent = number(sum('files'));
  $('bytes').textContent = dataSize(sum('bytes'));
  $('rtt').textContent = value('rtt_samples') ? `${new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(value('rtt_sum_ms') / value('rtt_samples'))} ms` : '—';
  $('rate').textContent = rate(sum('timed_bytes'),sum('milliseconds'));
}
async function refresh() {
  $('refresh').disabled = true; $('status').textContent = 'Loading analytics…';
  try {
    const response = await fetch(endpoint, {cache:'no-store', signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error('Analytics unavailable');
    const body = await response.json();
    if (!body.metrics || typeof body.metrics !== 'object') throw new Error('Invalid analytics response');
    metrics = body.metrics;
    render();
    $('status').textContent = `Updated ${new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}`;
  } catch { $('status').textContent = 'Could not load analytics. Please try again.'; }
  finally { $('status').classList.remove('loading'); $('refresh').disabled = false; }
}
const historyEndpoint = endpoint.replace('/summary', '/history');
let historyRows = [];
const categoryNames = ['shared', 'explorer', 'clipboard'];
function renderHistory() {
  const chart = $('history-chart'), table = $('history-values');
  chart.replaceChildren(); table.replaceChildren();
  if (!historyRows.length) { $('history-status').textContent = 'No daily analytics are available yet.'; $('history-details').hidden = true; return; }
  const days = new Map();
  for (const row of historyRows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day) || typeof row.metric !== 'string' || !Number.isFinite(row.value) || row.value < 0) continue;
    if (!days.has(row.day)) days.set(row.day, {});
    days.get(row.day)[row.metric] = row.value;
  }
  const dates = [...days.keys()].sort();
  if (!dates.length) { $('history-status').textContent = 'No daily analytics are available yet.'; $('history-details').hidden = true; return; }
  const selected = $('history-metric').value;
  const entries = [];
  const start = Date.parse(dates[0] + 'T00:00:00Z'), end = Date.parse(dates[dates.length - 1] + 'T00:00:00Z');
  for (let date = start; date <= end; date += 86400000) {
    const day = new Date(date).toISOString().slice(0, 10), m = days.get(day) || {};
    const sum = suffix => categoryNames.reduce((total, category) => total + (m[`${category}_${suffix}`] || 0), 0);
    let value;
    if (selected === 'files' || selected === 'bytes') value = sum(selected);
    else if (selected === 'rtt') value = m.rtt_samples ? (m.rtt_sum_ms || 0) / m.rtt_samples : null;
    else if (selected === 'rate') value = sum('milliseconds') ? sum('timed_bytes') * 8 / sum('milliseconds') / 1000 : null;
    else value = m[selected] || 0;
    entries.push({day, value});
  }
  const format = value => value === null ? '—' : selected === 'bytes' ? dataSize(value) : selected === 'rtt' ? `${new Intl.NumberFormat(undefined, {maximumFractionDigits:1}).format(value)} ms` : selected === 'rate' ? `${new Intl.NumberFormat(undefined, {maximumFractionDigits:2}).format(value)} Mbps` : number(value);
  for (const entry of entries) {
    const tr = document.createElement('tr'), day = document.createElement('th'), value = document.createElement('td');
    day.scope = 'row'; day.textContent = entry.day; value.textContent = format(entry.value); tr.append(day, value); table.append(tr);
  }
  $('history-details').hidden = false;
  const valid = entries.filter(entry => entry.value !== null);
  if (!valid.length) { $('history-status').textContent = 'No samples are available for this metric.'; return; }
  $('history-status').textContent = 'Days without recorded counts are shown as zero; averages require samples.';
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 700 240'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `${$('history-metric').selectedOptions[0].textContent} by day. Exact values are in the table below.`);
  const make = (tag, attrs, text) => { const el = document.createElementNS(ns, tag); for (const [key, val] of Object.entries(attrs)) el.setAttribute(key, val); if (text !== undefined) el.textContent = text; svg.append(el); return el; };
  const max = Math.max(...valid.map(entry => entry.value)) || 1, x = i => entries.length === 1 ? 370 : 60 + i * 620 / (entries.length - 1), y = value => 190 - value / max * 160;
  make('line', {x1:60,y1:190,x2:680,y2:190,class:'axis'});
  make('text', {x:55,y:25,'text-anchor':'end'}, format(max)); make('text', {x:55,y:194,'text-anchor':'end'}, format(0));
  make('text', {x:60,y:215}, entries[0].day); if (entries.length > 1) make('text', {x:680,y:215,'text-anchor':'end'}, entries[entries.length-1].day);
  let segment = [];
  const draw = () => { if (segment.length > 1) make('polyline', {points:segment.map(p => `${p.x},${p.y}`).join(' '),class:'plot'}); segment = []; };
  entries.forEach((entry, i) => { if (entry.value === null) { draw(); return; } segment.push({x:x(i),y:y(entry.value)}); }); draw();
  entries.forEach((entry, i) => { if (entry.value !== null) { const point = make('circle', {cx:x(i),cy:y(entry.value),r:3,class:'point'}); const title = document.createElementNS(ns,'title'); title.textContent = `${entry.day}: ${format(entry.value)}`; point.append(title); } });
  chart.append(svg);
}
async function refreshHistory() {
  $('history-status').textContent = 'Loading history…';
  try {
    const response = await fetch(historyEndpoint, {cache:'no-store', signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error('History unavailable');
    const body = await response.json();
    if (!Array.isArray(body.rows)) throw new Error('Invalid history response');
    historyRows = body.rows; renderHistory();
  } catch { historyRows = []; $('history-chart').replaceChildren(); $('history-details').hidden = true; $('history-status').textContent = 'Could not load history. Check that the Worker has been updated, then refresh.'; }
}
$('history-metric').addEventListener('change', renderHistory);
$('refresh').addEventListener('click', refreshHistory);
void refreshHistory();
$('refresh').addEventListener('click', refresh);
void refresh();
