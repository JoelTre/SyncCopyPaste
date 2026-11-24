const imageTypes = {png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', bmp:'image/bmp', avif:'image/avif', svg:'image/svg+xml', heic:'image/heic', heif:'image/heif'};
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export function imageType(file) { return file.type.startsWith('image/') ? file.type : imageTypes[file.name.split('.').pop().toLowerCase()] || ''; }
export function shareImage(file, fallback, report) {
  const type = imageType(file);
  const image = file.type === type ? file : new File([file], file.name, {type, lastModified:file.lastModified});
  if (!navigator.share || !navigator.canShare || !navigator.canShare({files:[image]})) { fallback(); return; }
  navigator.share({files:[image]}).catch(error => { if (error.name !== 'AbortError') report('Could not share this image. Open its preview and touch and hold the image to save it.'); });
}
