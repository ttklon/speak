/**
 * Что просить у микрофона.
 *
 * Раньше всегда стояли echoCancellation и noiseSuppression: браузерная
 * обработка «для звонков». Для диктовки она вредит — шумодав срезает тихие
 * окончания слов и шипящие, а AGC «подкачивает» громкость на паузах. Whisper
 * обучен на живой записи и к такой обработке не привык: на выходе «каша».
 *
 * Поэтому по умолчанию просим сырой звук, а громкость выравниваем сами, уже в
 * main-процессе (electron/audioPrep.cjs) — предсказуемо и одинаково для всех
 * микрофонов. Если вокруг шумно, человек включает «Шумоподавление Windows» в
 * настройках: тогда возвращаются обработки браузера.
 */

export function micConstraints({ deviceId = 'default', cleanup = false } = {}) {
  const base = {
    channelCount: 1,
    echoCancellation: cleanup === true,
    noiseSuppression: cleanup === true,
    autoGainControl: cleanup === true,
  };
  if (deviceId && deviceId !== 'default') {
    return { audio: { deviceId: { exact: deviceId }, ...base } };
  }
  return { audio: base };
}
