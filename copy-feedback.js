export function prepareCopyButton(button) {
  button.innerHTML = '<span class="copy-icons" aria-hidden="true"><i class="fa-regular fa-copy copy-icon"></i><span class="copy-spinner"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" pathLength="100"></circle></svg></span><i class="fa-solid fa-check copy-check"></i><i class="fa-solid fa-xmark copy-error"></i></span>';
}

const timers = new WeakMap();
export function startCopy(button) {
  clearTimeout(timers.get(button));
  button.classList.remove('copy-succeeded', 'copy-failed');
  button.classList.add('copy-loading');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  return performance.now();
}

export function finishCopy(button, started, success) {
  const delay = Math.max(0, 400 - (performance.now() - started));
  timers.set(button, setTimeout(() => {
    button.classList.remove('copy-loading');
    button.disabled = false;
    button.removeAttribute('aria-busy');
    const resultClass = success ? 'copy-succeeded' : 'copy-failed';
    button.classList.add(resultClass);
    timers.set(button, setTimeout(() => { button.classList.remove(resultClass); timers.delete(button); }, 1600));
  }, delay));
}

export function showCopySuccess(button) {
  clearTimeout(timers.get(button));
  button.classList.add('copy-succeeded');
  timers.set(button, setTimeout(() => { button.classList.remove('copy-succeeded'); timers.delete(button); }, 1600));
}
