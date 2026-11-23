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

  const stopTracks = () => {
    stream.getTracks().forEach((track) => {
      try { track.stop(); } catch { /* остальные дорожки всё равно нужно остановить */ }
    });
  };
  let mimeType;
  let recorder;
  try {
    const mimeCandidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (err) {
    stopTracks();
    throw err;
  }
  const chunks = [];
  let cancelled = false;
  let interrupted = false;
  const videoTracks = stream.getTracks().filter((track) => track.kind === 'video');
  const removeEndedListeners = () => videoTracks.forEach((track) => track.removeEventListener?.('ended', onVideoEnded));
  let failFinished;
  const onVideoEnded = () => {
    if (cancelled || recorder.state === 'inactive') return;
    try {
      recorder.stop();
    } catch {
      if (tick) clearInterval(tick);
      removeEndedListeners();
      stopTracks();
      failFinished(new Error('Не удалось завершить запись'));
    }
  };
  const startedAt = Date.now();
  const tick = onTick ? setInterval(() => onTick(Date.now() - startedAt), 1000) : null;

  recorder.ondataavailable = (e) => {
    if (!cancelled && e.data && e.data.size) chunks.push(e.data);
  };

  recorder.onerror = () => { interrupted = true; };
  const finished = new Promise((resolve, reject) => {
    failFinished = reject;
    recorder.onstop = async () => {
      if (tick) clearInterval(tick);
      removeEndedListeners();
      stopTracks();
      try {
        const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
        chunks.length = 0;
        const poster = cancelled || !blob.size ? '' : await grabPoster(blob);
        // Отмена могла прийти, пока создавался постер.
        const output = cancelled ? new Blob([], { type: mimeType || 'video/webm' }) : blob;
        resolve({
          blob: output,
          poster: cancelled ? '' : poster,
          durationMs: Date.now() - startedAt,
          sizeMb: Math.round((output.size / (1024 * 1024)) * 10) / 10,
          interrupted,
        });
      } catch {
        chunks.length = 0;
        reject(new Error('Не удалось обработать запись'));
      }
    };
  });

  try {
    videoTracks.forEach((track) => track.addEventListener?.('ended', onVideoEnded));
    recorder.start(1000);
  } catch (err) {
    if (tick) clearInterval(tick);
    removeEndedListeners();
    stopTracks();
    throw err;
  }
  // Дорожка могла завершиться до установки обработчика.
  if (videoTracks.some((track) => track.readyState === 'ended')) onVideoEnded();

  return {
    mimeType,
    stop: () => {
      if (recorder.state !== 'inactive') recorder.stop();
      return finished;
    },
    cancel: () => {
      cancelled = true;
      chunks.length = 0;
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } finally {
        removeEndedListeners();
        stopTracks();
        if (tick) clearInterval(tick);
      }
    },
    finished,
  };
}

/** Первый кадр как PNG-постер: показываем в карточке буфера. */
async function grabPoster(blob) {
  let url;
  try {
    const video = document.createElement('video');
    url = URL.createObjectURL(blob);
    video.src = url;
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
    return canvas.toDataURL('image/png');
  } catch {
    return '';
  } finally {
    try { if (url) URL.revokeObjectURL(url); } catch { /* окно уже закрывается */ }
  }
}

export default startScreenRecording;
