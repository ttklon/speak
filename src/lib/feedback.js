/**
 * Звуковые отклики и «эффект печати».
 *
 * Раньше тумблеры «Звуковой отклик» и «Эффект печати» просто сохраняли
 * значение в настройках и ничего не делали. Теперь:
 *  - звук — короткий WebAudio-бип на старте и остановке записи;
 *  - эффект печати — постепенное появление текста по словам.
 */

let ctx = null;

function audio() {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  return ctx;
}

/**
 * Короткий сигнал. Не будильник: 80–120 мс, мягкая атака и затухание.
 * @param {'start'|'stop'|'error'} kind
 */
export function playCue(kind = 'start') {
  const ac = audio();
  if (!ac) return;
  if (ac.state === 'suspended') ac.resume().catch(() => {});

  const now = ac.currentTime;
  const osc = ac.createOscillator();
  const gain = ac.createGain();

  const tone = kind === 'start' ? 660 : kind === 'stop' ? 440 : 220;
  osc.type = 'sine';
  osc.frequency.setValueAtTime(tone, now);
  if (kind === 'start') osc.frequency.linearRampToValueAtTime(tone * 1.25, now + 0.08);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.09, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);

  osc.connect(gain).connect(ac.destination);
  osc.start(now);
  osc.stop(now + 0.15);
}

/**
 * Постепенно «допечатать» текст по словам.
 *
 * @param {string} text       полный текст
 * @param {(partial: string) => void} onTick  вызывается на каждом шаге
 * @param {object} opts       { stepMs, wordsPerStep, signal }
 * @returns {Promise<string>} полный текст (даже если отменили)
 */
export function typeOut(text, onTick, { stepMs = 45, wordsPerStep = 2, signal } = {}) {
  const full = String(text || '');
  if (!full.trim()) return Promise.resolve(full);

  const words = full.split(/(\s+)/);
  return new Promise((resolve) => {
    let i = 0;
    const step = () => {
      if (signal?.aborted) {
        resolve(full);
        return;
      }
      i += wordsPerStep * 2; // слово + пробел
      const partial = words.slice(0, i).join('');
      if (i >= words.length) {
        // финальный кусок — сразу полный текст, без дубля последнего шага
        onTick?.(full);
        resolve(full);
        return;
      }
      onTick?.(partial);
      setTimeout(step, stepMs);
    };
    step();
  });
}

export default { playCue, typeOut };
