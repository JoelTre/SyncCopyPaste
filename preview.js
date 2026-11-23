const $ = id => document.getElementById(id);
const dialog = $('preview-dialog'), body = $('preview-body');
let generation = 0, imageURL = null, mammothPromise, highlightPromise, currentFile = null, copyHandler;
const unsupported = 'A preview cannot be displayed for this file type.';
export function setPreviewCopyHandler(handler) { copyHandler = handler; }
function release() { generation++; if (imageURL) URL.revokeObjectURL(imageURL); imageURL = null; currentFile = null; $('preview-copy').disabled = true; $('preview-download').disabled = true; $('preview-status').textContent = ''; body.replaceChildren(); }
$('preview-copy').onclick = () => { if (currentFile && copyHandler) void copyHandler(currentFile, text => { $('preview-status').textContent = text; }); };
$('preview-download').onclick = () => { if (!currentFile) return; const url = URL.createObjectURL(currentFile), link = document.createElement('a'); link.href = url; link.download = currentFile.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); };
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
    if (file.type.startsWith('image/') || ['png','jpg','jpeg','gif','webp','bmp','avif','svg'].includes(ext)) {
      imageURL = URL.createObjectURL(file); const img = document.createElement('img'); img.className = 'preview-image'; img.alt = file.name; img.onerror = () => { if (token === generation) message(unsupported); }; img.src = imageURL; body.replaceChildren(img); return;
    }
    if (ext === 'docx') {
      message('Preparing document preview…'); const library = await mammoth(); const result = await library.extractRawText({arrayBuffer:await file.arrayBuffer()}); if (token === generation) displayText(result.value || '(Empty document)', true); return;
    }
    // Cap text previews to keep large files responsive and reject binary content.
    const limit = 2 * 1024 * 1024, bytes = new Uint8Array(await file.slice(0, limit).arrayBuffer());
    if (token !== generation) return;
    if (!looksLikeText(bytes.subarray(0, Math.min(bytes.length,8192)))) { message(unsupported); return; }
    let text; try { text = new TextDecoder('utf-8', {fatal:true}).decode(bytes, {stream:file.size > limit}); } catch { message(unsupported); return; }
    if (file.size > limit) text += '\n\n[Preview truncated]';
    displayText(text || '(Empty file)');
    const language = {html:'xml', htm:'xml', js:'javascript', mjs:'javascript', cjs:'javascript', css:'css'}[ext];
    if (language && text) highlightCode(text, language, token);
  } catch { if (token === generation) message(unsupported); }
}
