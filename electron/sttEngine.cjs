/**
 * Каким движком распознавать эту запись.
 *
 * Зачем отдельным модулем: решение «взять русскую модель или обычную» — это
 * политика, а не код распознавания. Её надо уметь проверить тестом на всех
 * сочетаниях (язык, наличие модели, длина записи), иначе однажды окажется, что
 * на английском включилась русская модель и человек получил русские буквы в
 * ответ на английскую речь.
 *
 * Правила простые и без настроек:
 *  • русский язык + русская модель на месте → она (понимает лучше, ставит знаки
 *    сама, считает на процессоре быстрее whisper);
 *  • любой другой язык → прежний движок;
 *  • запись совсем короткая → прежний движок (русской модели нужно окно
 *    признаков, а на «да» и «нет» разница незаметна);
 *  • русской модели нет или она сломалась → прежний движок, и в журнал уходит
 *    причина: тихой подмены быть не должно.
 */

const ENGINES = { gigaam: 'gigaam', whisper: 'whisper' };

/** Минимальная длина записи для русской модели: короче секунды она дополняет тишиной. */
const MIN_SECONDS = 1;

/**
 * @param {object} input
 * @param {string} [input.language] язык распознавания из настроек
 * @param {{ available: boolean, reason?: string }} [input.gigaam] состояние русской модели
 * @param {number} [input.seconds] длительность записи
 * @returns {{ engine: string, why: string }}
 */
function chooseEngine({ language, gigaam, seconds } = {}) {
  const lang = String(language || 'ru').toLowerCase();
  if (!lang.startsWith('ru')) {
    return { engine: ENGINES.whisper, why: `язык «${lang}» — русская модель знает только русский` };
  }
  if (!gigaam?.available) {
    return { engine: ENGINES.whisper, why: gigaam?.reason || 'русская модель не готова' };
  }
  if (Number(seconds) > 0 && Number(seconds) < MIN_SECONDS) {
    return { engine: ENGINES.whisper, why: 'запись короче секунды' };
  }
  return { engine: ENGINES.gigaam, why: 'русский язык и русская модель на месте' };
}

module.exports = { ENGINES, MIN_SECONDS, chooseEngine };
