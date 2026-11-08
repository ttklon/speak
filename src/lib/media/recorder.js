/**
 * Запись экрана (и системного звука на Windows).
 *
 * В Electron main-процесс уже отдаёт источник в setDisplayMediaRequestHandler,
 * поэтому getDisplayMedia() работает без диалога выбора окна. В браузере
 * покажется обычный выбор вкладки/экрана.
 *
 * Результат — Blob: видео в WebM + отдельный скриншот-постер (кадр 0),
 * чтобы элемент буфера сразу показывал превью.
 */

export function isRecordingSupported() {
  if (typeof navigator === 'undefined') return false;
  return Boolean(navigator.mediaDevices?.getDisplayMedia) && typeof MediaRecorder !== 'undefined';
}

/**
 * @param {object} opts
 * @param {(ms:number)=>void} opts.onTick  тик каждой секунды
 * @param {boolean} opts.audio             писать системный звук, если доступен
 */
export async function startScreenRecording({ audio = true, onTick } = {}) {
  if (!isRecordingSupported()) {
    throw new Error('Запись экрана не поддерживается этим окружением');
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 },
    audio: audio ? { echoCancellation: false, noiseSuppression: false } : false,
  });

  const mimeCandidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  const startedAt = Date.now();
  const tick = onTick ? setInterval(() => onTick(Date.now() - startedAt), 1000) : null;

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };

  const finished = new Promise((resolve) => {
    recorder.onstop = async () => {
      if (tick) clearInterval(tick);
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
      const poster = await grabPoster(stream, blob);
      resolve({
        blob,
        poster,
        durationMs: Date.now() - startedAt,
        sizeMb: Math.round((blob.size / (1024 * 1024)) * 10) / 10,
      });
    };
  });

  recorder.start(1000);

  return {
    mimeType,
    stop: () => {
      if (recorder.state !== 'inactive') recorder.stop();
      return finished;
    },
    cancel: () => {
      chunks.length = 0;
      if (recorder.state !== 'inactive') recorder.stop();
      stream.getTracks().forEach((t) => t.stop());
      if (tick) clearInterval(tick);
    },
    finished,
  };
}

/** Первый кадр как PNG-постер: показываем в карточке буфера. */
async function grabPoster(stream, blob) {
  try {
    const video = document.createElement('video');
    video.src = URL.createObjectURL(blob);
    video.muted = true;
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = reject;
      setTimeout(resolve, 1500);
    });
    video.currentTime = 0.1;
    await new Promise((resolve) => {
      video.onseeked = resolve;
      setTimeout(resolve, 800);
    });
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = Math.round((480 / (video.videoWidth || 16)) * (video.videoHeight || 9)) || 270;
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const poster = canvas.toDataURL('image/png');
    URL.revokeObjectURL(video.src);
    return poster;
  } catch {
    return '';
  }
}

export default startScreenRecording;
