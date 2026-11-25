import {isIOS, imageType, shareImage} from './image-save.js';
const $ = id => document.getElementById(id);
const dialog = $('preview-dialog'), body = $('preview-body');
let generation = 0, imageURL = null, mammothPromise, highlightPromise, currentFile = null, copyHandler;
const unsupported = 'A preview cannot be displayed for this file type.';
export function setPreviewCopyHandler(handler) { copyHandler = handler; }
function release() { generation++; if (imageURL) URL.revokeObjectURL(imageURL); imageURL = null; currentFile = null; $('preview-copy').disabled = true; $('preview-download').disabled = true; $('preview-status').textContent = ''; $('preview-status').classList.remove('copy-error-message'); body.replaceChildren(); }
$('preview-copy').onclick = () => { if (currentFile && copyHandler) void copyHandler(currentFile, (text, isError = false) => { $('preview-status').classList.toggle('copy-error-message', isError); $('preview-status').textContent = text; }); };
$('preview-download').onclick = () => { if (!currentFile) return; if (isIOS() && imageType(currentFile)) { shareImage(currentFile, () => { $('preview-status').textContent = 'Touch and hold the image to save it.'; }, text => { $('preview-status').textContent = text; }); return; } const url = URL.createObjectURL(currentFile), link = document.createElement('a'); link.href = url; link.download = currentFile.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); };
$('close-preview').onclick = () => dialog.close();
dialog.addEventListener('close', release);
dialog.addEventListener('click', event => { if (event.target !== dialog) return; const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); });
function message(text) { body.replaceChildren(); const p = document.createElement('p'); p.className = 'preview-message'; p.textContent = text; body.append(p); }
function mammoth() {
  if (!mammothPromise) mammothPromise = new Promise((resolve,reject) => {
    if (window.mammoth) { resolve(window.mammoth); return; }
    const script = document.createElement('script'); script.src = 'https://cdn.jsdelivr.net/npm/mammoth@1.10.0/mammoth.browser.min.js'; script.onload = () => window.mammoth ? resolve(window.mammoth) : reject(new Error('Document preview unavailable')); script.onerror = () => reject(new Error('Document preview unavailable')); document.head.append(script);
  }).catch(error => { mammothPromise = null; throw error; });
  return mammothPromise;
}
function displayText(text, documentStyle = false) {
  const pre = document.createElement('pre'); pre.className = documentStyle ? 'preview-document' : 'preview-code'; pre.textContent = text; body.replaceChildren(pre);
}
function displayTable(text, delimiter, truncated) {
  const rows = [], row = []; let field = '', quoted = false, limited = false;
  const addField = () => { row.push(field); field = ''; };
  const addRow = () => { addField(); rows.push(row.splice(0)); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && !field) quoted = true;
    else if (char === delimiter) addField();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      addRow();
      if (rows.length >= 1000) { limited = i < text.length - 1; break; }
    } else field += char;
  }
  if (!limited && (field || row.length)) addRow();
  const table = document.createElement('table'); table.className = 'preview-table';
  const tbody = table.createTBody();
  for (const cells of rows) {
    const tr = tbody.insertRow();
    for (const value of cells.slice(0, 200)) tr.insertCell().textContent = value;
    if (cells.length > 200) limited = true;
  }
  body.replaceChildren(table);
  if (truncated || limited) { const note = document.createElement('p'); note.className = 'preview-message'; note.textContent = 'Preview truncated.'; body.append(note); }
}
function highlightCode(text, language, token) {
  if (!highlightPromise) highlightPromise = new Promise((resolve,reject) => {
    if (window.hljs) { resolve(window.hljs); return; }
    const script = document.createElement('script'); script.src = 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/highlight.min.js';
    script.onload = () => window.hljs ? resolve(window.hljs) : reject(new Error('Syntax highlighting unavailable'));
    script.onerror = () => reject(new Error('Syntax highlighting unavailable')); document.head.append(script);
  }).catch(error => { highlightPromise = null; throw error; });
  void highlightPromise.then(hljs => {
    if (token !== generation) return;
    const pre = document.createElement('pre'), code = document.createElement('code');
    pre.className = 'preview-code syntax-code';
    code.innerHTML = hljs.highlight(text, {language, ignoreIllegals:true}).value;
    pre.append(code); body.replaceChildren(pre);
  }).catch(() => {});
}
function looksLikeText(bytes) {
  if (!bytes.length) return true;
  let controls = 0;
  for (const byte of bytes) { if (byte === 0) return false; if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) controls++; }
  return controls / bytes.length < .02;
}
export async function openPreview(name, getFile) {
  release(); const token = generation; $('preview-title').textContent = name; message('Loading preview…'); if (!dialog.open) dialog.showModal();
  try {
    const file = await getFile(); if (token !== generation) return;
    currentFile = file; $('preview-copy').disabled = false; $('preview-download').disabled = false;
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'pdf' || file.type === 'application/pdf') {
      imageURL = URL.createObjectURL(file.slice(0, file.size, 'application/pdf'));
      const frame = document.createElement('iframe'); frame.className = 'preview-pdf'; frame.title = `PDF preview: ${file.name}`; frame.src = imageURL; body.replaceChildren(frame); return;
    }
    if (ext === 'm4a' || file.type === 'audio/mp4' || file.type === 'audio/x-m4a') {
      imageURL = URL.createObjectURL(file.slice(0, file.size, 'audio/mp4')); const audio = document.createElement('audio'); audio.className = 'preview-audio'; audio.controls = true; audio.preload = 'metadata'; audio.setAttribute('aria-label', file.name); audio.onerror = () => { if (token === generation) message('This audio cannot be played in this browser. Download the file to play it in another app.'); }; audio.src = imageURL; body.replaceChildren(audio); return;
    }
    if (file.type.startsWith('video/') || ['mp4','m4v','webm','mov','ogv'].includes(ext)) {
      const videoTypes = {mp4:'video/mp4',m4v:'video/mp4',webm:'video/webm',mov:'video/quicktime',ogv:'video/ogg'};
      const videoFile = videoTypes[ext] && file.type !== videoTypes[ext] ? file.slice(0, file.size, videoTypes[ext]) : file;
      imageURL = URL.createObjectURL(videoFile); const video = document.createElement('video'); video.className = 'preview-video'; video.controls = true; video.playsInline = true; video.preload = 'metadata'; video.setAttribute('aria-label', file.name); video.onerror = () => { if (token === generation) message('This video format or codec cannot be played in this browser. Download the file to play it in another app.'); }; video.src = imageURL; body.replaceChildren(video); return;
    }
    if (file.type.startsWith('image/') || ['png','jpg','jpeg','gif','webp','bmp','avif','svg'].includes(ext)) {
      const img = document.createElement('img'); img.className = 'preview-image'; img.alt = file.name; img.onerror = () => { if (token === generation) message(unsupported); }; body.replaceChildren(img);
      if (isIOS()) { const reader = new FileReader(); reader.onload = () => { if (token === generation) img.src = reader.result; }; reader.onerror = () => { if (token === generation) message(unsupported); }; reader.readAsDataURL(file.type ? file : file.slice(0, file.size, imageType(file))); }
      else { imageURL = URL.createObjectURL(file); img.src = imageURL; } return;
    }
    if (ext === 'docx') {
      message('Preparing document preview…'); const library = await mammoth(); const result = await library.extractRawText({arrayBuffer:await file.arrayBuffer()}); if (token === generation) displayText(result.value || '(Empty document)', true); return;
    }
    // Cap text previews to keep large files responsive and reject binary content.
    const limit = 2 * 1024 * 1024, bytes = new Uint8Array(await file.slice(0, limit).arrayBuffer());
    if (token !== generation) return;
    if (!looksLikeText(bytes.subarray(0, Math.min(bytes.length,8192)))) { message(unsupported); return; }
    let text; try { text = new TextDecoder('utf-8', {fatal:true}).decode(bytes, {stream:file.size > limit}); } catch { message(unsupported); return; }
    if (file.name === 'Pasted text.txt' && file.type === 'text/plain' && file.size <= limit) {
      const value = text.trim(); let url;
      try { if (!/\s/.test(value)) url = new URL(value); } catch { /* Display ordinary text. */ }
      if (url && ['http:', 'https:'].includes(url.protocol)) {
        const pre = document.createElement('pre'), link = document.createElement('a');
        pre.className = 'preview-code'; link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = value;
        pre.append(link); body.replaceChildren(pre); $('preview-title').textContent = 'Pasted link'; return;
      }
    }
    if (ext === 'csv' || ext === 'tsv') { displayTable(text, ext === 'csv' ? ',' : '\t', file.size > limit); return; }
    if (file.size > limit) text += '\n\n[Preview truncated]';
    displayText(text || '(Empty file)');
    const language = {html:'xml', htm:'xml', js:'javascript', mjs:'javascript', cjs:'javascript', css:'css', py:'python'}[ext];
    if (language && text) highlightCode(text, language, token);
  } catch { if (token === generation) message(unsupported); }
}
