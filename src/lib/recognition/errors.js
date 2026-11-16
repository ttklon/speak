/** Классификация ошибок Web Speech API — чтобы UI подсказывал, что делать. */

export const RECOGNITION_MESSAGES = {
  'not-allowed': {
    title: 'Нет доступа к микрофону',
    hint: 'Разрешите доступ: «Настройки → Данные и разрешения → Микрофон».',
  },
  'service-not-allowed': {
    title: 'Распознавание недоступно',
    hint: 'Включите локальный движок: «Настройки → Функции → Модель распознавания».',
  },
  'audio-capture': {
    title: 'Микрофон не найден',
    hint: 'Подключите микрофон и выберите его в «Настройки → Данные и разрешения».',
  },
  network: {
    title: 'Движок распознавания недоступен',
    hint: 'ZSpeakly работает офлайн: скачайте модель Whisper в «Настройки → Функции».',
  },
  'no-speech': {
    title: 'Речь не распознана',
    hint: 'Попробуйте говорить ближе к микрофону.',
  },
  aborted: { title: 'Запись остановлена', hint: '' },
  'language-not-supported': {
    title: 'Язык не поддерживается',
    hint: 'Выберите другой язык диктовки: «Настройки → Функции → Диктовка».',
  },
};

export function describeRecognitionError(code) {
  return (
    RECOGNITION_MESSAGES[code] || {
      title: 'Ошибка распознавания',
      hint: `Код: ${code || 'unknown'}`,
    }
  );
}
