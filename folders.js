import {isIOS, imageType} from './image-save.js';
// Folder handles stay on the device that selected them; the peer receives only
// requested directory metadata and explicitly requested file contents.
export function createFolderBrowser({send, sendBytes, isConnected, getPeer, getDevice, copyFile, openPreview, shareFile, recordTransfer}) {
  const $ = id => document.getElementById(id);
  let root = null, remote = null, currentPath = [], entries = [], view = 'list', sort = 'name', direction = 1, activeRequest = 0, drag = null;
  let searchTimer, remoteGeneration = 0, pathErrorTimer, pathErrorHideTimer, source = null;
  const activeFolder = () => source === 'local' ? root : source === 'remote' ? remote : null;
  const pending = new Map(), incomingStreams = new Map();
  const CHUNK_SIZE = 1024 * 1024, STREAM_THRESHOLD = 8 * 1024 * 1024;
  let selectionMode = false, downloadingSelection = false, selectionAnchor = null;
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
  const status = text => { $('folder-status').textContent = text; $('folder-status').classList.toggle('empty-folder', text === 'This folder is empty.'); };
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
      if (message.operation === 'stream-start') {
        const info = message.query;
        if (!info || !safePath([info.name]) || !Number.isSafeInteger(info.size) || info.size < STREAM_THRESHOLD) throw new Error('Invalid transfer request.');
        const output = await openCopyWriter(info.name,message.path,base);
        if (root !== base || !isConnected() || from !== getPeer()) { await output.writable.abort().catch(() => {}); return; }
        const streamId = crypto.randomUUID(), state = {...output,base,from,size:info.size,offset:0,writing:false,timer:null}; incomingStreams.set(streamId,state); armStreamTimeout(streamId,state);
        sendMessage({type:'folder-response',id:message.id,entries:[streamId,output.name]});
      } else if (message.operation === 'stream-finish' || message.operation === 'stream-cancel') {
        const streamId = message.query?.streamId, state = incomingStreams.get(streamId);
        if (!state || state.from !== from || state.base !== base || state.writing) throw new Error('Transfer is unavailable.');
        if (message.operation === 'stream-finish' && state.offset !== state.size) throw new Error('Transfer is incomplete.');
        incomingStreams.delete(streamId); clearTimeout(state.timer);
        if (message.operation === 'stream-finish') { try { await state.writable.close(); } catch (error) { await state.writable.abort().catch(() => {}); throw error; } if (isConnected() && from === getPeer()) { sendMessage({type:'folder-response',id:message.id,entries:[state.name]}); refreshLocalView(); } }
        else { await state.writable.abort(); if (isConnected() && from === getPeer()) sendMessage({type:'folder-response',id:message.id,entries:[]}); }
      } else if (message.operation === 'read-chunk') {
        const chunk = message.query;
        if (!message.path.length || !chunk || !Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || !Number.isSafeInteger(chunk.size) || chunk.size < 0 || !Number.isSafeInteger(chunk.modified)) throw new Error('Invalid chunk request.');
        const dir = await directory(message.path.slice(0,-1),base), file = await (await dir.getFileHandle(message.path.at(-1))).getFile();
        if (file.size !== chunk.size || file.lastModified !== chunk.modified || chunk.offset >= file.size) throw new Error('The source file changed during transfer.');
        const bytes = await file.slice(chunk.offset,Math.min(file.size,chunk.offset + CHUNK_SIZE)).arrayBuffer();
        if (root === base && isConnected() && from === getPeer()) await sendBytes(bytes,from,{requestId:message.id,name:file.name,type:file.type,modified:file.lastModified});
      } else if (message.operation === 'rename') {
        if (!['file','directory'].includes(message.kind)) throw new Error('Invalid item type.');
        await renameLocal(message.path, message.kind, message.name, base);
        if (root === base && isConnected() && from === getPeer()) { sendMessage({type:'folder-response',id:message.id,entries:[message.name]}); refreshLocalView(); }
      } else if (message.operation === 'mkdir') {
        if (!safePath([message.name])) throw new Error('Invalid folder name.');
        const name = await makeDirectoryCopy(message.path, message.name, base);
        if (root === base && isConnected() && from === getPeer()) { sendMessage({type:'folder-response',id:message.id,entries:[name]}); refreshLocalView(); }
      } else if (message.operation === 'file' || message.operation === 'thumbnail') {
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
  function request(operation, path, query, which = source, onProgress) {
    if (!(which === 'local' ? root : which === 'remote' ? remote : null) || !isConnected()) return Promise.reject(new Error('The shared folder is unavailable.'));
    if (which === 'local') {
      const base = root;
      return (async () => {
        if (operation === 'list') return listing(path, base);
        if (operation === 'search') return searchFolder(path, query, base);
        const dir = await directory(path.slice(0, -1), base);
        const file = await (await dir.getFileHandle(path.at(-1))).getFile();
        return operation === 'thumbnail' ? makeThumbnail(file) : file;
      })();
    }
    const id = crypto.randomUUID();
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The other device did not respond.')); }, operation === 'search' ? 120000 : 60000);
      pending.set(id,{resolve,reject,timer,onProgress});
      Promise.resolve(sendMessage({type:'folder-request',id,operation,path,query})).catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
    });
  }
  function rejectPending() { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('The shared folder is no longer available.')); } pending.clear(); }
  function updateTabs() {
    const localTab = $('local-browse-tab'), remoteTab = $('browse-tab');
    $('folder-tabs').hidden = !root && !remote;
    localTab.hidden = !root; remoteTab.hidden = !remote; $('split-tab').hidden = !root || !remote;
    if (root) localTab.textContent = `Browse this device's ${root.name} folder`;
    if (remote) remoteTab.textContent = `Browse ${remote.device} ${remote.name} folder`;
    const measure = $('folder-tabs').cloneNode(true);
    Object.assign(measure.style, {position:'fixed', visibility:'hidden', width:'max-content', maxWidth:'none', flexWrap:'nowrap'});
    for (const button of measure.querySelectorAll('button')) Object.assign(button.style, {whiteSpace:'nowrap', maxWidth:'none', flex:'none'});
    document.body.append(measure);
    $('workspace').closest('main').style.setProperty('--folder-tabs-width', `${Math.ceil(measure.getBoundingClientRect().width)}px`);
    measure.remove();
  }
  function setRemote(message) {
    const wasRemote = remote;
    remote = typeof message.name === 'string' && message.name ? {name:message.name,device:typeof message.device === 'string' ? message.device : 'Device'} : null;
    rejectPending();
    updateTabs();
    if (!wasRemote && remote && root) { showSplit(); return; }
    if ((source === 'remote' || source === 'split') && !remote) showShared();
    else if (source === 'remote') showExplorer('remote');
    if (!wasRemote && remote) {
      const tabs = $('folder-tabs'); tabs.classList.remove('attention'); void tabs.offsetWidth; tabs.classList.add('attention');
      if (!source) showExplorer('remote');
    }
  }
  function showShared() {
    for (const which of ['local','remote']) clearSplitThumbnails(which);
    source = null; remoteGeneration++; activeRequest++; resetSelection(); clearThumbnails();
    $('folder-loading').hidden = true; $('workspace').classList.remove('browsing-folder'); $('dropzone').hidden = false; $('folder-explorer').hidden = true; $('split-explorer').hidden = true; $('split-instruction').hidden = true;
    for (const id of ['shared-tab','local-browse-tab','browse-tab','split-tab']) { const selected = id === 'shared-tab'; $(id).classList.toggle('selected', selected); $(id).setAttribute('aria-pressed', String(selected)); }
  }
  function sizeExplorer() {
    if ($('folder-explorer').hidden || !window.matchMedia('(max-width: 500px)').matches) return;
    const topSpace = $('folder-explorer').getBoundingClientRect().top - $('workspace').getBoundingClientRect().top;
    $('workspace').style.setProperty('--explorer-top-space', `${Math.ceil(topSpace + 16)}px`);
  }
  function showExplorer(which) {
    if (!(which === 'local' ? root : remote)) return;
    for (const side of ['local','remote']) clearSplitThumbnails(side);
    source = which; remoteGeneration++; activeRequest++; resetSelection(); clearThumbnails();
    currentPath = []; entries = []; $('folder-content').replaceChildren(); $('folder-search').value = ''; $('folder-search-row').hidden = true; $('folder-search-toggle').setAttribute('aria-expanded','false');
    $('workspace').classList.add('browsing-folder'); $('dropzone').hidden = true; $('folder-explorer').hidden = false; $('split-explorer').hidden = true; $('split-instruction').hidden = true;
    for (const id of ['shared-tab','local-browse-tab','browse-tab','split-tab']) { const selected = id === (which === 'local' ? 'local-browse-tab' : 'browse-tab'); $(id).classList.toggle('selected', selected); $(id).setAttribute('aria-pressed', String(selected)); }
    requestAnimationFrame(sizeExplorer); void load();
  }
  window.addEventListener('resize', () => requestAnimationFrame(sizeExplorer));
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(() => requestAnimationFrame(sizeExplorer));
    observer.observe($('folder-tabs'));
    observer.observe($('workspace').querySelector('.workspace-heading'));
  }
  $('shared-tab').onclick = showShared; $('local-browse-tab').onclick = () => showExplorer('local'); $('browse-tab').onclick = () => showExplorer('remote'); $('split-tab').onclick = showSplit;
  const splitPaths = {local:[], remote:[]}, splitTokens = {local:0, remote:0};
  const splitSelections = {local:new Map(), remote:new Map()};
  const splitView = {local:'list', remote:'list'}, splitSelectMode = {local:false, remote:false}, splitQuery = {local:'', remote:''}, splitSearchOpen = {local:false, remote:false};
  const splitSort = {local:{key:'name',direction:1}, remote:{key:'name',direction:1}};
  const splitSearchTimer = {local:null, remote:null}, splitAnchors = {local:null, remote:null}, splitThumbnailURLs = {local:[], remote:[]};
  const splitThumbnailObservers = {local:null, remote:null};
  let splitThumbnailQueue = [], splitThumbnailActive = 0;
  function clearSplitThumbnails(which) {
    splitThumbnailObservers[which]?.disconnect(); splitThumbnailObservers[which] = null;
    splitThumbnailQueue = splitThumbnailQueue.filter(task => task.which !== which);
    for (const url of splitThumbnailURLs[which]) URL.revokeObjectURL(url); splitThumbnailURLs[which] = [];
  }
  function runSplitThumbnailQueue() {
    while (splitThumbnailActive < 3 && splitThumbnailQueue.length) {
      const {which,token,item,thumb} = splitThumbnailQueue.shift();
      if (source !== 'split' || token !== splitTokens[which] || !thumb.isConnected) continue;
      splitThumbnailActive++;
      request('thumbnail',item.path,undefined,which).then(file => {
        if (source !== 'split' || token !== splitTokens[which] || !thumb.isConnected) return;
        const url = URL.createObjectURL(file), image = document.createElement('img'); splitThumbnailURLs[which].push(url); image.alt = '';
        image.onload = () => { if (source === 'split' && token === splitTokens[which] && thumb.isConnected) thumb.replaceChildren(image); }; image.src = url;
      }).catch(() => {}).finally(() => { splitThumbnailActive--; runSplitThumbnailQueue(); });
    }
  }
  function updateSplitFades(which) {
    const pane = $(`split-${which}`), list = pane.querySelector('.split-list'), area = pane.querySelector('.split-content-area');
    if (!list || !area) return;
    area.classList.toggle('fade-top', list.scrollTop > 1);
    area.classList.toggle('fade-bottom', list.scrollTop + list.clientHeight < list.scrollHeight - 1);
  }
  function updateSplitBreadcrumb(which) {
    const pane = $(`split-${which}`), breadcrumb = pane.querySelector('.split-crumbs .breadcrumb'), button = pane.querySelector('.split-crumbs .breadcrumb-expand');
    if (!breadcrumb || !button) return;
    button.hidden = true;
    if (!breadcrumb.classList.contains('expanded') && breadcrumb.clientWidth > 0 && breadcrumb.scrollWidth > breadcrumb.clientWidth + 1) button.hidden = false;
  }
  window.addEventListener('resize', () => { for (const which of ['local','remote']) requestAnimationFrame(() => { updateSplitFades(which); updateSplitBreadcrumb(which); }); });
  if (window.ResizeObserver) { const observer = new ResizeObserver(() => { for (const which of ['local','remote']) { updateSplitFades(which); updateSplitBreadcrumb(which); } }); for (const which of ['local','remote']) observer.observe($(`split-${which}`)); }
  let hoveredSplit = null;
  let draggedFiles = null;
  function showSplit() {
    if (!root || !remote) return;
    source = 'split'; remoteGeneration++; activeRequest++; resetSelection(); clearThumbnails();
    $('workspace').classList.add('browsing-folder'); $('dropzone').hidden = true; $('folder-explorer').hidden = true; $('split-explorer').hidden = false;
    $('split-instruction').textContent = `Drag and drop files and folders between this device and ${remote.device}.`; $('split-instruction').hidden = false;
    for (const id of ['shared-tab','local-browse-tab','browse-tab','split-tab']) { const selected = id === 'split-tab'; $(id).classList.toggle('selected',selected); $(id).setAttribute('aria-pressed',String(selected)); }
    splitPaths.local = []; splitPaths.remote = []; splitQuery.local = ''; splitQuery.remote = ''; splitSearchOpen.local = false; splitSearchOpen.remote = false; void loadSplit('local'); void loadSplit('remote');
  }
  async function loadSplit(which, preserveSelection = false, quiet = false) {
    if (source !== 'split') return;
    const pane = $(`split-${which}`), path = [...splitPaths[which]], token = ++splitTokens[which];
    const query = splitQuery[which].trim();
    let prefetched;
    if (quiet) {
      try { prefetched = await request(query ? 'search' : 'list',path,query,which); }
      catch (error) { const message = pane.querySelector('.split-status'); if (message && token === splitTokens[which]) message.textContent = error.message; return; }
      if (source !== 'split' || token !== splitTokens[which]) return;
    }
    clearSplitThumbnails(which);
    pane.replaceChildren(); if (!preserveSelection) { splitSelections[which].clear(); splitSelectMode[which] = false; splitAnchors[which] = null; }
    const title = document.createElement('strong'); title.textContent = which === 'local' ? 'This device' : remote.device;
    const toolbar = document.createElement('div'); toolbar.className = 'explorer-toolbar split-toolbar';
    const crumbs = document.createElement('div'); crumbs.className = 'split-crumbs breadcrumb-wrap';
    const breadcrumb = document.createElement('nav'); breadcrumb.className = 'breadcrumb'; breadcrumb.setAttribute('aria-label','Folder path'); breadcrumb.classList.toggle('single-subfolder',path.length === 1);
    [(which === 'local' ? root : remote).name, ...path].forEach((name,index) => {
      const segment = document.createElement('span'); segment.className = 'breadcrumb-segment';
      if (index) { const chevron = document.createElement('i'); chevron.className = 'fa-solid fa-chevron-right'; chevron.setAttribute('aria-hidden','true'); segment.append(chevron); }
      const button = document.createElement('button'); button.type = 'button'; button.textContent = name;
      if (index === path.length) button.setAttribute('aria-current','page');
      button.onclick = () => { splitPaths[which] = path.slice(0,index); splitQuery[which] = ''; void loadSplit(which); }; segment.append(button); breadcrumb.append(segment);
    });
    const expand = document.createElement('button'); expand.type = 'button'; expand.className = 'breadcrumb-expand'; expand.textContent = '…'; expand.setAttribute('aria-label','Show full path'); expand.hidden = true;
    expand.onclick = () => { breadcrumb.classList.add('expanded'); updateSplitBreadcrumb(which); };
    crumbs.addEventListener('click',event => {
      if (event.target.closest('button, input') || breadcrumb.dataset.dragged || breadcrumb.querySelector('input')) return;
      const rootName = (which === 'local' ? root : remote)?.name; if (!rootName) return;
      const fullPath = [rootName,...path].join('/');
      const shellPath = /^[A-Za-z0-9_./-]+$/.test(fullPath) ? fullPath : `'${fullPath.replace(/'/g, "'\\''")}'`;
      const original = [...breadcrumb.childNodes], input = document.createElement('input');
      input.type = 'text'; input.className = 'breadcrumb-text'; input.value = shellPath; input.setAttribute('aria-label','Folder path. Press Enter to navigate.');
      breadcrumb.replaceChildren(input); expand.hidden = true;
      const showError = () => {
        const area = pane.querySelector('.split-content-area'); if (!area) return;
        area.querySelector('.folder-path-error')?.remove();
        const overlay = document.createElement('div'); overlay.className = 'folder-path-error'; overlay.setAttribute('role','status'); overlay.textContent = 'Path not found. Check spelling.'; area.append(overlay);
        setTimeout(() => { overlay.classList.add('fading'); setTimeout(() => overlay.remove(),350); },1500);
      };
      input.addEventListener('blur',() => { if (breadcrumb.contains(input)) { breadcrumb.replaceChildren(...original); updateSplitBreadcrumb(which); } },{once:true});
      let checking = false;
      input.addEventListener('keydown',async event => {
        if (event.key === 'Escape') { event.preventDefault(); input.blur(); return; }
        if (event.key !== 'Enter' || event.isComposing || checking) return;
        event.preventDefault(); let entered = input.value.trim();
        if (entered.startsWith("'")) {
          if (!entered.endsWith("'") || entered.length < 2) { showError(); return; }
          const pieces = entered.slice(1,-1).split("'\\''");
          if (pieces.some(piece => piece.includes("'"))) { showError(); return; }
          entered = pieces.join("'");
        }
        entered = entered.replace(/^\.\//,'').replace(/\/$/,'');
        const parts = entered.split('/');
        if (parts.shift() !== rootName || !safePath(parts)) { showError(); return; }
        checking = true;
        try {
          await request('list',parts,undefined,which);
          if (!breadcrumb.contains(input) || source !== 'split') return;
          splitPaths[which] = parts; splitQuery[which] = ''; await loadSplit(which);
        } catch (error) {
          if (!input.isConnected) return;
          input.focus();
          if (error.name === 'NotFoundError' || /(?:not found|could not be found|does not exist|no such file or directory)/i.test(error.message || '')) showError();
          else { const message = pane.querySelector('.split-status'); if (message) message.textContent = error.message; }
        } finally { checking = false; }
      });
      input.focus(); input.select();
    });
    enableBreadcrumbDrag(breadcrumb);
    crumbs.append(expand,breadcrumb); requestAnimationFrame(() => { updateSplitBreadcrumb(which); breadcrumb.scrollLeft = breadcrumb.scrollWidth; });
    const actions = document.createElement('div'); actions.className = 'explorer-actions';
    const selectButton = document.createElement('button'); selectButton.type = 'button'; selectButton.className = 'folder-select split-select'; selectButton.textContent = 'Select'; selectButton.setAttribute('aria-pressed',String(splitSelectMode[which]));
    selectButton.onclick = () => { splitSelectMode[which] = !splitSelectMode[which]; selectButton.setAttribute('aria-pressed',String(splitSelectMode[which])); if (!splitSelectMode[which]) { splitSelections[which].clear(); splitAnchors[which] = null; pane.querySelectorAll('.split-item').forEach(row => { row.classList.remove('selected'); }); } };
    const searchButton = document.createElement('button'); searchButton.type = 'button'; searchButton.className = 'explorer-icon'; searchButton.title = 'Search folder'; searchButton.setAttribute('aria-label','Search folder'); searchButton.setAttribute('aria-expanded',String(splitSearchOpen[which])); searchButton.innerHTML = '<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>';
    const views = document.createElement('div'); views.className = 'view-toggle'; views.setAttribute('aria-label','Display type');
    for (const [name,icon] of [['cards','fa-grip'],['list','fa-list']]) { const button = document.createElement('button'); button.type = 'button'; button.title = name === 'cards' ? 'Card view' : 'List view'; button.setAttribute('aria-label',button.title); button.setAttribute('aria-pressed',String(splitView[which] === name)); button.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>`; button.onclick = () => { splitView[which] = name; void loadSplit(which,true); }; views.append(button); }
    const newFolder = document.createElement('button'); newFolder.type = 'button'; newFolder.className = 'explorer-icon'; newFolder.title = 'New folder'; newFolder.setAttribute('aria-label','New folder'); newFolder.innerHTML = '<i class="fa-solid fa-folder-plus" aria-hidden="true"></i>';
    newFolder.onclick = () => startNewFolder(which, pane, path);
    actions.append(selectButton,searchButton,newFolder,views); toolbar.append(crumbs,actions);
    const searchRow = document.createElement('div'); searchRow.className = 'folder-search-row'; searchRow.hidden = !splitSearchOpen[which];
    const searchIcon = document.createElement('i'); searchIcon.className = 'fa-solid fa-magnifying-glass'; searchIcon.setAttribute('aria-hidden','true');
    const searchInput = document.createElement('input'); searchInput.type = 'search'; searchInput.placeholder = 'Search this folder and subfolders'; searchInput.setAttribute('aria-label','Search this folder and subfolders'); searchInput.value = splitQuery[which];
    const clear = document.createElement('button'); clear.type = 'button'; clear.setAttribute('aria-label','Clear search'); clear.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
    searchInput.oninput = () => { clearTimeout(splitSearchTimer[which]); splitQuery[which] = searchInput.value; splitSearchTimer[which] = setTimeout(async () => { await loadSplit(which,true); const input = $(`split-${which}`).querySelector('.folder-search-row input'); if (input && !input.closest('.folder-search-row').hidden) { input.focus(); input.setSelectionRange(input.value.length,input.value.length); } },300); };
    clear.onclick = () => { splitQuery[which] = ''; void loadSplit(which,true); };
    searchButton.onclick = () => { splitSearchOpen[which] = !splitSearchOpen[which]; if (!splitSearchOpen[which]) splitQuery[which] = ''; void loadSplit(which,true); };
    searchRow.append(searchIcon,searchInput,clear);
    const contentArea = document.createElement('div'); contentArea.className = 'split-content-area';
    const list = document.createElement('div'); list.className = 'split-list';
    list.addEventListener('scroll', () => updateSplitFades(which), {passive:true});
    const count = document.createElement('span'); count.className = 'split-item-count'; count.hidden = true;
    const loading = document.createElement('div'); loading.className = 'folder-loading'; loading.classList.toggle('is-searching',!!splitQuery[which].trim()); loading.setAttribute('role','status'); loading.setAttribute('aria-live','polite');
    const loadingText = document.createElement('span'); loadingText.textContent = splitQuery[which].trim() ? 'Searching folders…' : 'Loading folder…'; loading.append(loadingText); contentArea.append(list,count,loading); list.setAttribute('aria-busy','true');
    const message = document.createElement('p'); message.className = 'split-status';
    const hint = document.createElement('p'); hint.className = 'split-hint'; hint.textContent = 'Select multiple files and folders to drag and transfer together. Ctrl+A to select all.';
    pane.append(title,toolbar,searchRow,contentArea,message,hint);
    try {
      const items = quiet ? prefetched : await request(query ? 'search' : 'list',path,query,which);
      if (source !== 'split' || token !== splitTokens[which]) return;
      message.textContent = '';
      count.textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}${query ? ' found' : ''}`; count.hidden = false;
      if (!items.length) { const empty = document.createElement('p'); empty.className = 'split-empty'; empty.textContent = query ? 'No matching files found.' : 'This folder is empty.'; list.append(empty); }
      const checked = splitSelections[which];
      if (splitView[which] === 'cards' && window.IntersectionObserver) {
        const observer = new IntersectionObserver(records => {
          if (source !== 'split' || token !== splitTokens[which]) return;
          for (const record of records) if (record.isIntersecting) { observer.unobserve(record.target); splitThumbnailQueue.push({which,token,item:record.target._thumbnailItem,thumb:record.target}); }
          runSplitThumbnailQueue();
        },{root:list});
        splitThumbnailObservers[which] = observer;
      }
      const renderGroup = (groupItems, container) => {
      let listBody = container;
      if (splitView[which] === 'cards') { listBody = document.createElement('div'); listBody.className = 'split-card-grid'; container.append(listBody); }
      if (splitView[which] === 'list') {
        const table = document.createElement('table'); table.className = 'folder-table split-table';
        const head = table.createTHead().insertRow(), order = splitSort[which];
        for (const [title,key] of [['Name','name'],['Size','size'],['Type','type'],['Date modified','modified']]) {
          const th = document.createElement('th'), button = document.createElement('button'); button.type = 'button';
          button.textContent = `${title}${order.key === key ? (order.direction === 1 ? ' ↑' : ' ↓') : ''}`;
          th.setAttribute('aria-sort',order.key === key ? (order.direction === 1 ? 'ascending' : 'descending') : 'none');
          button.onclick = () => { order.direction = order.key === key ? -order.direction : 1; order.key = key; void loadSplit(which,true); };
          th.append(button); head.append(th);
        }
        listBody = table.createTBody(); container.append(table);
      }
      for (const item of sorted(groupItems,splitSort[which].key,splitSort[which].direction)) {
        const row = document.createElement(splitView[which] === 'cards' ? 'div' : 'tr'); row.className = `split-item${splitView[which] === 'cards' ? ' folder-card' : ''}`;
        const icon = document.createElement('i'); icon.className = fileIcon(item); icon.setAttribute('aria-hidden','true');
        const label = document.createElement('button'); label.textContent = item.name; label.title = item.name;
        row.classList.toggle('selected',checked.has(selectionKey(item)));
        row.addEventListener('click',event => {
          if (!splitSelectMode[which] || event.target.closest('input')) return;
          event.preventDefault(); event.stopPropagation();
          const key = selectionKey(item), rows = [...list.querySelectorAll('.split-item')], anchor = rows.findIndex(element => selectionKey(element._folderItem) === splitAnchors[which]), index = rows.indexOf(row);
          if (event.shiftKey && checked.size && anchor >= 0) { for (const element of rows.slice(Math.min(anchor,index),Math.max(anchor,index)+1)) checked.set(selectionKey(element._folderItem),element._folderItem); }
          else { if (checked.has(key)) checked.delete(key); else checked.set(key,item); splitAnchors[which] = checked.has(key) ? key : null; }
          for (const element of rows) element.classList.toggle('selected',checked.has(selectionKey(element._folderItem)));
        },true);
        row.draggable = true; row._folderItem = item;
        row.addEventListener('contextmenu',event => showRenameMenu(event,item,which,label,() => loadSplit(which),text => { message.textContent = text; }));
        if (item.kind === 'directory') label.onclick = () => { splitPaths[which] = item.path; splitQuery[which] = ''; void loadSplit(which); };
        else label.onclick = () => openPreview(item.name, () => request('file',item.path,undefined,which));
        row.addEventListener('dragstart',event => { draggedFiles = {which, items:checked.has(selectionKey(item)) ? [...checked.values()] : [item]}; event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('text/plain',item.name); });
        row.addEventListener('dragend',() => { draggedFiles = null; document.querySelectorAll('.split-pane').forEach(p => p.classList.remove('drop-target')); });
        if (splitView[which] === 'cards') {
          row.addEventListener('click',event => { if (!splitSelectMode[which] && !event.target.closest('button, input')) label.click(); });
          const thumb = document.createElement('button'); thumb.type = 'button'; thumb.className = 'folder-thumb'; thumb.setAttribute('aria-label',`${item.kind === 'directory' ? 'Open' : 'Preview'} ${item.name}`); thumb.append(icon); thumb.onclick = () => label.click();
          label.className = 'folder-item-name';
          const meta = document.createElement('div'); meta.className = 'folder-item-meta'; meta.textContent = item.kind === 'directory' ? 'Folder' : size(item.size);
          row.append(thumb,label,meta,splitActionButtons(item,which,message));
          if (isImage(item) && splitThumbnailObservers[which]) { thumb._thumbnailItem = item; splitThumbnailObservers[which].observe(thumb); }
        } else { const name = row.insertCell(); label.className = 'folder-item-name'; name.append(icon,label); row.insertCell().textContent = item.kind === 'file' ? size(item.size) : '—'; row.insertCell().textContent = fileType(item); row.insertCell().textContent = item.modified ? new Date(item.modified).toLocaleDateString() : '—'; }
        listBody.append(row);
      }
      };
      if (!query) renderGroup(items,list);
      else {
        const groups = new Map();
        for (const item of items) { const relative = item.path.slice(path.length,-1), key = JSON.stringify(relative); if (!groups.has(key)) groups.set(key,{path:relative,items:[]}); groups.get(key).items.push(item); }
        for (const group of groups.values()) {
          const section = document.createElement('section'); section.className = 'search-group';
          const link = document.createElement('button'); link.type = 'button'; link.className = 'search-path';
          const icon = document.createElement('i'); icon.className = 'fa-regular fa-folder-open'; icon.setAttribute('aria-hidden','true');
          link.append(icon,document.createTextNode(group.path.length ? group.path.join(' › ') : 'Current folder'));
          link.onclick = () => { splitPaths[which] = [...path,...group.path]; splitQuery[which] = ''; void loadSplit(which); };
          section.append(link); renderGroup(group.items,section); list.append(section);
        }
      }
      requestAnimationFrame(() => updateSplitFades(which));
    } catch (error) { if (source === 'split' && token === splitTokens[which]) message.textContent = error.message; }
    finally { if (token === splitTokens[which]) { loading.hidden = true; list.removeAttribute('aria-busy'); } }
  }
  function refreshLocalView() {
    if (source === 'split') void loadSplit('local',true,true);
    else if (source === 'local') void load();
  }
  function requestMutation(operation, path, name, kind) {
    const id = crypto.randomUUID();
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The other device did not respond.')); },120000);
      pending.set(id,{resolve,reject,timer});
      Promise.resolve(sendMessage({type:'folder-request',id,operation,path,name,kind})).catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
    });
  }
  async function renameLocal(path, kind, name, base) {
    if (!base || root !== base || !isConnected() || !safePath(path) || !path.length || !safePath([name])) throw new Error('Invalid name or folder unavailable.');
    if (path.at(-1) === name) return;
    const parent = await directory(path.slice(0,-1),base), oldName = path.at(-1);
    for (const getter of ['getFileHandle','getDirectoryHandle']) {
      try { await parent[getter](name); throw new Error('An item with that name already exists.'); }
      catch (error) { if (error.name === 'TypeMismatchError') throw new Error('An item with that name already exists.'); if (error.name !== 'NotFoundError') throw error; }
    }
    const handle = kind === 'directory' ? await parent.getDirectoryHandle(oldName) : await parent.getFileHandle(oldName);
    if (typeof handle.move === 'function') {
      try { await handle.move(name); return; }
      catch (error) { if (error.name !== 'NotSupportedError') throw error; }
    }
    async function copyEntry(original, destParent, newName) {
      if (root !== base || !isConnected()) throw new Error('Folder connection changed; the original was kept.');
      if (original.kind === 'file') {
        const file = await original.getFile(), target = await destParent.getFileHandle(newName,{create:true}), stream = await target.createWritable();
        try { await stream.write(file); await stream.close(); } catch (error) { await stream.abort().catch(() => {}); throw error; }
        return {kind:'file',name:original.name,size:file.size,modified:file.lastModified};
      }
      const target = await destParent.getDirectoryHandle(newName,{create:true}), children = [];
      for await (const child of original.values()) children.push(await copyEntry(child,target,child.name));
      return {kind:'directory',name:original.name,children};
    }
    async function verify(original, snapshot) {
      if (original.kind === 'file') { const file = await original.getFile(); return file.size === snapshot.size && file.lastModified === snapshot.modified; }
      const children = []; for await (const child of original.values()) children.push(child);
      if (children.length !== snapshot.children.length) return false;
      for (const child of children) { const saved = snapshot.children.find(entry => entry.name === child.name && entry.kind === child.kind); if (!saved || !(await verify(child,saved))) return false; }
      return true;
    }
    const snapshot = await copyEntry(handle,parent,name);
    if (root !== base || !isConnected() || !(await verify(handle,snapshot))) throw new Error('The original changed during rename and was kept alongside the copy.');
    await parent.removeEntry(oldName,{recursive:kind === 'directory'});
  }
  function editName(label, initial, submit, report) {
    const row = label.closest('.folder-table tbody tr'), rowHeight = row?.getBoundingClientRect().height;
    const input = document.createElement('input'); input.type = 'text'; input.className = 'folder-name-input'; input.value = initial; input.setAttribute('aria-label','Name');
    if (rowHeight) input.style.height = `${Math.max(0,rowHeight - 9)}px`;
    label.replaceWith(input); input.focus(); input.select(); let busy = false;
    input.addEventListener('click',event => event.stopPropagation());
    input.addEventListener('keydown',async event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); input.replaceWith(label); return; }
      if (event.key !== 'Enter' || event.isComposing || busy) return;
      event.preventDefault(); const name = input.value;
      if (!safePath([name])) { report('Enter a valid file or folder name.'); return; }
      busy = true; input.disabled = true;
      try { await submit(name); } catch (error) { report(error.message || 'Could not update the name.'); if (input.isConnected) { input.disabled = false; input.focus(); input.select(); } }
      finally { busy = false; }
    });
    input.addEventListener('blur',() => { if (!busy && input.isConnected) input.replaceWith(label); });
  }
  function showRenameMenu(event, item, which, label, refresh, report) {
    event.preventDefault(); event.stopPropagation(); if (!label || label.hidden) return;
    document.querySelector('.folder-context-menu')?.remove();
    const menu = document.createElement('div'); menu.className = 'folder-context-menu'; menu.setAttribute('role','menu');
    const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role','menuitem'); button.innerHTML = '<i class="fa-solid fa-pen" aria-hidden="true"></i> Rename'; menu.append(button); document.body.append(menu);
    menu.style.left = `${Math.max(8,Math.min(event.clientX,window.innerWidth-menu.offsetWidth-8))}px`; menu.style.top = `${Math.max(8,Math.min(event.clientY,window.innerHeight-menu.offsetHeight-8))}px`;
    const close = () => { menu.remove(); document.removeEventListener('pointerdown',dismiss); };
    button.onclick = () => { close(); editName(label,item.name,async name => { if (which === 'local') await renameLocal(item.path,item.kind,name,root); else await requestMutation('rename',item.path,name,item.kind); await refresh(); },report); };
    const dismiss = event => { if (!menu.contains(event.target)) { close(); document.removeEventListener('pointerdown',dismiss); } };
    setTimeout(() => { if (menu.isConnected) document.addEventListener('pointerdown',dismiss); },0);
    menu.addEventListener('keydown',e => { if (e.key === 'Escape') close(); }); button.focus();
  }
  function startNewFolder(which, pane, path, split = true) {
    if (pane.querySelector('.new-folder-entry')) return;
    const row = document.createElement('div'); row.className = 'new-folder-entry';
    const icon = document.createElement('i'); icon.className = 'fa-solid fa-folder'; icon.setAttribute('aria-hidden','true');
    const placeholder = document.createElement('span'); placeholder.textContent = 'New folder'; row.append(icon,placeholder); pane.insertBefore(row,pane.querySelector(split ? '.split-content-area' : '#folder-content-area'));
    const report = text => { const message = pane.querySelector(split ? '.split-status' : '#folder-status'); if (message) message.textContent = text; };
    editName(placeholder,'New folder',async name => { if (which === 'local') await makeDirectoryCopy(path,name,root); else await requestMutation('mkdir',path,name); if (split) await loadSplit(which); else await load(); },report);
    row.addEventListener('focusout',() => setTimeout(() => { if (!row.querySelector('input')) row.remove(); },0));
    row.addEventListener('keydown',event => { if (event.key === 'Escape') setTimeout(() => row.remove(),0); });
  }
  async function makeDirectoryCopy(path, requestedName, base) {
    if (!base || root !== base || !isConnected() || !safePath(path) || !safePath([requestedName])) throw new Error('The destination folder is unavailable.');
    const parent = await directory(path, base);
    let name = requestedName, number = 1;
    while (true) {
      try { await parent.getDirectoryHandle(name); }
      catch (error) {
        if (error.name === 'TypeMismatchError') { name = `${requestedName} (${number++})`; continue; }
        if (error.name !== 'NotFoundError') throw error;
        try { await parent.getFileHandle(name); name = `${requestedName} (${number++})`; continue; }
        catch (fileError) { if (fileError.name === 'NotFoundError') break; throw fileError; }
      }
      name = `${requestedName} (${number++})`;
    }
    if (root !== base || !isConnected()) throw new Error('The destination folder is unavailable.');
    await parent.getDirectoryHandle(name,{create:true}); return name;
  }
  function requestDirectory(path, name) {
    const id = crypto.randomUUID();
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The other device did not confirm the folder creation.')); },60000);
      pending.set(id,{resolve,reject,timer});
      Promise.resolve(sendMessage({type:'folder-request',id,operation:'mkdir',path,name})).catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
    });
  }
  async function planSplitItem(item, from, generation, checkCancel) {
    checkCancel();
    if (generation !== remoteGeneration || source !== 'split' || !isConnected()) throw new Error('The folder connection changed.');
    if (item.kind !== 'directory') return {...item, weight:Math.max(1,item.size || 0)};
    const children = await request('list',item.path,undefined,from), planned = [];
    for (const child of children) planned.push(await planSplitItem(child,from,generation,checkCancel));
    checkCancel();
    return {...item,children:planned,weight:planned.reduce((total,child) => total + child.weight,0) || 1};
  }
  async function copySplitItem(item, from, to, destination, generation, base, progress, checkCancel) {
    checkCancel();
    if (generation !== remoteGeneration || source !== 'split' || !isConnected()) throw new Error('The folder connection changed.');
    if (item.kind === 'directory') {
      const name = to === 'local' ? await makeDirectoryCopy(destination,item.name,base) : (await requestDirectory(destination,item.name))[0];
      for (const child of item.children) await copySplitItem(child,from,to,[...destination,name],generation,base,progress,checkCancel);
      checkCancel();
      if (!item.children.length) progress.complete(item.weight);
      return name;
    }
    const update = fraction => progress.update(item.weight,fraction);
    if (item.size >= STREAM_THRESHOLD) { const name = await copyLargeFile(item,from,to,destination,generation,base,update,checkCancel); progress.complete(item.weight); return name; }
    const file = await request('file',item.path,undefined,from,from === 'remote' ? update : undefined);
    checkCancel(); if (generation !== remoteGeneration || source !== 'split' || !isConnected()) throw new Error('The folder connection changed.');
    const name = to === 'local' ? await saveCopy(file,destination,base) : (await sendCopy(file,destination,update))[0];
    progress.complete(item.weight); return name;
  }
  async function openCopyWriter(filename, path, base) {
    if (!base || root !== base || !isConnected() || !safePath(path) || !safePath([filename])) throw new Error('The destination folder is unavailable.');
    const dir = await directory(path,base), dot = filename.lastIndexOf('.'), stem = dot > 0 ? filename.slice(0,dot) : filename, ext = dot > 0 ? filename.slice(dot) : '';
    let name = filename, number = 1;
    while (true) {
      try { await dir.getFileHandle(name); name = `${stem} (${number++})${ext}`; }
      catch (error) { if (error.name === 'TypeMismatchError') { name = `${stem} (${number++})${ext}`; continue; } if (error.name === 'NotFoundError') break; throw error; }
    }
    if (root !== base || !isConnected()) throw new Error('The destination folder is unavailable.');
    const handle = await dir.getFileHandle(name,{create:true}), writable = await handle.createWritable();
    return {name,writable};
  }
  function armStreamTimeout(id,state) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { if (incomingStreams.get(id) === state) { incomingStreams.delete(id); void state.writable.abort().catch(() => {}); } },120000);
  }
  function abortIncomingStreams() {
    for (const [id,state] of incomingStreams) { incomingStreams.delete(id); clearTimeout(state.timer); void state.writable.abort().catch(() => {}); }
  }
  function streamControl(operation, path, query) {
    const id = crypto.randomUUID();
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The other device did not respond.')); },120000);
      pending.set(id,{resolve,reject,timer});
      Promise.resolve(sendMessage({type:'folder-request',id,operation,path,query})).catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
    });
  }
  async function sendStreamChunk(streamId, offset, data, onProgress) {
    const id = crypto.randomUUID(), target = getPeer();
    const result = new Promise((resolve,reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error('The other device did not confirm the chunk.')); },120000); pending.set(id,{resolve,reject,timer}); });
    try { await sendBytes(data,target,{streamId,chunkId:id,offset},onProgress); }
    catch (error) { const pendingItem = pending.get(id); if (pendingItem) { pending.delete(id); clearTimeout(pendingItem.timer); pendingItem.reject(error); } }
    return result;
  }
  async function receiveStreamChunk(data, meta, from) {
    const state = incomingStreams.get(meta.streamId);
    if (!state || from !== getPeer() || state.from !== from || state.base !== root || typeof meta.chunkId !== 'string' || state.writing || meta.offset !== state.offset || !data.byteLength || data.byteLength > CHUNK_SIZE || state.offset + data.byteLength > state.size) {
      if (isConnected() && from === getPeer() && typeof meta.chunkId === 'string') sendMessage({type:'folder-response',id:meta.chunkId,error:'Invalid or expired transfer chunk.'});
      return;
    }
    state.writing = true; clearTimeout(state.timer);
    try {
      await state.writable.write(data);
      if (incomingStreams.get(meta.streamId) !== state || root !== state.base || !isConnected() || from !== getPeer()) throw new Error('The destination folder is unavailable.');
      state.offset += data.byteLength; state.writing = false; armStreamTimeout(meta.streamId,state);
      sendMessage({type:'folder-response',id:meta.chunkId,entries:[]});
    } catch (error) {
      incomingStreams.delete(meta.streamId); clearTimeout(state.timer); await state.writable.abort().catch(() => {});
      if (isConnected() && from === getPeer()) sendMessage({type:'folder-response',id:meta.chunkId,error:error.message || 'Could not write the file.'});
    }
  }
  async function copyLargeFile(item, from, to, destination, generation, base, update, checkCancel) {
    let localOutput, remoteId, localFile;
    const check = () => { checkCancel(); if (generation !== remoteGeneration || source !== 'split' || !isConnected() || root !== base) throw new Error('The folder connection changed.'); };
    try {
      check();
      if (from === 'local') {
        const dir = await directory(item.path.slice(0,-1),base); localFile = await (await dir.getFileHandle(item.name)).getFile();
        if (localFile.size !== item.size || localFile.lastModified !== item.modified) throw new Error('The source file changed during transfer.');
        [remoteId] = await streamControl('stream-start',destination,{name:item.name,size:item.size});
      } else localOutput = await openCopyWriter(item.name,destination,base);
      for (let offset = 0; offset < item.size; offset += CHUNK_SIZE) {
        check(); const length = Math.min(CHUNK_SIZE,item.size-offset);
        const chunkProgress = fraction => update((offset + length * Math.max(0,Math.min(1,fraction))) / item.size);
        if (from === 'local') {
          const data = await localFile.slice(offset,offset+length).arrayBuffer(); check();
          await sendStreamChunk(remoteId,offset,data,chunkProgress);
        } else {
          const chunk = await request('read-chunk',item.path,{offset,size:item.size,modified:item.modified},'remote',chunkProgress); check();
          if (chunk.size !== length) throw new Error('Received an incomplete file chunk.');
          await localOutput.writable.write(chunk);
        }
        update((offset+length)/item.size);
      }
      check();
      if (to === 'local') { await localOutput.writable.close(); return localOutput.name; }
      const [name] = await streamControl('stream-finish',destination,{streamId:remoteId}); remoteId = null; return name;
    } catch (error) {
      if (localOutput) await localOutput.writable.abort().catch(() => {});
      if (remoteId && isConnected()) void streamControl('stream-cancel',destination,{streamId:remoteId}).catch(() => {});
      throw error;
    }
  }
  async function saveCopy(file, path, base) {
    if (!base || root !== base || !isConnected()) throw new Error('The destination folder is unavailable.');
    const dir = await directory(path, base);
    const dot = file.name.lastIndexOf('.'), stem = dot > 0 ? file.name.slice(0,dot) : file.name, ext = dot > 0 ? file.name.slice(dot) : '';
    let name = file.name, number = 1;
    while (true) {
      try { await dir.getFileHandle(name); name = `${stem} (${number++})${ext}`; }
      catch (error) { if (error.name === 'TypeMismatchError') { name = `${stem} (${number++})${ext}`; continue; } if (error.name === 'NotFoundError') break; throw error; }
    }
    if (root !== base || !isConnected()) throw new Error('The destination folder is unavailable.');
    const handle = await dir.getFileHandle(name,{create:true}), writable = await handle.createWritable();
    try { await writable.write(file); await writable.close(); } catch (error) { await writable.abort().catch(() => {}); throw error; }
    return name;
  }
  async function sendCopy(file, path, onProgress) {
    const id = crypto.randomUUID(), target = getPeer();
    const result = new Promise((resolve,reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The other device did not confirm the save.')); },120000);
      pending.set(id,{resolve,reject,timer});
    });
    try { await sendBytes(await file.arrayBuffer(),target,{writeId:id,path,name:file.name,type:file.type},onProgress); }
    catch (error) { const item = pending.get(id); if (item) { clearTimeout(item.timer); pending.delete(id); item.reject(error); } }
    return result;
  }
  async function receiveCopy(data, meta, from) {
    if (!root || from !== getPeer() || typeof meta.writeId !== 'string' || !safePath(meta.path) || typeof meta.name !== 'string' || !safePath([meta.name])) return;
    const base = root;
    try {
      const name = await saveCopy(new File([data],meta.name,{type:typeof meta.type === 'string' ? meta.type : ''}),meta.path,base);
      if (isConnected() && from === getPeer()) sendMessage({type:'folder-response',id:meta.writeId,entries:[name]});
      refreshLocalView();
    } catch (error) { if (isConnected() && from === getPeer()) sendMessage({type:'folder-response',id:meta.writeId,error:error.message || 'Could not save the file.'}); }
  }
  for (const which of ['local','remote']) {
    const pane = $(`split-${which}`);
    pane.addEventListener('pointerenter',() => { hoveredSplit = which; });
    pane.addEventListener('pointerleave',() => { if (hoveredSplit === which) hoveredSplit = null; });
    pane.addEventListener('dragover',event => { if (draggedFiles && draggedFiles.which !== which) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; pane.classList.add('drop-target'); } });
    pane.addEventListener('dragleave',event => { if (!pane.contains(event.relatedTarget)) pane.classList.remove('drop-target'); });
    pane.addEventListener('drop',async event => {
      if (!draggedFiles || draggedFiles.which === which || pane.querySelector('.split-copy-overlay')) return;
      event.preventDefault(); event.stopPropagation(); pane.classList.remove('drop-target');
      const dragData = draggedFiles, destination = [...splitPaths[which]], generation = remoteGeneration, base = root; draggedFiles = null;
      const overlay = document.createElement('div'); overlay.className = 'split-copy-overlay'; overlay.setAttribute('role','status'); overlay.setAttribute('aria-live','polite');
      const circle = document.createElement('span'); circle.className = 'split-copy-progress'; circle.setAttribute('role','progressbar'); circle.setAttribute('aria-label','Copy progress'); circle.setAttribute('aria-valuemin','0'); circle.setAttribute('aria-valuemax','100'); circle.setAttribute('aria-valuenow','0');
      const label = document.createElement('span'); label.className = 'split-copy-label';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'clipboard-button'; cancel.textContent = 'Cancel';
      let cancelled = false; cancel.onclick = () => { cancelled = true; cancel.disabled = true; label.textContent = 'Cancelling…'; };
      const checkCancel = () => { if (cancelled) throw new Error('Copy cancelled.'); };
      const details = document.createElement('div'); details.className = 'split-copy-details'; details.append(label,cancel);
      overlay.append(circle,details); pane.append(overlay);
      try {
        label.textContent = `Copying ${dragData.items[0].name}…`;
        const planned = []; for (const item of dragData.items) planned.push(await planSplitItem(item,dragData.which,generation,checkCancel));
        const byteCount = item => item.kind === 'directory' ? item.children.reduce((sum,child) => sum + byteCount(child),0) : item.size || 0;
        const bytes = planned.reduce((sum,item) => sum + byteCount(item),0), started = performance.now();
        const total = planned.reduce((sum,item) => sum + item.weight,0); let completed = 0;
        const display = value => { const percentage = Math.max(0,Math.min(99,Math.floor(value / total * 100))); circle.style.setProperty('--copy-progress',`${percentage}%`); circle.setAttribute('aria-valuenow',String(percentage)); };
        const progress = {update(weight,fraction) { if (Number.isFinite(fraction)) display(completed + weight * Math.max(0,Math.min(1,fraction))); }, complete(weight) { completed += weight; display(completed); }};
        for (const item of planned) {
          checkCancel();
          label.textContent = `Copying ${item.name}…`;
          await copySplitItem(item,dragData.which,which,destination,generation,base,progress,checkCancel);
        }
        checkCancel();
        recordTransfer(bytes,Math.max(1,performance.now() - started));
        circle.style.setProperty('--copy-progress','100%'); circle.setAttribute('aria-valuenow','100');
        if (source === 'split') await loadSplit(which);
      } catch (error) {
        const message = pane.querySelector('.split-status');
        if (message && source === 'split') message.textContent = error.message || 'Could not copy the file.';
      } finally { overlay.remove(); if (cancelled && source === 'split') { await loadSplit(which,true,true); const message = pane.querySelector('.split-status'); if (message) message.textContent = 'Copy cancelled.'; } }

    });
  }
  function breadcrumbs() {
    const nav = $('breadcrumb'); nav.replaceChildren();
    nav.classList.toggle('single-subfolder', currentPath.length === 1);
    [activeFolder().name, ...currentPath].forEach((name,index) => {
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
  function enableBreadcrumbDrag(breadcrumb) {
    breadcrumb.addEventListener('pointerdown',e => { if (e.pointerType !== 'mouse') return; drag = {element:breadcrumb,x:e.clientX,scroll:breadcrumb.scrollLeft,moved:false}; });
    breadcrumb.addEventListener('click',e => { if (breadcrumb.dataset.dragged) { e.preventDefault(); e.stopPropagation(); } },true);
  }
  enableBreadcrumbDrag(nav);
  window.addEventListener('pointermove',e => { if (!drag) return; if (Math.abs(e.clientX-drag.x)>4) drag.moved = true; if (drag.moved) { drag.element.scrollLeft = drag.scroll-(e.clientX-drag.x); e.preventDefault(); } });
  window.addEventListener('pointerup',() => { if (drag?.moved) { const element = drag.element; element.dataset.dragged = 'true'; setTimeout(() => delete element.dataset.dragged,0); } drag = null; });
  window.addEventListener('pointercancel',() => { drag = null; });
  function showAddressText() {
    if (!activeFolder() || nav.querySelector('input')) return;
    const path = [activeFolder().name, ...currentPath].join('/');
    // A single-quoted POSIX shell argument preserves spaces and other special characters.
    const shellPath = /^[A-Za-z0-9_./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'breadcrumb-text'; input.value = shellPath;
    input.setAttribute('aria-label','Folder path. Press Enter to navigate.');
    nav.replaceChildren(input); $('breadcrumb-expand').hidden = true;
    input.addEventListener('blur', () => { if (nav.contains(input) && activeFolder()) breadcrumbs(); }, {once:true});
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
      if (parts.shift() !== activeFolder().name || !safePath(parts)) { showPathError(); return; }
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
    if (!activeFolder()) return;
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
  function sorted(items, key = sort, order = direction) { return [...items].sort((a,b) => { if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1; const x = key === 'type' ? fileType(a) : a[key] ?? '', y = key === 'type' ? fileType(b) : b[key] ?? ''; return (typeof x === 'number' && typeof y === 'number' ? x-y : String(x).localeCompare(String(y),undefined,{numeric:true,sensitivity:'base'})) * order; }); }
  function fileIcon(item) { if (item.kind === 'directory') return 'fa-solid fa-folder'; if ((item.type||'').startsWith('image/')) return 'fa-regular fa-file-image'; if ((item.type||'').startsWith('video/')) return 'fa-regular fa-file-video'; if ((item.type||'').startsWith('audio/')) return 'fa-regular fa-file-audio'; if (/\.pdf$/i.test(item.name)) return 'fa-regular fa-file-pdf'; if (/\.(txt|md|csv|js|json|html|css)$/i.test(item.name)) return 'fa-regular fa-file-lines'; return 'fa-regular fa-file'; }
  let zipLibrary;
  function loadZipLibrary() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (!zipLibrary) zipLibrary = new Promise((resolve,reject) => {
      const script = document.createElement('script'); script.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
      script.onload = () => window.JSZip ? resolve(window.JSZip) : reject(new Error('Folder download is unavailable.'));
      script.onerror = () => reject(new Error('Could not load folder download support.')); document.head.append(script);
    }).catch(error => { zipLibrary = null; throw error; });
    return zipLibrary;
  }
  async function folderArchive(item, which, report = status) {
    const generation = remoteGeneration, Zip = await loadZipLibrary(), zip = new Zip();
    async function addFolder(path, target) {
      if (generation !== remoteGeneration || !isConnected()) throw new Error('The shared folder is no longer available.');
      const children = await request('list',path,undefined,which);
      for (const child of children) {
        if (generation !== remoteGeneration || !isConnected()) throw new Error('The shared folder is no longer available.');
        if (child.kind === 'directory') await addFolder(child.path,target.folder(child.name));
        else { report(`Fetching ${child.name}…`); target.file(child.name,await request('file',child.path,undefined,which)); }
      }
    }
    await addFolder(item.path,zip.folder(item.name));
    report('Preparing download…'); const blob = await zip.generateAsync({type:'blob'});
    if (generation !== remoteGeneration || !isConnected()) throw new Error('The shared folder is no longer available.');
    return new File([blob],`${item.name}.zip`,{type:'application/zip'});
  }
  function downloadFile(file) { const url = URL.createObjectURL(file), link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url),60000); }
  function splitActionButtons(item, which, message) {
    const actions = document.createElement('div'); actions.className = 'folder-item-actions';
    for (const action of item.kind === 'directory' ? ['download'] : ['copy','download']) {
      const button = document.createElement('button'); button.type = 'button'; button.title = action === 'copy' ? 'Copy' : 'Download'; button.setAttribute('aria-label',`${button.title} ${item.name}`);
      const icon = document.createElement('i'); icon.className = action === 'copy' ? 'fa-regular fa-copy' : 'fa-solid fa-download'; icon.setAttribute('aria-hidden','true'); button.append(icon);
      button.onclick = async () => {
        const generation = remoteGeneration; message.textContent = `Fetching ${item.name}…`;
        try {
          if (action === 'download' && item.kind === 'file' && isIOS() && imageType({name:item.name,type:item.type || ''})) { void openPreview(item.name, () => request('file',item.path,undefined,which)); message.textContent = ''; return; }
          const file = item.kind === 'directory' ? await folderArchive(item,which,text => { message.textContent = text; }) : await request('file',item.path,undefined,which);
          if (source !== 'split' || generation !== remoteGeneration || !isConnected()) throw new Error('The shared folder is no longer available.');
          if (action === 'copy') await copyFile(file); else downloadFile(file);
          if (message.isConnected) message.textContent = '';
        } catch (error) { if (message.isConnected) message.textContent = error.message; }
      };
      actions.append(button);
    }
    return actions;
  }
  async function downloadLargeToHandle(item, handle, generation) {
    const writable = await handle.createWritable();
    try {
      for (let offset = 0; offset < item.size; offset += CHUNK_SIZE) {
        if (generation !== remoteGeneration || !isConnected() || source !== 'remote') throw new Error('The shared folder is no longer available.');
        const length = Math.min(CHUNK_SIZE,item.size-offset);
        const chunk = await request('read-chunk',item.path,{offset,size:item.size,modified:item.modified},'remote');
        if (generation !== remoteGeneration || !isConnected() || source !== 'remote') throw new Error('The shared folder is no longer available.');
        if (chunk.size !== length) throw new Error('Received an incomplete file chunk.');
        await writable.write(chunk); status(`Downloading ${item.name}… ${Math.floor((offset+length)/item.size*100)}%`);
      }
      if (generation !== remoteGeneration || !isConnected() || source !== 'remote') throw new Error('The shared folder is no longer available.');
      await writable.close();
    } catch (error) { await writable.abort().catch(() => {}); throw error; }
  }
  async function uniqueDownloadHandle(directoryHandle, filename) {
    const dot = filename.lastIndexOf('.'), stem = dot > 0 ? filename.slice(0,dot) : filename, ext = dot > 0 ? filename.slice(dot) : '';
    let name = filename, number = 1;
    while (true) {
      try { await directoryHandle.getFileHandle(name); name = `${stem} (${number++})${ext}`; }
      catch (error) { if (error.name === 'TypeMismatchError') { name = `${stem} (${number++})${ext}`; continue; } if (error.name === 'NotFoundError') break; throw error; }
    }
    return directoryHandle.getFileHandle(name,{create:true});
  }
  async function fileAction(item, action) {
    if (item.kind === 'directory') { status(`Fetching ${item.name}…`); try { downloadFile(await folderArchive(item,'remote')); status(''); } catch (error) { status(error.message); } return; }
    if (action === 'download' && source === 'remote' && item.size >= STREAM_THRESHOLD && window.showSaveFilePicker) {
      const generation = remoteGeneration;
      try { const handle = await window.showSaveFilePicker({suggestedName:item.name}); status(`Downloading ${item.name}…`); await downloadLargeToHandle(item,handle,generation); status(''); }
      catch (error) { if (error.name !== 'AbortError') status(error.message || 'Could not download the file.'); }
      return;
    }
    if (action === 'share' && isConnected()) sendMessage({type:'folder-show-shared'});
    if (action === 'download' && isIOS() && imageType({name:item.name, type:item.type || ''})) { void openPreview(item.name, () => request('file', item.path)); return; }
    const generation = remoteGeneration;
    status(`Fetching ${item.name}…`);
    try {
      const file = await request('file',item.path);
      if (generation !== remoteGeneration || !isConnected()) throw new Error('The shared folder is no longer available.');
      if (action === 'share') { await shareFile(file); status(''); }
      else if (action === 'copy') { await copyFile(file); status(''); }
      else { const url = URL.createObjectURL(file), a = document.createElement('a'); a.href = url; a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(url),60000); status(''); }
    } catch (error) { status(error.message); }
  }
  function actionButtons(item) {
    const actions = document.createElement('div'); actions.className = 'folder-item-actions';
    for (const [action,icon] of (item.kind === 'directory' ? [['download','fa-solid fa-download']] : source === 'local' ? [['share','fa-solid fa-arrow-right']] : [['copy','fa-regular fa-copy'],['download','fa-solid fa-download']])) { const button = document.createElement('button'); button.type = 'button'; button.title = action === 'share' ? 'Share' : action === 'copy' ? 'Copy' : 'Download'; button.setAttribute('aria-label',`${button.title} ${item.name}`); const i = document.createElement('i'); i.className = icon; i.setAttribute('aria-hidden','true'); if (action === 'share') button.append('Share ', i); else button.append(i); button.onclick = () => void fileAction(item,action); actions.append(button); }
    return actions;
  }
  function previewFile(item) { void openPreview(item.name, () => request('file', item.path)); }
  function itemName(item) { const name = document.createElement('button'); name.type = 'button'; name.className = 'folder-item-name'; name.textContent = item.name; name.title = item.name; name.onclick = () => item.kind === 'directory' ? navigate(item.path) : previewFile(item); return name; }
  function renderCards(items, container) {
    const grid = document.createElement('div'); grid.className = 'folder-grid';
    for (const item of sorted(items)) { const card = document.createElement('article'); card.className = 'folder-card'; card._folderItem = item; card.addEventListener('contextmenu',event => showRenameMenu(event,item,source,card.querySelector('.folder-item-name'),() => load(),status)); card.classList.toggle('selected', selected.has(selectionKey(item))); card.addEventListener('click', event => { if (!event.target.closest('button')) item.kind === 'directory' ? navigate(item.path) : previewFile(item); }); const thumb = document.createElement('button'); thumb.type = 'button'; thumb.className = 'folder-thumb'; thumb.setAttribute('aria-label',`${item.kind === 'directory' ? 'Open' : 'Preview'} ${item.name}`); thumb.onclick = () => item.kind === 'directory' ? navigate(item.path) : previewFile(item); const icon = document.createElement('i'); icon.className = fileIcon(item); thumb.append(icon); if (isImage(item)) observeThumbnail(thumb,item); card.append(thumb,itemName(item)); const sub = document.createElement('div'); sub.className = 'folder-item-meta'; sub.textContent = item.kind === 'directory' ? 'Folder' : size(item.size); card.append(sub); if (item.kind === 'file' || source === 'remote') card.append(actionButtons(item)); grid.append(card); }
    container.append(grid);
  }
  function renderList(items, container) {
    const wrapper = document.createElement('div'); wrapper.className = 'folder-table-wrap'; const table = document.createElement('table'); table.className = 'folder-table'; const head = table.createTHead().insertRow();
    for (const [label,key] of [['Name','name'],['Size','size'],['Type','type'],['Date modified','modified']]) { const th = document.createElement('th'), button = document.createElement('button'); button.textContent = `${label}${sort === key ? (direction === 1 ? ' ↑' : ' ↓') : ''}`; th.setAttribute('aria-sort',sort === key ? (direction === 1 ? 'ascending' : 'descending') : 'none'); button.onclick = () => { direction = sort === key ? -direction : 1; sort = key; render($('folder-search').value.trim()); }; th.append(button); head.append(th); }
    const actionsHead = document.createElement('th'); actionsHead.setAttribute('aria-label','Actions'); head.append(actionsHead); const body = table.createTBody();
    for (const item of sorted(items)) { const row = body.insertRow(); row._folderItem = item; row.addEventListener('contextmenu',event => showRenameMenu(event,item,source,row.querySelector('.folder-item-name'),() => load(),status)); row.classList.toggle('selected', selected.has(selectionKey(item))); const name = row.insertCell(); const icon = document.createElement('i'); icon.className = fileIcon(item); name.append(icon,itemName(item)); row.insertCell().textContent = item.kind === 'file' ? size(item.size) : '—'; row.insertCell().textContent = fileType(item); row.insertCell().textContent = item.modified ? new Date(item.modified).toLocaleDateString() : '—'; const actions = row.insertCell(); if (item.kind === 'file' || source === 'remote') actions.append(actionButtons(item)); }
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
    button.querySelector('i').className = source === 'local' ? 'fa-solid fa-arrow-right' : 'fa-solid fa-download';
    button.querySelector('span').textContent = downloadingSelection ? (source === 'local' ? 'Sharing…' : 'Downloading…') : `${source === 'local' ? 'Share ' : ''}${count} ${count === 1 ? 'item' : 'items'}`;
    for (const element of $('folder-content').querySelectorAll('.folder-card, tbody tr')) {
      element.classList.toggle('selected', !!element._folderItem && selected.has(selectionKey(element._folderItem)));
    }
  }
  function resetSelection() { selectionMode = false; selectionAnchor = null; selected.clear(); updateSelection(); }
  $('folder-select').onclick = () => { selectionMode = !selectionMode; if (!selectionMode) { selected.clear(); selectionAnchor = null; } updateSelection(); };
  window.matchMedia('(max-width: 500px)').addEventListener('change', event => { if (event.matches) resetSelection(); });
  $('folder-content').addEventListener('click', event => {
    if (!selectionMode) return;
    const element = event.target.closest('.folder-card, tbody tr'), item = element?._folderItem;
    if (!item || event.target.closest('input')) return;
    event.preventDefault(); event.stopPropagation();
    const key = selectionKey(item), rows = [...$('folder-content').querySelectorAll('.folder-card, tbody tr')].filter(row => row._folderItem), anchor = rows.findIndex(row => selectionKey(row._folderItem) === selectionAnchor), index = rows.indexOf(element);
    if (event.shiftKey && selected.size && anchor >= 0) { for (const row of rows.slice(Math.min(anchor,index),Math.max(anchor,index)+1)) selected.set(selectionKey(row._folderItem),row._folderItem); }
    else { if (selected.has(key)) selected.delete(key); else selected.set(key,item); selectionAnchor = selected.has(key) ? key : null; }
    updateSelection();
  }, true);
  document.addEventListener('pointerdown', event => {
    if (source === 'split' && !$('split-explorer').contains(event.target)) {
      for (const which of ['local','remote']) { splitSelections[which].clear(); splitSelectMode[which] = false; splitAnchors[which] = null; $(`split-${which}`).querySelectorAll('.split-item').forEach(row => { row.classList.remove('selected'); }); $(`split-${which}`).querySelector('.split-select')?.setAttribute('aria-pressed','false'); }
    } else if ((source === 'local' || source === 'remote') && !$('folder-explorer').contains(event.target)) resetSelection();
  });
  document.addEventListener('keydown', event => {
    if (source === 'split' && event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'a' && !hoveredSplit && !event.target.closest('input, textarea, [contenteditable="true"]') && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      document.querySelector('.split-select-guidance')?.remove();
      const guidance = document.createElement('div'); guidance.className = 'split-select-guidance'; guidance.setAttribute('role','status');
      guidance.textContent = 'Press Ctrl+A with your cursor over the folder you want all selected in';
      document.body.append(guidance); setTimeout(() => guidance.remove(),4000); return;
    }
    if (source === 'split' && event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'a' && hoveredSplit && !event.target.closest('input:not([type=checkbox]), textarea, [contenteditable="true"]') && !document.querySelector('dialog[open]')) {
      event.preventDefault(); const selectedPane = $(`split-${hoveredSplit}`), checked = splitSelections[hoveredSplit]; splitSelectMode[hoveredSplit] = true; selectedPane.querySelector('.split-select')?.setAttribute('aria-pressed','true');
      for (const row of selectedPane.querySelectorAll('.split-item')) { checked.set(selectionKey(row._folderItem),row._folderItem); row.classList.add('selected'); splitAnchors[hoveredSplit] = selectionKey(row._folderItem); }
      return;
    }
    if (!(event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'a') || $('folder-explorer').hidden || !window.matchMedia('(min-width: 501px)').matches || event.target.closest('input, textarea, [contenteditable="true"]') || document.querySelector('dialog[open]')) return;
    event.preventDefault(); selectionMode = true;
    for (const item of entries) if (item.path.length === currentPath.length + 1 && currentPath.every((part,index) => item.path[index] === part)) { selected.set(selectionKey(item),item); selectionAnchor = selectionKey(item); }
    updateSelection();
  });
  $('folder-download-selected').onclick = async () => {
    if (downloadingSelection) return;
    const files = [...selected.values()], generation = remoteGeneration;
    if (source === 'local' && isConnected()) sendMessage({type:'folder-show-shared'});
    downloadingSelection = true; updateSelection();
    try {
      const large = source === 'remote' ? files.filter(item => item.kind === 'file' && item.size >= STREAM_THRESHOLD) : [];
      let directoryHandle = null, singleHandle = null;
      if (large.length === 1 && window.showSaveFilePicker) singleHandle = await window.showSaveFilePicker({suggestedName:large[0].name});
      else if (large.length > 1 && window.showDirectoryPicker) directoryHandle = await window.showDirectoryPicker({mode:'readwrite'});
      for (const item of files) {
        if (generation !== remoteGeneration || !isConnected()) throw new Error('The shared folder is no longer available.');
        status(`Fetching ${item.name}…`);
        if (item.kind === 'file' && item.size >= STREAM_THRESHOLD && (singleHandle || directoryHandle)) { const handle = singleHandle || await uniqueDownloadHandle(directoryHandle,item.name); await downloadLargeToHandle(item,handle,generation); continue; }
        const file = item.kind === 'directory' ? await folderArchive(item,source) : await request('file',item.path);
        if (generation !== remoteGeneration || !isConnected()) throw new Error('The shared folder is no longer available.');
        if (source === 'local') await shareFile(file);
        else { const url = URL.createObjectURL(file), link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url),60000); }
      }
      status('');
    } catch (error) { if (error.name !== 'AbortError') status(error.message); else status(''); }
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
  $('folder-new').onclick = () => { if (source === 'local' || source === 'remote') startNewFolder(source,$('folder-explorer'),[...currentPath],false); };
  $('view-cards').onclick = () => { view = 'cards'; $('view-cards').setAttribute('aria-pressed','true'); $('view-list').setAttribute('aria-pressed','false'); render($('folder-search').value.trim()); };
  $('view-list').onclick = () => { view = 'list'; $('view-cards').setAttribute('aria-pressed','false'); $('view-list').setAttribute('aria-pressed','true'); render($('folder-search').value.trim()); };
  $('folder-search-toggle').onclick = () => { const opening = $('folder-search-row').hidden; $('folder-search-row').hidden = !opening; $('folder-search-toggle').setAttribute('aria-expanded',String(opening)); if (opening) $('folder-search').focus(); else { $('folder-search').value = ''; void load(); } };
  $('folder-search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(load,300); };
  $('folder-search-clear').onclick = () => { $('folder-search').value = ''; $('folder-search').focus(); void load(); };
  $('connect-folder').onclick = async () => {
    if (root) { abortIncomingStreams(); root = null; if (source === 'local' || source === 'split') showShared(); updateTabs(); $('connect-folder').innerHTML = '<i class="fa-regular fa-folder-open"></i> Connect folder'; shareStatus('Folder disconnected.'); tellPeer(); return; }
    if (!window.showDirectoryPicker) { shareStatus('Folder sharing is unavailable in this browser. Use a browser that supports folder selection.'); return; }
    try { const selected = await window.showDirectoryPicker({mode:'readwrite'}); if (!isConnected()) { shareStatus('Connect another device before sharing a folder.'); return; } root = selected; updateTabs(); if (remote) showSplit(); $('connect-folder').innerHTML = '<i class="fa-solid fa-xmark"></i> Disconnect folder'; shareStatus(`Sharing ${root.name} with the connected device.`); tellPeer(); }
    catch (error) { if (error.name !== 'AbortError') shareStatus('Could not access the folder. Please try again.'); }
  };
  return {
    join() { tellPeer(); },
    leave() { abortIncomingStreams(); root = null; showShared(); $('connect-folder').innerHTML = '<i class="fa-regular fa-folder-open"></i> Connect folder'; shareStatus(''); setRemote({}); },
    onControl(message,from) {
      if (message.type === 'folder-show-shared' && from === getPeer()) showShared();
      else if (message.type === 'folder-share') setRemote(message);
      else if (message.type === 'folder-request') void handleRequest(message,from);
      else if (message.type === 'folder-response') { const item = pending.get(message.id); if (!item) return; pending.delete(message.id); clearTimeout(item.timer); if (message.error) { const error = new Error(message.error); if (typeof message.errorName === 'string') error.name = message.errorName; item.reject(error); } else if (Array.isArray(message.entries)) item.resolve(message.entries); else item.reject(new Error('Invalid folder response.')); }
    },
    onProgress(progress,context) { const item = pending.get(context.metadata?.requestId); if (context.peerId === getPeer() && item?.onProgress) item.onProgress(progress); },
    onBytes(data,context) { const meta = context.metadata; if (meta?.streamId && data instanceof Uint8Array) { void receiveStreamChunk(data,meta,context.peerId); return; } if (meta?.writeId && data instanceof Uint8Array) { void receiveCopy(data,meta,context.peerId); return; } const item = pending.get(meta?.requestId); if (!item || context.peerId !== getPeer() || !(data instanceof Uint8Array) || typeof meta.name !== 'string') return; pending.delete(meta.requestId); clearTimeout(item.timer); item.resolve(new File([data],meta.name,{type:typeof meta.type === 'string' ? meta.type : '',lastModified:Number.isFinite(meta.modified) ? meta.modified : Date.now()})); }
  };
}
