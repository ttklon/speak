/** Классификация ошибок Web Speech API — чтобы UI подсказывал, что делать. */

export const RECOGNITION_MESSAGES = {
  'not-allowed': {
    title: 'Нет доступа к микрофону',
    hint: 'Разрешите доступ в Настройки → Данные и разрешения → Микрофон.',
  },
  'service-not-allowed': {
    title: 'Распознавание недоступно',
    hint: 'Включите локальный движок в Настройки → Функции → Обработка ИИ.',
  },
  'audio-capture': {
    title: 'Микрофон не найден',
    hint: 'Подключите микрофон и выберите его в Настройки → Функции.',
  },
  network: {
    title: 'Движок распознавания недоступен',
    hint: 'ZSpeakly работает офлайн: подключите локальную модель Whisper в Настройках.',
  },
  'no-speech': {
    title: 'Речь не распознана',
    hint: 'Попробуйте говорить ближе к микрофону.',
  },
  aborted: { title: 'Запись остановлена', hint: '' },
  'language-not-supported': {
    title: 'Язык не поддерживается',
    hint: 'Выберите другой язык диктовки в Настройках → Функции.',
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
