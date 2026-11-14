/** Микрофоны: список устройств ввода и анализатор уровня для индикатора. */

/**
 * Превращает ответ enumerateDevices в пункты списка.
 *
 * Chromium (и Windows) отдают устройство с deviceId «default» — это тот же
 * «Системный по умолчанию», который уже есть отдельным пунктом. Дубли давали
 * два одинаковых ключа в React-списке (warning «same key») и две строки
 * «Системный по умолчанию» в настройках.
 */
export function normalizeInputs(all = []) {
  const seen = new Set();
  const out = [];
  all
    .filter((d) => d && d.kind === 'audioinput')
    .forEach((d, i) => {
      const id = d.deviceId || `mic-${i}`;
      if (id === 'default' || id === 'communications' || seen.has(id)) return;
      seen.add(id);
      out.push({ id, label: d.label || `Микрофон ${out.length + 1}` });
    });
  return out;
}

export async function listDevices() {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
  try {
    return normalizeInputs(await navigator.mediaDevices.enumerateDevices());
  } catch {
    return [];
  }
}

/** Анализатор уровня — для «пульсации» индикатора записи. */
export async function createLevelMeter(stream) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || !stream) return { level: () => 0, dispose() {} };
  const ctx = new Ctx();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  return {
    level() {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
    },
    dispose() {
      try {
        src.disconnect();
        analyser.disconnect();
        ctx.close();
      } catch {
        /* ignore */
      }
    },
  };
}
