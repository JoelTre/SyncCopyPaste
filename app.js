import {createFolderBrowser} from './folders.js';
import {openPreview, setPreviewCopyHandler} from './preview.js';
import {FEEDBACK_ENDPOINT} from './feedback-config.js';
const $ = id => document.getElementById(id);
const words = 'amber apple beach birch blue breeze brook cedar cloud coral dawn delta dune eagle earth fern field flame forest frost garden golden harbor hazel hill island ivy jade lake leaf lemon light maple meadow mist moon mountain ocean olive orange orchid pine plum river rose silver sky snow solar star stone sun tiger valley violet willow wind winter'.split(' ');
const random = max => { const limit = Math.floor(4294967296 / max) * max; let n; do { n = crypto.getRandomValues(new Uint32Array(1))[0]; } while (n >= limit); return n % max; };
const createCredentials = () => ({code:Array.from({length:4}, () => words[random(words.length)]).join('-'), passcode:String(random(1000000)).padStart(6,'0')});
const valid = c => c && /^[a-z]+(?:-[a-z]+){3}$/.test(c.code) && /^\d{6}$/.test(c.passcode);
const fragment = decodeURIComponent(location.hash.slice(1)).split(':');
const supplied = {code:fragment[0], passcode:fragment[1]};
const credentials = valid(supplied) ? supplied : createCredentials();
const rememberedKey = 'synccopypaste-devices-v1', identityKey = 'synccopypaste-identity-v1', selectionKey = 'synccopypaste-reconnect-v1';
const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2,'0')).join('');
let identity, devices = [], selectedDevice = null;
try {
  identity = localStorage.getItem(identityKey);
  if (!/^[a-f0-9]{64}$/.test(identity || '')) { identity = randomHex(); localStorage.setItem(identityKey, identity); }
  const stored = JSON.parse(localStorage.getItem(rememberedKey) || '[]');
  if (Array.isArray(stored)) devices = stored.filter(d => d && /^[a-f0-9]{64}$/.test(d.id) && /^[a-f0-9]{64}$/.test(d.secret) && typeof d.name === 'string');
  const selected = sessionStorage.getItem(selectionKey); sessionStorage.removeItem(selectionKey);
  if (!valid(supplied)) selectedDevice = devices.find(d => d.id === selected) || null;
} catch { identity = randomHex(); }
const contribution = randomHex();
async function digest(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))), b => b.toString(16).padStart(2,'0')).join(''); }
function saveDevices() { try { localStorage.setItem(rememberedKey, JSON.stringify(devices)); return true; } catch { notify('Could not remember this device. Check browser storage settings.'); return false; } }
function renderDevices() {
  const list = $('remembered-list'); list.replaceChildren(); $('remembered').hidden = !devices.length;
  for (const device of devices) {
    const row = document.createElement('div'); row.className = 'remembered-row';
    const connect = document.createElement('button'); connect.className = 'primary'; connect.textContent = `Connect to ${device.name}`; connect.disabled = !!selectedDevice;
    connect.onclick = () => { try { sessionStorage.setItem(selectionKey,device.id); location.replace(location.pathname + location.search); } catch { notify('Could not start reconnection. Check browser storage settings.'); } };
    const forget = document.createElement('button'); forget.className = 'icon-button'; forget.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>'; forget.setAttribute('aria-label',`Forget ${device.name}`); forget.title = `Forget ${device.name}`; forget.disabled = !!selectedDevice;
    forget.onclick = () => { devices = devices.filter(d => d.id !== device.id); saveDevices(); renderDevices(); };
    row.append(connect,forget); list.append(row);
  }
  if (selectedDevice) { $('remembered-status').textContent = `Waiting for ${selectedDevice.name}. Open the app there and connect to this device.`; $('cancel-remembered').hidden = false; $('pairing').hidden = true; }
}
$('cancel-remembered').onclick = () => location.replace(location.pathname + location.search);
renderDevices();
if (valid(supplied)) $('connecting-overlay').hidden = false;
const pairURL = new URL(location.href); pairURL.hash = `${credentials.code}:${credentials.passcode}`;
$('pair-link').href = pairURL.href; $('pair-link').textContent = pairURL.href;
$('room-code').textContent = credentials.code; $('passcode').textContent = credentials.passcode;
let room, sendControl, sendFile, connected = false, peerId = null, epoch = 0, noticeTimer, reconnectTimer = null;
const files = new Map(), incoming = new Set(), discarded = new Set();
function notify(message) { $('notice').textContent = message; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => $('notice').textContent = '', 6000); }
function deviceType() {
  const ua = navigator.userAgent, platform = navigator.userAgentData?.platform || navigator.platform || '';
  if (/iPad/i.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone|iPod/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  if (/CrOS/i.test(ua)) return 'Chromebook';
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'Windows desktop';
  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return 'Mac desktop';
  if (/Linux/i.test(platform) || /Linux/i.test(ua)) return 'Linux desktop';
  return 'Device';
}
function formatSize(size) { if (size < 1024) return `${size} B`; if (size < 1048576) return `${(size/1024).toFixed(1)} KB`; if (size < 1073741824) return `${(size/1048576).toFixed(1)} MB`; return `${(size/1073741824).toFixed(2)} GB`; }
function iconFor(file) { if (file.type.startsWith('video/')) return 'fa-file-video'; if (file.type.startsWith('audio/')) return 'fa-file-audio'; if (file.type.startsWith('image/')) return 'fa-file-image'; if (/pdf/i.test(file.type) || /\.pdf$/i.test(file.name)) return 'fa-file-pdf'; if (/zip|compressed|archive/i.test(file.type) || /\.(zip|rar|7z|tar|gz)$/i.test(file.name)) return 'fa-file-zipper'; if (/text|json|javascript/i.test(file.type) || /\.(txt|md|js|html|css|csv)$/i.test(file.name)) return 'fa-file-lines'; return 'fa-file'; }
function render() {
  const list = $('file-list'); list.replaceChildren();
  $('empty').hidden = files.size > 0; $('file-count').textContent = `${files.size} ${files.size === 1 ? 'file' : 'files'}`; $('clear').disabled = files.size === 0;
  for (const {file, url, status} of files.values()) {
    const card = document.createElement('article'); card.className = 'file-card';
    card.addEventListener('click', event => { if (!event.target.closest('button')) void openPreview(file.name, async () => file); });
    const thumb = document.createElement('div'); thumb.className = 'thumb';
    if (file.type.startsWith('image/')) { const img = document.createElement('img'); img.src = url; img.alt = ''; img.onerror = () => { thumb.innerHTML = '<i class="fa-regular fa-file-image"></i>'; }; thumb.append(img); }
    else if (file.type === 'text/plain' && ['Pasted text.txt', 'Clipboard text.txt', 'Dropped text.txt'].includes(file.name)) {
      const preview = document.createElement('div'); preview.className = 'text-preview'; thumb.append(preview);
      file.slice(0, 2048).text().then(text => { preview.textContent = text; }).catch(() => { preview.textContent = 'Preview unavailable'; });
    } else { const icon = document.createElement('i'); icon.className = `fa-regular ${iconFor(file)}`; thumb.append(icon); }
    const name = document.createElement('button'); name.type = 'button'; name.className = 'filename'; name.title = file.name; name.setAttribute('aria-label', `Preview ${file.name}`); name.onclick = () => void openPreview(file.name, async () => file); const dot = file.name.lastIndexOf('.'); const stem = document.createElement('span'); stem.className = 'stem'; stem.textContent = dot > 0 ? file.name.slice(0,dot) : file.name; const ext = document.createElement('span'); ext.className = 'ext'; ext.textContent = dot > 0 ? file.name.slice(dot) : ''; name.append(stem,ext);
    const size = document.createElement('div'); size.className = 'filesize'; size.textContent = `${formatSize(file.size)}${status ? ` · ${status}` : ''}`;
    const actions = document.createElement('div'); actions.className = 'card-actions'; const copy = document.createElement('button'); copy.innerHTML = '<i class="fa-regular fa-copy" aria-hidden="true"></i>'; copy.setAttribute('aria-label', `Copy ${file.name}`); copy.title = 'Copy'; copy.onclick = () => copyFile(file);
    const download = document.createElement('button'); download.innerHTML = '<i class="fa-solid fa-download" aria-hidden="true"></i>'; download.setAttribute('aria-label', `Download ${file.name}`); download.title = 'Download'; download.onclick = () => { const a = document.createElement('a'); a.href = url; a.download = file.name; a.click(); };
    actions.append(copy,download); card.append(thumb,name,size,actions); list.append(card);
  }
}
async function copyFile(file, report = notify) {
  try {
    if (!navigator.clipboard?.write || !window.ClipboardItem) throw new Error('Clipboard file copying is unavailable in this browser.');
    if (file.type.startsWith('text/')) { await navigator.clipboard.writeText(await file.text()); report(`Copied ${file.name} to the clipboard.`); return; }
    let blob = file;
    // Clipboard implementations commonly accept PNG images but not JPEG or GIF.
    if (file.type.startsWith('image/') && file.type !== 'image/png') { const image = await createImageBitmap(file); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d').drawImage(image,0,0); image.close(); blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); if (!blob) throw new Error('Could not copy this image.'); }
    const type = blob.type || 'application/octet-stream'; await navigator.clipboard.write([new ClipboardItem({[type]:blob})]); report(`Copied ${file.name} to the clipboard.`);
  } catch (error) { report(`${error.message || 'This file type cannot be copied in this browser.'} Try Download instead.`); }
}
function addFile(id, file, status = '') { if (files.has(id)) return; files.set(id,{file,url:URL.createObjectURL(file),status}); render(); }
function clearFiles() { pendingClipboard = null; epoch++; for (const id of incoming) discarded.add(id); incoming.clear(); for (const item of files.values()) URL.revokeObjectURL(item.url); files.clear(); render(); }
async function transfer(file, clipboard = false) {
  if (!connected) { notify('Connect another device before adding files.'); return; }
  const id = crypto.randomUUID(), transferEpoch = epoch, target = peerId; addFile(id,file,'Sending…'); sendControl({type:'file-start',id},target);
  try { const data = await file.arrayBuffer(); if (!connected || transferEpoch !== epoch || target !== peerId) return; await sendFile(data,target,{id,name:file.name,type:file.type,lastModified:file.lastModified,clipboard}); if (transferEpoch === epoch && files.has(id)) { files.get(id).status = ''; render(); } }
  catch (error) { if (transferEpoch === epoch && files.has(id)) { files.get(id).status = 'Transfer failed'; render(); notify(`Could not send ${file.name}. Please try again.`); } console.warn('Transfer failed:',error); }
}
async function resendSharedFiles(target) {
  const sessionEpoch = epoch;
  for (const [id, item] of files) {
    if (!connected || peerId !== target || epoch !== sessionEpoch) return;
    try {
      const data = await item.file.arrayBuffer();
      if (!connected || peerId !== target || epoch !== sessionEpoch || files.get(id) !== item) return;
      await sendControl({type:'file-start',id},target);
      await sendFile(data,target,{id,name:item.file.name,type:item.file.type,lastModified:item.file.lastModified,clipboard:false});
      if (files.get(id) === item) { item.status = ''; render(); }
    } catch (error) {
      if (files.get(id) === item && connected && peerId === target) { item.status = 'Transfer failed'; render(); notify(`Could not resend ${item.file.name}.`); }
      console.warn('File resend failed:',error);
    }
  }
}
function addSelected(selected) { for (const file of selected) void transfer(file); }
$('browse').onclick = () => $('file-input').click();
$('paste').onclick = async () => {
  if (!connected) { notify('Connect another device before adding clipboard content.'); return; }
  if (!navigator.clipboard?.read) { notify('Clipboard access is unavailable in this browser.'); return; }
  try {
    const items = await navigator.clipboard.read();
    let added = 0;
    for (const item of items) {
      const type = item.types.includes('image/png') ? 'image/png' : item.types.includes('text/plain') ? 'text/plain' : null;
      if (!type) continue;
      const blob = await item.getType(type);
      if (!blob.size) continue;
      void transfer(new File([blob], type === 'image/png' ? 'Pasted image.png' : 'Pasted text.txt', {type}));
      added++;
    }
    if (!added) notify('No supported text or image found on the clipboard.');
  } catch { notify('Clipboard access was not granted. Allow access and try again.'); }
};
$('file-input').onchange = e => { addSelected(e.target.files); e.target.value = ''; };
for (const type of ['dragenter','dragover']) $('dropzone').addEventListener(type,e => { e.preventDefault(); $('dropzone').classList.add('dragging'); });
$('dropzone').addEventListener('dragleave',e => { if (!$('dropzone').contains(e.relatedTarget)) $('dropzone').classList.remove('dragging'); });
$('dropzone').addEventListener('drop',e => {
  e.preventDefault();
  $('dropzone').classList.remove('dragging');
  const dropped = e.dataTransfer;
  if (dropped.files.length) { addSelected(dropped.files); return; }
  const text = dropped.getData('text/plain');
  if (text) void transfer(new File([text], 'Dropped text.txt', {type:'text/plain'}));
});
$('clear').onclick = () => { if (!connected) return; clearFiles(); sendControl({type:'clear'}); };
$('copy-link').onclick = async () => { try { await navigator.clipboard.writeText(pairURL.href); notify('Connection link copied.'); } catch { notify('Select the link to copy it.'); } };
let shareAppTimer;
$('share-app').onclick = async () => { try { await navigator.clipboard.writeText('https://synccopypaste.app'); $('share-app-status').textContent = 'App link copied'; } catch { $('share-app-status').textContent = 'Could not copy link'; } clearTimeout(shareAppTimer); shareAppTimer = setTimeout(() => { $('share-app-status').textContent = ''; }, 4000); };
const menu = $('menu'); $('menu-button').onclick = () => { menu.hidden = !menu.hidden; $('menu-button').setAttribute('aria-expanded',String(!menu.hidden)); };
document.addEventListener('click', e => { if (!$('menu-button').contains(e.target) && !menu.contains(e.target)) { menu.hidden = true; $('menu-button').setAttribute('aria-expanded','false'); } });
$('how-button').onclick = () => { menu.hidden = true; $('menu-button').setAttribute('aria-expanded','false'); $('how-dialog').showModal(); };
$('about-button').onclick = () => { menu.hidden = true; $('menu-button').setAttribute('aria-expanded','false'); $('about-dialog').showModal(); };
try {
  const endpoint = new URL(FEEDBACK_ENDPOINT);
  if (endpoint.protocol === 'https:' && endpoint.hostname === 'script.google.com' && /^\/macros\/s\/[^/]+\/exec$/.test(endpoint.pathname)) {
    const form = $('feedback-form'), result = $('feedback-result');
    form.action = endpoint.href; form.hidden = false; $('feedback-fallback').hidden = true;
    let pendingFeedback = false;
    form.addEventListener('submit', () => {
      pendingFeedback = true; result.hidden = false; $('feedback-submit').disabled = true;
      $('feedback-status').textContent = 'Sending feedback…';
    });
    result.addEventListener('load', () => {
      if (!pendingFeedback) return;
      pendingFeedback = false; $('feedback-submit').disabled = false;
      $('feedback-status').textContent = 'The submission result appears below.';
    });
  }
} catch { /* The original embedded form remains available until configured. */ }
$('close-about').onclick = () => $('about-dialog').close();
$('about-dialog').addEventListener('click', event => {
  if (event.target !== $('about-dialog')) return;
  const rect = $('about-dialog').getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('about-dialog').close();
});
$('close-dialog').onclick = () => $('how-dialog').close();
$('how-dialog').addEventListener('click', event => {
  if (event.target !== $('how-dialog')) return;
  const rect = $('how-dialog').getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('how-dialog').close();
});
function setTheme(theme) { document.documentElement.dataset.theme = theme; document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f9fbfd' : '#111820'; $('theme-button').innerHTML = theme === 'dark' ? '<i class="fa-solid fa-sun"></i> <span>Light mode</span>' : '<i class="fa-solid fa-moon"></i> <span>Dark mode</span>'; try { localStorage.setItem('synccopypaste-theme',theme); } catch {} }
try { setTheme(localStorage.getItem('synccopypaste-theme') || 'light'); } catch { setTheme('light'); }
$('theme-button').onclick = () => { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); menu.hidden = true; $('menu-button').setAttribute('aria-expanded','false'); };
async function start() {
  try { const {default: QRCode} = await import('https://esm.run/qrcode'); const img = document.createElement('img'); img.src = await QRCode.toDataURL(pairURL.href,{width:384,margin:1}); img.alt = 'Scan to open the connection link'; $('qr').replaceChildren(img); } catch { $('qr').textContent = 'Use the link below'; }
  try {
    let iceServers = [{urls:'stun:stun.l.google.com:19302'}];
    try { const response = await fetch('https://synccopypaste.joel-tregurtha.workers.dev', {signal:AbortSignal.timeout(3500)}); if (!response.ok) throw new Error(`ICE broker: ${response.status}`); const body = await response.json(); const servers = Array.isArray(body) ? body : body.iceServers; if (!Array.isArray(servers) || !servers.length) throw new Error('Invalid ICE server response'); iceServers = servers; } catch (error) { console.warn('Using public STUN fallback:',error); }
    const {joinRoom} = await import('https://esm.run/trystero');
    const roomCode = selectedDevice ? await digest('synccopypaste-room-v1:' + selectedDevice.secret) : credentials.code;
    const password = selectedDevice ? await digest('synccopypaste-password-v1:' + selectedDevice.secret) : credentials.passcode;
    room = joinRoom({appId:'synccopypaste-v1',password,maxUsers:2,rtcConfig:{iceServers}},roomCode);
    const control = room.makeAction('control'), fileAction = room.makeAction('file'), folderFileAction = room.makeAction('folder-file');
    folderFileAction.onMessage((data, context) => folders.onBytes(data, context));
    sendFolderBytes = (data, target, metadata) => folderFileAction.send(data, {target, metadata});
    sendControl = (message, target) => control.send(message, target ? {target} : undefined);
    sendFile = (data, target, metadata) => fileAction.send(data, {target, metadata});
    control.onMessage((message, context) => { const from = context.peerId; if (from !== peerId || !message) return; if (message.type?.startsWith('folder-')) { folders.onControl(message,from); return; } if (message.type === 'hello') { void handleHello(message,from); } else if (message.type === 'clipboard-sync') { peerClipboardEnabled = message.enabled === true; if (!peerClipboardEnabled) pendingClipboard = null; updateClipboardStatus(); if (peerClipboardEnabled && !clipboardEnabled) void enableClipboard(false); else if (peerClipboardEnabled) void checkClipboard(); } else if (message.type === 'file-start' && typeof message.id === 'string') incoming.add(message.id); else if (message.type === 'clear') { clearFiles(); notify('The shared files were cleared.'); } });
    fileAction.onMessage((data, context) => { const {peerId: from, metadata} = context; if (!connected || from !== peerId || !metadata || typeof metadata.id !== 'string' || typeof metadata.name !== 'string' || !(data instanceof Uint8Array)) return; incoming.delete(metadata.id); if (discarded.delete(metadata.id)) return; const file = new File([data],metadata.name,{type:typeof metadata.type === 'string' ? metadata.type : '',lastModified:Number.isFinite(metadata.lastModified) ? metadata.lastModified : Date.now()}); addFile(metadata.id,file); if (metadata.clipboard && clipboardEnabled && peerClipboardEnabled) void receiveClipboard(file); });
    async function handleHello(message, from) {
      if (selectedDevice && message.identity !== selectedDevice.id) { room.leave(); location.replace(location.pathname + location.search); return; }
      const name = typeof message.device === 'string' ? message.device.slice(0,40) : 'device';
      if (!selectedDevice && /^[a-f0-9]{64}$/.test(message.identity || '') && /^[a-f0-9]{64}$/.test(message.contribution || '') && message.identity !== identity) {
        const secret = await digest('synccopypaste-pair-v1:' + [contribution,message.contribution].sort().join(':'));
        if (from !== peerId || !connected) return;
        devices = devices.filter(d => d.id !== message.identity); devices.push({id:message.identity,name,secret}); saveDevices(); renderDevices();
      }
      if (from !== peerId || !connected) return;
      $('remembered').hidden = true; $('pairing').hidden = true; $('workspace').hidden = false; $('peer-name').textContent = `Connected to ${name}`;
      sendControl({type:'clipboard-sync',enabled:clipboardEnabled},from); folders.join();
    }
    room.onPeerJoin(context => {
      const id = typeof context === 'string' ? context : context.peerId, reconnecting = reconnectTimer !== null;
      clearTimeout(reconnectTimer); reconnectTimer = null; peerId = id; connected = true;
      $('connection-lost').hidden = true; $('connecting-overlay').hidden = true;
      if (!selectedDevice) { $('remembered').hidden = true; $('pairing').hidden = true; $('workspace').hidden = false; }
      if (!reconnecting && window.matchMedia('(max-width: 500px)').matches) $('workspace').scrollIntoView({behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block:'start'});
      if (!reconnecting) $('peer-name').textContent = 'Connected to device';
      sendControl({type:'hello',device:deviceType(),identity,contribution},id); folders.join();
      if (reconnecting) void resendSharedFiles(id);
    });
    room.onPeerLeave(context => {
      const id = typeof context === 'string' ? context : context.peerId;
      if (id !== peerId) return;
      connected = false; peerId = null; peerClipboardEnabled = false;
      if (!valid(supplied)) {
        $('connecting-text').textContent = 'Reconnecting...'; $('connecting-overlay').hidden = false;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null; $('connecting-overlay').hidden = true; disableClipboard(); folders.leave(); clearFiles();
          $('workspace').hidden = true; $('pairing').hidden = !!selectedDevice; renderDevices(); $('connection-lost').querySelector('span').textContent = 'Failed to reconnect'; $('connection-lost').hidden = false;
          $('connection-status').textContent = 'Waiting for another device…';
        }, 10000);
        return;
      }
      disableClipboard(); folders.leave(); clearFiles(); $('workspace').hidden = true; $('pairing').hidden = !!selectedDevice; renderDevices();
      $('connection-lost').querySelector('span').textContent = 'Connection lost'; $('connection-lost').hidden = false; $('connection-status').textContent = 'Device disconnected. Waiting for another device…'; notify('The other device disconnected.');
    });
    $('connection-status').textContent = 'Waiting for another device…';
  } catch (error) { $('connecting-overlay').hidden = true; $('connection-status').textContent = 'Could not start the connection. Reload to try again.'; console.error(error); }
}
let clipboardEnabled = false, peerClipboardEnabled = false, clipboardTimer, clipboardBusy = false, lastClipboardHash = '', pendingClipboard = null, clipboardWriteBusy = false;
const clipboardStatus = $('clipboard-status');
function updateClipboardStatus(message = '') {
  clipboardStatus.textContent = message || (clipboardEnabled ? (peerClipboardEnabled ? 'Clipboard sync is on. Keep both pages open and grant clipboard access when asked.' : 'Clipboard sync is on. Waiting for the other device.') : (peerClipboardEnabled ? 'The other device enabled clipboard sync. Click Sync clipboards to allow access on this device.' : ''));
}
function disableClipboard() {
  clipboardEnabled = false; clearInterval(clipboardTimer); clipboardTimer = null; lastClipboardHash = ''; pendingClipboard = null;
  $('sync-clipboard').setAttribute('aria-pressed','false'); $('sync-clipboard').innerHTML = '<i class="fa-regular fa-clipboard"></i> Sync clipboards'; updateClipboardStatus();
}
async function clipboardHash(blob) {
  const bytes = await blob.arrayBuffer(); const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `${blob.type.split(';')[0]}:` + Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,'0')).join('');
}
async function readClipboard() {
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = item.types.includes('image/png') ? 'image/png' : item.types.includes('text/plain') ? 'text/plain' : null;
    if (!type) continue;
    const blob = await item.getType(type); if (!blob.size) continue;
    const hash = await clipboardHash(blob); if (hash === lastClipboardHash) return;
    lastClipboardHash = hash;
    if (connected && peerClipboardEnabled) {
      const name = type === 'image/png' ? 'Clipboard image.png' : 'Clipboard text.txt';
      await transfer(new File([blob],name,{type}),true);
      updateClipboardStatus('Clipboard item sent to the other device.');
    }
    return;
  }
  updateClipboardStatus('No supported text or image found on the clipboard.');
}
async function checkClipboard() {
  if (!clipboardEnabled || !peerClipboardEnabled || !connected || !document.hasFocus() || clipboardBusy || pendingClipboard) return;
  clipboardBusy = true;
  try { await readClipboard(); } catch { updateClipboardStatus('Clipboard access was blocked. Click Sync clipboards to turn it off, then enable it again.'); }
  finally { clipboardBusy = false; }
}
async function receiveClipboard(file) {
  // Ignore the corresponding clipboard-change event so received data is not echoed back.
  lastClipboardHash = await clipboardHash(file);
  pendingClipboard = {file, text: file.type === 'text/plain' ? await file.text() : null};
  await retryClipboardWrite();
}
async function retryClipboardWrite() {
  if (!pendingClipboard || !clipboardEnabled || !peerClipboardEnabled || !connected || clipboardWriteBusy) return;
  const pending = pendingClipboard;
  clipboardWriteBusy = true;
  try {
    if (pending.text !== null) await navigator.clipboard.writeText(pending.text);
    else await navigator.clipboard.write([new ClipboardItem({[pending.file.type]:pending.file})]);
    if (pendingClipboard === pending) { pendingClipboard = null; updateClipboardStatus('Clipboard item received and copied.'); }
  } catch { if (pendingClipboard === pending) updateClipboardStatus('Clipboard item received. Click anywhere in this tab to copy it.'); }
  finally { clipboardWriteBusy = false; }
}
async function enableClipboard(fromClick) {
  if (clipboardEnabled) return;
  if (!fromClick) {
    try { const permission = await navigator.permissions.query({name:'clipboard-read'}); if (permission.state !== 'granted' || !document.hasFocus()) { updateClipboardStatus(); return; } }
    catch { updateClipboardStatus(); return; }
  }
  if (!navigator.clipboard?.read || !navigator.clipboard?.write || !window.ClipboardItem || !window.isSecureContext) { updateClipboardStatus('Clipboard sync is unavailable in this browser. Use HTTPS or localhost and a supported browser.'); return; }
  try {
    // Calling read directly in the click handler lets the browser request access.
    const initial = navigator.clipboard.read();
    await initial;
    clipboardEnabled = true; lastClipboardHash = '';
    $('sync-clipboard').setAttribute('aria-pressed','true'); $('sync-clipboard').innerHTML = '<i class="fa-solid fa-check"></i> Clipboard sync on';
    sendControl({type:'clipboard-sync',enabled:true}); updateClipboardStatus();
    if (peerClipboardEnabled) void checkClipboard();
    clipboardTimer = setInterval(async () => {
      if (!clipboardEnabled || !document.hasFocus()) return;
      // Avoid repeated permission prompts in browsers that require a fresh gesture.
      try { const permission = await navigator.permissions.query({name:'clipboard-read'}); if (permission.state === 'granted') void checkClipboard(); } catch {}
    },1500);
  } catch { updateClipboardStatus(fromClick ? 'Clipboard access was not granted. Allow access and try again.' : 'The other device enabled clipboard sync. Click Sync clipboards to allow access on this device.'); }
}
$('sync-clipboard').onclick = () => {
  if (clipboardEnabled) { disableClipboard(); if (connected) sendControl({type:'clipboard-sync',enabled:false}); return; }
  void enableClipboard(true);
};
navigator.clipboard?.addEventListener('clipboardchange', () => { void checkClipboard(); });
window.addEventListener('focus', () => { if (pendingClipboard) void retryClipboardWrite(); else if (clipboardEnabled && peerClipboardEnabled) void checkClipboard(); });
document.addEventListener('click', () => { if (pendingClipboard) void retryClipboardWrite(); });
setPreviewCopyHandler(copyFile);
let sendFolderBytes;
const folders = createFolderBrowser({send:(...args) => sendControl(...args),sendBytes:(...args) => sendFolderBytes(...args),isConnected:() => connected,getPeer:() => peerId,getDevice:deviceType,copyFile,openPreview});
render(); start();
