/**
 * Каким движком распознавать эту запись.
 *
 * Зачем отдельным модулем: решение «взять русскую модель, европейскую или
 * обычную» — это политика, а не код распознавания. Её надо уметь проверить
 * тестом на всех сочетаниях (язык, наличие модели, длина записи), иначе однажды
 * окажется, что на английском включилась русская модель и человек получил
 * русские буквы в ответ на английскую речь.
 *
 * Правила простые и без настроек:
 *  • русский язык + русская модель на месте → она (понимает лучше, считает на
 *    процессоре быстрее whisper, знаки ставит сама);
 *  • английский, немецкий, французский, испанский, украинский + модель
 *    европейских языков на месте → она (быстрее и точнее лёгких моделей);
 *  • остальные языки (китайский, японский, турецкий, казахский) → прежний
 *    движок: европейская модель их не знает и прочитает по-своему;
 *  • запись совсем короткая → прежний движок (обеим моделям нужно окно
 *    признаков, а на «да» и «нет» разница незаметна);
 *  • модели нет или она сломалась → прежний движок, и в журнал уходит причина:
 *    тихой подмены быть не должно.
 */

const ENGINES = { gigaam: 'gigaam', parakeet: 'parakeet', whisper: 'whisper' };

/** Минимальная длина записи для моделей на ONNX: короче секунды они дополняют тишиной. */
const MIN_SECONDS = 1;

/**
 * @param {object} input
 * @param {string} [input.language] язык распознавания из настроек
 * @param {{ available: boolean, reason?: string }} [input.gigaam] состояние русской модели
 * @param {{ available: boolean, reason?: string }} [input.parakeet] состояние модели европейских языков
 * @param {number} [input.seconds] длительность записи
 * @param {'auto'|'whisper'} [input.preference] явный выбор человека
 * @returns {{ engine: string, why: string }}
 */
function chooseEngine({ language, gigaam, parakeet, seconds, preference } = {}) {
  if (preference === 'whisper') return { engine: ENGINES.whisper, why: 'Whisper выбран вручную' };
  const lang = String(language || 'ru')
    .toLowerCase()
    .trim();
  const base = lang.split(/[-_]/)[0] || 'ru';
  const short = Number(seconds) > 0 && Number(seconds) < MIN_SECONDS;

  if (base === 'ru') {
    if (!gigaam?.available) {
      return { engine: ENGINES.whisper, why: gigaam?.reason || 'русская модель не готова' };
    }
    if (short) return { engine: ENGINES.whisper, why: 'запись короче секунды' };
    return { engine: ENGINES.gigaam, why: 'русский язык и русская модель на месте' };
  }

  // Список берём у самого движка: он знает, какие языки выучил.
  const european = Array.isArray(parakeet?.languages) ? parakeet.languages : null;
  const knowsLanguage = european ? european.includes(base) : false;
  if (knowsLanguage) {
    if (!parakeet?.available) {
      return { engine: ENGINES.whisper, why: parakeet?.reason || 'модель европейских языков не готова' };
    }
    if (short) return { engine: ENGINES.whisper, why: 'запись короче секунды' };
    return { engine: ENGINES.parakeet, why: `язык «${base}» и модель европейских языков на месте` };
  }
  return { engine: ENGINES.whisper, why: `язык «${base}» — европейская модель его не знает` };
}

module.exports = { ENGINES, MIN_SECONDS, chooseEngine };
