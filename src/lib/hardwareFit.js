/**
 * Подходит ли выбранная модель этой машине.
 *
 * Зачем: каталог моделей говорит «Максимум качества — точнее всех», и это правда
 * только на сильном процессоре. На 4 ГБ и двух ядрах 547 МБ модель считает
 * фразу десятками секунд, диктовка становится невыносимой, а точность по факту
 * падает: человек ждёт, поправляет и перестаёт пользоваться. Приложение знает
 * ядра и память — значит может сказать это словами до того, как человек
 * разочаруется.
 *
 * Правило простое и объяснимое, без «баллов производительности»:
 *  - меньше 6 ГБ памяти или 2 ядра — режим «Быстро» (60 МБ);
 *  - до 10 ГБ или до 4 ядер — «Сбалансированно» (190 МБ);
 *  - остальное — «Максимум качества» допустим.
 *
 * Модель не переключается втихую: у человека может быть причина считать именно
 * этой. Показываем вывод и кнопку.
 */

import { MODEL_TIERS, tierForModel } from './modelTiers.js';

/** Ниже этой памяти «Максимум качества» — самообман, а не точность. */
export const MEMORY_LOW_GB = 6;
/** Ниже этой памяти «Сбалансированно» ещё уместен. */
export const MEMORY_MID_GB = 10;

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * Какой режим уместен на этой машине.
 * @param {{ramGb?: number, cpus?: number}} hardware
 * @returns {{tier: object|null, why: string}}
 */
export function recommendTier({ ramGb = 0, cpus = 0 } = {}) {
  const ram = num(ramGb);
  const cores = num(cpus);
  // Нет данных о железе — не гадаем и не советуем: пусть решает замер.
  if (!ram && !cores) {
    return { tier: null, why: 'Приложение ещё не знает параметры этой машины.' };
  }
  const parts = [];
  if (ram) parts.push(`${ram} ГБ памяти`);
  if (cores) parts.push(`${cores} ${cores === 1 ? 'ядро' : cores < 5 ? 'ядра' : 'ядер'}`);
  const hardware = parts.join(' и ');

  if ((ram && ram < MEMORY_LOW_GB) || (cores && cores <= 2)) {
    return {
      tier: MODEL_TIERS.find((t) => t.id === 'fast') || MODEL_TIERS[0],
      why: `${hardware}: большая модель здесь считает медленнее, чем вы говорите.`,
    };
  }
  if ((ram && ram < MEMORY_MID_GB) || (cores && cores <= 4)) {
    return {
      tier: MODEL_TIERS.find((t) => t.id === 'balanced') || MODEL_TIERS[1],
      why: `${hardware}: «Сбалансированно» успевает, а «Максимум качества» уже нет.`,
    };
  }
  return {
    tier: MODEL_TIERS.find((t) => t.id === 'max') || MODEL_TIERS[MODEL_TIERS.length - 1],
    why: `${hardware}: запас есть, «Максимум качества» уместен.`,
  };
}

/**
 * Что сказать про текущий выбор модели.
 * @param {{current?: string, downloaded?: boolean, ramGb?: number, cpus?: number}} opts
 * @returns {{level: 'ok'|'warn'|'unknown', title: string, hint: string,
 *   switchTo: string, switchLabel: string, recommended: object|null}}
 */
export function fitVerdict({ current = '', downloaded = false, ramGb = 0, cpus = 0 } = {}) {
  const { tier, why } = recommendTier({ ramGb, cpus });
  if (!tier) {
    return {
      level: 'unknown',
      title: 'Пока не знаю параметры этой машины',
      hint: why,
      switchTo: '',
      switchLabel: '',
      recommended: null,
    };
  }
  const currentTier = tierForModel(current);
  if (currentTier?.id === tier.id) {
    return {
      level: 'ok',
      title: `Модель подходит этой машине: «${tier.label}»`,
      hint: why,
      switchTo: '',
      switchLabel: '',
      recommended: tier,
    };
  }
  // Текущая легче рекомендованной — переключать вверх не наше дело: человек
  // мог выбрать «Быстро» осознанно.
  const order = MODEL_TIERS.map((t) => t.id);
  const currentIndex = currentTier ? order.indexOf(currentTier.id) : -1;
  const recommendedIndex = order.indexOf(tier.id);
  if (currentTier && currentIndex >= 0 && currentIndex <= recommendedIndex) {
    return {
      level: 'ok',
      title: `Модель не тяжелее, чем нужно: «${currentTier.label}»`,
      hint: `${why} Если хочется точнее — можно попробовать «${tier.label}».`,
      switchTo: '',
      switchLabel: '',
      recommended: tier,
    };
  }
  return {
    level: 'warn',
    title: `Для этой машины лучше «${tier.label}»`,
    hint: `Сейчас выбрано «${currentTier?.label || current || 'неизвестно'}». ${why}`,
    switchTo: tier.model,
    switchLabel: downloaded
      ? `Переключить на «${tier.label}» — ${tier.size}`
      : `«${tier.label}» ещё не скачана — откройте каталог ниже`,
    recommended: tier,
  };
}
