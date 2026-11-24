import {isIOS, imageType} from './image-save.js';
// Folder handles stay on the device that selected them; the peer receives only
// requested directory metadata and explicitly requested file contents.
export function createFolderBrowser({send, sendBytes, isConnected, getPeer, getDevice, copyFile, openPreview}) {
  const $ = id => document.getElementById(id);
  let root = null, remote = null, currentPath = [], entries = [], view = 'list', sort = 'name', direction = 1, activeRequest = 0, drag = null;
  let searchTimer, remoteGeneration = 0, pathErrorTimer, pathErrorHideTimer;
  const pending = new Map();
  let selectionMode = false, downloadingSelection = false;
  const selected = new Map(), selectionKey = item => JSON.stringify(item.path);
  let thumbnailObserver, thumbnailGeneration = 0, thumbnailActive = 0;
  let thumbnailQueue = [], thumbnailURLs = [];
  const isImage = item => item.kind === 'file' && ((item.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(item.name));
  function clearThumbnails() {
    thumbnailGeneration++; thumbnailObserver?.disconnect(); thumbnailQueue = [];
    for (const url of thumbnailURLs) URL.revokeObjectURL(url);
    thumbnailURLs = [];
  }
  async function makeThumbnail(file) {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image(); image.src = url;
      await image.decode();
      const scale = Math.min(1, 240 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d'); if (!context) throw new Error('Thumbnail unavailable.');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .7));
      if (!blob) throw new Error('Thumbnail unavailable.');
      return blob;
    } finally { URL.revokeObjectURL(url); }
  }
  function runThumbnailQueue() {
    while (thumbnailActive < 3 && thumbnailQueue.length) {
      const {item, thumb, generation} = thumbnailQueue.shift();
      if (generation !== thumbnailGeneration || !thumb.isConnected) continue;
      thumbnailActive++;
      request('thumbnail', item.path).then(file => {
        if (generation !== thumbnailGeneration || !thumb.isConnected) return;
        const url = URL.createObjectURL(file), image = document.createElement('img');
        thumbnailURLs.push(url); image.alt = ''; image.onload = () => { if (generation === thumbnailGeneration && thumb.isConnected) thumb.replaceChildren(image); }; image.src = url;
      }).catch(() => {}).finally(() => { thumbnailActive--; runThumbnailQueue(); });
    }
  }
  function observeThumbnail(thumb, item) {
    if (!thumbnailObserver) return;
    thumb._thumbnailItem = item; thumbnailObserver.observe(thumb);
  }
  const status = text => $('folder-status').textContent = text;
  function showPathError() {
    const overlay = $('folder-path-error');
    clearTimeout(pathErrorTimer); clearTimeout(pathErrorHideTimer);
    overlay.hidden = false; overlay.classList.remove('fading');
    pathErrorTimer = setTimeout(() => { overlay.classList.add('fading'); pathErrorHideTimer = setTimeout(() => { overlay.hidden = true; overlay.classList.remove('fading'); }, 350); }, 1500);
  }
  const shareStatus = text => $('folder-share-status').textContent = text;
  const safePath = path => Array.isArray(path) && path.length <= 100 && path.every(part => typeof part === 'string' && part.length > 0 && part !== '.' && part !== '..' && !/[\\/\0]/.test(part));
  const sendMessage = message => send(message, getPeer());
  function tellPeer() { if (isConnected()) sendMessage({type:'folder-share', name:root?.name || null, device:getDevice()}); }
  async function directory(path, base) {
    if (!base || !safePath(path)) throw new Error('Folder is unavailable.');
    let handle = base;
    for (const name of path) handle = await handle.getDirectoryHandle(name);
    return handle;
  }
  async function info(handle, path) {
    const item = {name:handle.name, kind:handle.kind, path};
    if (handle.kind === 'file') { const file = await handle.getFile(); item.size = file.size; item.type = file.type; item.modified = file.lastModified; }
    return item;
  }
  async function listing(path, base) {
    const dir = await directory(path, base), result = [];
    for await (const handle of dir.values()) result.push(await info(handle, [...path, handle.name]));
    return result;
  }
  async function searchFolder(path, query, base) {
    const results = [], needle = query.toLocaleLowerCase();
    async function walk(parts) {
      const dir = await directory(parts, base);
      for await (const handle of dir.values()) {
        if (root !== base) throw new Error('Folder sharing stopped.');
        const next = [...parts, handle.name];
        if (handle.kind === 'directory') await walk(next);
        else if (handle.name.toLocaleLowerCase().includes(needle)) results.push(await info(handle, next));
      }
    }
    await walk(path); return results;
  }
  async function handleRequest(message, from) {
    if (!root || from !== getPeer() || typeof message.id !== 'string' || !safePath(message.path)) return;
    const base = root;
    try {
      if (message.operation === 'file' || message.operation === 'thumbnail') {
        if (!message.path.length) throw new Error('Invalid file path.');
        const dir = await directory(message.path.slice(0,-1), base);
        const file = await (await dir.getFileHandle(message.path.at(-1))).getFile();
        const payload = message.operation === 'thumbnail' ? await makeThumbnail(file) : file;
        const bytes = await payload.arrayBuffer();
        if (root !== base || !isConnected() || from !== getPeer()) return;
        await sendBytes(bytes, from, {requestId:message.id, name:file.name, type:payload.type, modified:file.lastModified});
      } else {
        const result = message.operation === 'list' ? await listing(message.path, base) : message.operation === 'search' && typeof message.query === 'string' && message.query.length <= 200 ? await searchFolder(message.path, message.query, base) : null;
        if (!result) throw new Error('Invalid request.');
        if (root === base && isConnected() && from === getPeer()) sendMessage({type:'folder-response',id:message.id,entries:result});
      }
    } catch (error) { if (isConnected() && from === getPeer()) sendMessage({type:'folder-response',id:message.id,error:error.message || 'Could not read the folder.',errorName:error.name}); }
  }
  function request(operation, path, query) {
    if (!remote || !isConnected()) return Promise.reject(new Error('The shared folder is unavailable.'));
    const id = crypto.randomUUID();
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The other device did not respond.')); }, operation === 'search' ? 120000 : 60000);
      pending.set(id,{resolve,reject,timer});
      Promise.resolve(sendMessage({type:'folder-request',id,operation,path,query})).catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
    });
  }
  function rejectPending() { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('The shared folder is no longer available.')); } pending.clear(); }
  function setRemote(message) {
    resetSelection();
    clearThumbnails();
    const wasRemote = remote; remoteGeneration++; activeRequest++; $('folder-loading').hidden = true;
    remote = typeof message.name === 'string' && message.name ? {name:message.name,device:typeof message.device === 'string' ? message.device : 'Device'} : null;
    rejectPending();
    $('folder-tabs').hidden = !remote;
    if (!remote) { showShared(); if (wasRemote) status(''); return; }
    if (!wasRemote) {
      const tabs = $('folder-tabs');
      tabs.classList.remove('attention');
      void tabs.offsetWidth;
      tabs.classList.add('attention');
    }
    $('browse-tab').textContent = `Browse ${remote.device} ${remote.name} folder`;
    currentPath = []; entries = []; $('folder-content').replaceChildren(); $('folder-search').value = ''; $('folder-search-row').hidden = true; $('folder-search-toggle').setAttribute('aria-expanded','false');
    if (!wasRemote) showExplorer();
    else if (!$('folder-explorer').hidden) void load();
  }
  function showShared() { clearThumbnails(); $('workspace').classList.remove('browsing-folder'); $('dropzone').hidden = false; $('folder-explorer').hidden = true; $('shared-tab').classList.add('selected'); $('browse-tab').classList.remove('selected'); $('shared-tab').setAttribute('aria-pressed','true'); $('browse-tab').setAttribute('aria-pressed','false'); }
  function sizeExplorer() {
    if ($('folder-explorer').hidden || !window.matchMedia('(max-width: 500px)').matches) return;
    const topSpace = $('folder-explorer').getBoundingClientRect().top - $('workspace').getBoundingClientRect().top;
    $('workspace').style.setProperty('--explorer-top-space', `${Math.ceil(topSpace + 16)}px`);
  }
  function showExplorer() { if (!remote) return; $('workspace').classList.add('browsing-folder'); $('dropzone').hidden = true; $('folder-explorer').hidden = false; $('shared-tab').classList.remove('selected'); $('browse-tab').classList.add('selected'); $('shared-tab').setAttribute('aria-pressed','false'); $('browse-tab').setAttribute('aria-pressed','true'); requestAnimationFrame(sizeExplorer); void load(); }
  window.addEventListener('resize', () => requestAnimationFrame(sizeExplorer));
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(() => requestAnimationFrame(sizeExplorer));
    observer.observe($('folder-tabs'));
    observer.observe($('workspace').querySelector('.workspace-heading'));
  }
  $('shared-tab').onclick = showShared; $('browse-tab').onclick = showExplorer;
  function breadcrumbs() {
    const nav = $('breadcrumb'); nav.replaceChildren();
    nav.classList.toggle('single-subfolder', currentPath.length === 1);
    [remote.name, ...currentPath].forEach((name,index) => {
      const segment = document.createElement('span'); segment.className = 'breadcrumb-segment';
      if (index) { const chevron = document.createElement('i'); chevron.className = 'fa-solid fa-chevron-right'; chevron.setAttribute('aria-hidden','true'); segment.append(chevron); }
      const button = document.createElement('button'); button.textContent = name; if (index === currentPath.length) button.setAttribute('aria-current','page');
      button.onclick = () => navigate(currentPath.slice(0,index)); segment.append(button); nav.append(segment);
    });
    requestAnimationFrame(() => { updateOverflow(); nav.scrollLeft = nav.scrollWidth; });
  }
  function updateOverflow() {
    const nav = $('breadcrumb'), button = $('breadcrumb-expand');
    button.hidden = true;
    if (!nav.classList.contains('expanded') && nav.clientWidth > 0 && nav.scrollWidth > nav.clientWidth + 1) button.hidden = false;
  }
  $('breadcrumb-expand').onclick = () => { $('breadcrumb').classList.add('expanded'); updateOverflow(); };
  window.addEventListener('resize',updateOverflow);
  const nav = $('breadcrumb');
  nav.addEventListener('pointerdown',e => { if (e.pointerType !== 'mouse') return; drag = {x:e.clientX,scroll:nav.scrollLeft,moved:false}; });
  window.addEventListener('pointermove',e => { if (!drag) return; if (Math.abs(e.clientX-drag.x)>4) drag.moved = true; if (drag.moved) { nav.scrollLeft = drag.scroll-(e.clientX-drag.x); e.preventDefault(); } });
  window.addEventListener('pointerup',() => { if (drag?.moved) { nav.dataset.dragged = 'true'; setTimeout(() => delete nav.dataset.dragged,0); } drag = null; });
  nav.addEventListener('click',e => { if (nav.dataset.dragged) { e.preventDefault(); e.stopPropagation(); } },true);
  function showAddressText() {
    if (!remote || nav.querySelector('input')) return;
    const path = [remote.name, ...currentPath].join('/');
    // A single-quoted POSIX shell argument preserves spaces and other special characters.
    const shellPath = /^[A-Za-z0-9_./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'breadcrumb-text'; input.value = shellPath;
    input.setAttribute('aria-label','Folder path. Press Enter to navigate.');
    nav.replaceChildren(input); $('breadcrumb-expand').hidden = true;
    input.addEventListener('blur', () => { if (nav.contains(input) && remote) breadcrumbs(); }, {once:true});
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); input.blur(); return; }
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      let entered = input.value.trim();
      if (entered.startsWith("'")) {
        if (!entered.endsWith("'") || entered.length < 2) { showPathError(); return; }
        const pieces = entered.slice(1,-1).split("'\\''");
        if (pieces.some(piece => piece.includes("'"))) { showPathError(); return; }
        entered = pieces.join("'");
      }
      entered = entered.replace(/^\.\//,'').replace(/\/$/,'');
      const parts = entered.split('/');
      if (parts.shift() !== remote.name || !safePath(parts)) { showPathError(); return; }
      $('folder-search').value = '';
      $('breadcrumb').classList.remove('expanded');
      void load(parts, true);
    });
    input.focus(); input.select();
  }
  $('breadcrumb-wrap').addEventListener('click', event => {
    if (event.target.closest('button, input') || nav.dataset.dragged) return;
    showAddressText();
  });
  function navigate(path) { $('folder-search').value = ''; $('breadcrumb').classList.remove('expanded'); void load(path); }
  async function load(path = currentPath, addressEntry = false) {
    if (!remote) return;
    const token = ++activeRequest, query = $('folder-search').value.trim();
    $('folder-loading-text').textContent = query ? 'Searching folders…' : 'Loading folder…';
    $('folder-loading').classList.toggle('is-searching', !!query);
    $('folder-loading').hidden = false;
    $('folder-content').setAttribute('aria-busy','true');
    try { const result = await request(query ? 'search' : 'list', path, query); if (token !== activeRequest) return; resetSelection(); currentPath = path; entries = result; breadcrumbs(); render(query); }
    catch (error) {
      const missing = error.name === 'NotFoundError' || /(?:not found|could not be found|does not exist|no such file or directory)/i.test(error.message || '');
      if (token === activeRequest) { if (addressEntry && missing) showPathError(); else status(error.message); }
    }
    finally { if (token === activeRequest) { $('folder-loading').hidden = true; $('folder-content').removeAttribute('aria-busy'); } }
  }
  function fileType(item) { if (item.kind === 'directory') return 'Folder'; const ext = item.name.includes('.') ? item.name.split('.').pop().toUpperCase() : ''; return ext || 'File'; }
  function size(n) { if (!Number.isFinite(n)) return '—'; if (n < 1024) return `${n} B`; if (n < 1048576) return `${(n/1024).toFixed(1)} KB`; if (n < 1073741824) return `${(n/1048576).toFixed(1)} MB`; return `${(n/1073741824).toFixed(2)} GB`; }
  function sorted(items) { return [...items].sort((a,b) => { if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1; const x = sort === 'type' ? fileType(a) : a[sort] ?? '', y = sort === 'type' ? fileType(b) : b[sort] ?? ''; return (typeof x === 'number' && typeof y === 'number' ? x-y : String(x).localeCompare(String(y),undefined,{numeric:true,sensitivity:'base'})) * direction; }); }
  function fileIcon(item) { if (item.kind === 'directory') return 'fa-solid fa-folder'; if ((item.type||'').startsWith('image/')) return 'fa-regular fa-file-image'; if ((item.type||'').startsWith('video/')) return 'fa-regular fa-file-video'; if ((item.type||'').startsWith('audio/')) return 'fa-regular fa-file-audio'; if (/\.pdf$/i.test(item.name)) return 'fa-regular fa-file-pdf'; if (/\.(txt|md|csv|js|json|html|css)$/i.test(item.name)) return 'fa-regular fa-file-lines'; return 'fa-regular fa-file'; }
  async function fileAction(item, action) {
    if (action === 'download' && isIOS() && imageType({name:item.name, type:item.type || ''})) { void openPreview(item.name, () => request('file', item.path)); return; }
    status(`Fetching ${item.name}…`);
    try {
      const file = await request('file',item.path);
      if (action === 'copy') { await copyFile(file); status(''); }
      else { const url = URL.createObjectURL(file), a = document.createElement('a'); a.href = url; a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(url),60000); status(''); }
    } catch (error) { status(error.message); }
  }
  function actionButtons(item) {
    const actions = document.createElement('div'); actions.className = 'folder-item-actions';
    for (const [action,icon] of [['copy','fa-regular fa-copy'],['download','fa-solid fa-download']]) { const button = document.createElement('button'); button.type = 'button'; button.title = action === 'copy' ? 'Copy' : 'Download'; button.setAttribute('aria-label',`${button.title} ${item.name}`); const i = document.createElement('i'); i.className = icon; i.setAttribute('aria-hidden','true'); button.append(i); button.onclick = () => void fileAction(item,action); actions.append(button); }
    return actions;
  }
  function previewFile(item) { void openPreview(item.name, () => request('file', item.path)); }
  function itemName(item) { const name = document.createElement('button'); name.type = 'button'; name.className = 'folder-item-name'; name.textContent = item.name; name.title = item.name; name.onclick = () => item.kind === 'directory' ? navigate(item.path) : previewFile(item); return name; }
  function renderCards(items, container) {
    const grid = document.createElement('div'); grid.className = 'folder-grid';
    for (const item of sorted(items)) { const card = document.createElement('article'); card.className = 'folder-card'; card._folderItem = item; card.classList.toggle('selected', selected.has(selectionKey(item))); card.addEventListener('click', event => { if (!event.target.closest('button')) item.kind === 'directory' ? navigate(item.path) : previewFile(item); }); const thumb = document.createElement('button'); thumb.type = 'button'; thumb.className = 'folder-thumb'; thumb.setAttribute('aria-label',`${item.kind === 'directory' ? 'Open' : 'Preview'} ${item.name}`); thumb.onclick = () => item.kind === 'directory' ? navigate(item.path) : previewFile(item); const icon = document.createElement('i'); icon.className = fileIcon(item); thumb.append(icon); if (isImage(item)) observeThumbnail(thumb,item); card.append(thumb,itemName(item)); const sub = document.createElement('div'); sub.className = 'folder-item-meta'; sub.textContent = item.kind === 'directory' ? 'Folder' : size(item.size); card.append(sub); if (item.kind === 'file') card.append(actionButtons(item)); grid.append(card); }
    container.append(grid);
  }
  function renderList(items, container) {
    const wrapper = document.createElement('div'); wrapper.className = 'folder-table-wrap'; const table = document.createElement('table'); table.className = 'folder-table'; const head = table.createTHead().insertRow();
    for (const [label,key] of [['Name','name'],['Size','size'],['Type','type'],['Date modified','modified']]) { const th = document.createElement('th'), button = document.createElement('button'); button.textContent = `${label}${sort === key ? (direction === 1 ? ' ↑' : ' ↓') : ''}`; th.setAttribute('aria-sort',sort === key ? (direction === 1 ? 'ascending' : 'descending') : 'none'); button.onclick = () => { direction = sort === key ? -direction : 1; sort = key; render($('folder-search').value.trim()); }; th.append(button); head.append(th); }
    const actionsHead = document.createElement('th'); actionsHead.setAttribute('aria-label','Actions'); head.append(actionsHead); const body = table.createTBody();
    for (const item of sorted(items)) { const row = body.insertRow(); row._folderItem = item; row.classList.toggle('selected', selected.has(selectionKey(item))); const name = row.insertCell(); const icon = document.createElement('i'); icon.className = fileIcon(item); name.append(icon,itemName(item)); row.insertCell().textContent = item.kind === 'file' ? size(item.size) : '—'; row.insertCell().textContent = fileType(item); row.insertCell().textContent = item.modified ? new Date(item.modified).toLocaleDateString() : '—'; const actions = row.insertCell(); if (item.kind === 'file') actions.append(actionButtons(item)); }
    wrapper.append(table); container.append(wrapper);
  }
  function render(query) {
    clearThumbnails();
    if (view === 'cards' && window.IntersectionObserver) {
      const generation = thumbnailGeneration;
      thumbnailObserver = new IntersectionObserver(records => {
        if (generation !== thumbnailGeneration || $('folder-explorer').hidden) return;
        for (const record of records) if (record.isIntersecting) {
          thumbnailObserver?.unobserve(record.target);
          thumbnailQueue.push({item:record.target._thumbnailItem, thumb:record.target, generation});
        }
        runThumbnailQueue();
      });
    }
    const content = $('folder-content'); content.replaceChildren(); status(entries.length ? `${entries.length} ${entries.length === 1 ? 'item' : 'items'}${query ? ' found' : ''}` : (query ? 'No matching files found.' : 'This folder is empty.'));
    $('folder-content-area').classList.toggle('no-search-results', !!query && !entries.length);
    requestAnimationFrame(updateCardFades);
    if (!query) { (view === 'cards' ? renderCards : renderList)(entries,content); return; }
    const groups = new Map();
    for (const item of entries) { const path = item.path.slice(currentPath.length,-1), key = JSON.stringify(path); if (!groups.has(key)) groups.set(key,{path,items:[]}); groups.get(key).items.push(item); }
    for (const group of groups.values()) { const section = document.createElement('section'); section.className = 'search-group'; const path = document.createElement('button'); path.type = 'button'; path.className = 'search-path'; const icon = document.createElement('i'); icon.className = 'fa-regular fa-folder-open'; path.append(icon,document.createTextNode(group.path.length ? group.path.join(' › ') : 'Current folder')); const target = [...currentPath, ...group.path]; path.onclick = () => navigate(target); section.append(path); (view === 'cards' ? renderCards : renderList)(group.items,section); content.append(section); }
  }
  function updateSelection() {
    $('folder-select').setAttribute('aria-pressed', String(selectionMode));
    const button = $('folder-download-selected'), count = selected.size;
    button.hidden = !count || !selectionMode;
    button.disabled = downloadingSelection;
    button.querySelector('span').textContent = downloadingSelection ? 'Downloading…' : `${count} ${count === 1 ? 'file' : 'files'}`;
    for (const element of $('folder-content').querySelectorAll('.folder-card, tbody tr')) {
      element.classList.toggle('selected', !!element._folderItem && selected.has(selectionKey(element._folderItem)));
    }
  }
  function resetSelection() { selectionMode = false; selected.clear(); updateSelection(); }
  $('folder-select').onclick = () => { selectionMode = !selectionMode; if (!selectionMode) selected.clear(); updateSelection(); };
  window.matchMedia('(max-width: 500px)').addEventListener('change', event => { if (event.matches) resetSelection(); });
  $('folder-content').addEventListener('click', event => {
    if (!selectionMode) return;
    const element = event.target.closest('.folder-card, tbody tr'), item = element?._folderItem;
    if (!item || item.kind !== 'file') return;
    event.preventDefault(); event.stopPropagation();
    const key = selectionKey(item); if (selected.has(key)) selected.delete(key); else selected.set(key,item);
    updateSelection();
  }, true);
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'a') || $('folder-explorer').hidden || !window.matchMedia('(min-width: 501px)').matches || event.target.closest('input, textarea, [contenteditable="true"]') || document.querySelector('dialog[open]')) return;
    event.preventDefault(); selectionMode = true;
    for (const item of entries) if (item.kind === 'file' && item.path.length === currentPath.length + 1 && currentPath.every((part,index) => item.path[index] === part)) selected.set(selectionKey(item),item);
    updateSelection();
  });
  $('folder-download-selected').onclick = async () => {
    if (downloadingSelection) return;
    const files = [...selected.values()], generation = remoteGeneration;
    downloadingSelection = true; updateSelection();
    try {
      for (const item of files) {
        if (generation !== remoteGeneration || !isConnected()) throw new Error('The shared folder is no longer available.');
        status(`Fetching ${item.name}…`);
        const file = await request('file',item.path);
        if (generation !== remoteGeneration || !isConnected()) throw new Error('The shared folder is no longer available.');
        const url = URL.createObjectURL(file), link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url),60000);
      }
      status('');
    } catch (error) { status(error.message); }
    finally { downloadingSelection = false; updateSelection(); }
  };
  function updateCardFades() {
    const scroller = $('folder-content-wrap'), area = $('folder-content-area');
    area.classList.toggle('no-horizontal-scroll', scroller.scrollWidth <= scroller.clientWidth);
    const visible = view === 'cards' && !$('folder-explorer').hidden;
    area.classList.toggle('fade-top', visible && scroller.scrollTop > 1);
    area.classList.toggle('fade-bottom', visible && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1);
  }
  $('folder-content-wrap').addEventListener('scroll', updateCardFades, {passive:true});
  window.addEventListener('resize', () => requestAnimationFrame(updateCardFades));
  if (window.ResizeObserver) {
    const fadeObserver = new ResizeObserver(() => requestAnimationFrame(updateCardFades));
    fadeObserver.observe($('folder-content-wrap'));
    fadeObserver.observe($('folder-content'));
  }
  $('view-cards').onclick = () => { view = 'cards'; $('view-cards').setAttribute('aria-pressed','true'); $('view-list').setAttribute('aria-pressed','false'); render($('folder-search').value.trim()); };
  $('view-list').onclick = () => { view = 'list'; $('view-cards').setAttribute('aria-pressed','false'); $('view-list').setAttribute('aria-pressed','true'); render($('folder-search').value.trim()); };
  $('folder-search-toggle').onclick = () => { const opening = $('folder-search-row').hidden; $('folder-search-row').hidden = !opening; $('folder-search-toggle').setAttribute('aria-expanded',String(opening)); if (opening) $('folder-search').focus(); else { $('folder-search').value = ''; void load(); } };
  $('folder-search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(load,300); };
  $('folder-search-clear').onclick = () => { $('folder-search').value = ''; $('folder-search').focus(); void load(); };
  $('connect-folder').onclick = async () => {
    if (root) { root = null; $('connect-folder').innerHTML = '<i class="fa-regular fa-folder-open"></i> Connect folder'; shareStatus('Folder disconnected.'); tellPeer(); return; }
    if (!window.showDirectoryPicker) { shareStatus('Folder sharing is unavailable in this browser. Use a browser that supports folder selection.'); return; }
    try { const selected = await window.showDirectoryPicker({mode:'read'}); if (!isConnected()) { shareStatus('Connect another device before sharing a folder.'); return; } root = selected; $('connect-folder').innerHTML = '<i class="fa-solid fa-xmark"></i> Disconnect folder'; shareStatus(`Sharing ${root.name} with the connected device.`); tellPeer(); }
    catch (error) { if (error.name !== 'AbortError') shareStatus('Could not access the folder. Please try again.'); }
  };
  return {
    join() { tellPeer(); },
    leave() { root = null; $('connect-folder').innerHTML = '<i class="fa-regular fa-folder-open"></i> Connect folder'; shareStatus(''); setRemote({}); },
    onControl(message,from) {
      if (message.type === 'folder-share') setRemote(message);
      else if (message.type === 'folder-request') void handleRequest(message,from);
      else if (message.type === 'folder-response') { const item = pending.get(message.id); if (!item) return; pending.delete(message.id); clearTimeout(item.timer); if (message.error) { const error = new Error(message.error); if (typeof message.errorName === 'string') error.name = message.errorName; item.reject(error); } else if (Array.isArray(message.entries)) item.resolve(message.entries); else item.reject(new Error('Invalid folder response.')); }
    },
    onBytes(data,context) { const meta = context.metadata, item = pending.get(meta?.requestId); if (!item || context.peerId !== getPeer() || !(data instanceof Uint8Array) || typeof meta.name !== 'string') return; pending.delete(meta.requestId); clearTimeout(item.timer); item.resolve(new File([data],meta.name,{type:typeof meta.type === 'string' ? meta.type : '',lastModified:Number.isFinite(meta.modified) ? meta.modified : Date.now()})); }
  };
}
