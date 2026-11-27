import { RECORDING_MAX_BYTES } from './recordingLimits.js';

/** Сохранение полученного Blob без разворачивания всего массива байтов в аргументы функции. */
export function recordingBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось подготовить запись'));
    reader.onabort = () => reject(new Error('Подготовка записи прервана'));
    reader.onload = () => {
      const result = reader.result;
      const comma = typeof result === 'string' ? result.indexOf(',') : -1;
      if (comma < 0 || !result.slice(0, comma).endsWith(';base64')) {
        reject(new Error('Не удалось подготовить запись'));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/** В браузере можно лишь запросить загрузку; её фактическое завершение неизвестно. */
export async function saveScreenRecording(blob, name, bridge) {
  if (!blob || !Number.isFinite(blob.size) || blob.size <= 0 || blob.size > RECORDING_MAX_BYTES) {
    throw new Error('Недопустимый размер записи');
  }
  if (bridge?.saveFile) {
    const base64 = await recordingBase64(blob);
    const result = await bridge.saveFile({ name, base64 });
    if (result?.ok !== true) throw new Error('Не удалось сохранить запись');
    return { saved: true, path: result.path || '' };
  }
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  return { saved: false };
}
