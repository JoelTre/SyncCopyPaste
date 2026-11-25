try { document.documentElement.dataset.theme = localStorage.getItem('synccopypaste-theme') || 'light'; } catch {}
document.querySelectorAll('.article-image img').forEach(image => {
  const show = () => { image.closest('figure').hidden = false; };
  if (image.complete && image.naturalWidth) show();
  else image.addEventListener('load', show, {once: true});
});
