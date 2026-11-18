/**
 * Живая расшифровка: включать её или нет — решает приложение, а не человек.
 *
 * Черновик по ходу речи — это дополнительный проход движка каждые 2,5 секунды.
 * На быстрой модели он стоит копейки и делает диктовку приятнее: текст
 * появляется, пока человек ещё говорит. На «Сбалансированно» и «Максимуме» тот
 * же проход отбирает процессор у готового текста, и человек ждёт дольше — ровно
 * та жалоба, из-за которой живая расшифровка когда-то была выключена по
 * умолчанию для всех.
 *
 * Поэтому правило простое и проверяемое:
 *   - есть локальный движок (в браузере черновика не бывает);
 *   - движок считает минимум в шесть раз быстрее речи — тогда лишний проход
 *     укладывается в доли секунды;
 *   - если человек всё же выбрал руками (старые профили: true/false), его выбор
 *     уважается — автотюн не переключает чужие решения.
 *
 * Модуль чистый: его проверяют vitest и смоук.
 */

import { realtimeFactor } from './modelTiers.js';

/** Во сколько раз движок должен быть быстрее речи, чтобы тянуть черновик. */
export const LIVE_DRAFT_MIN_FACTOR = 6;

/**
 * @param {{ setting?: boolean|string, model?: string, hasNative?: boolean, factor?: number }} p
 * @returns {{ enabled: boolean, explicit: boolean, factor: number, why: string }}
 */
export function resolveLiveDraft({ setting, model = '', hasNative = true, factor } = {}) {
  const explicit = setting === true || setting === false;
  const speed = Number.isFinite(Number(factor)) && Number(factor) > 0 ? Number(factor) : realtimeFactor(model);
  if (!hasNative) {
    return {
      enabled: false,
      explicit,
      factor: speed,
      why: 'живой черновик работает только с локальным движком распознавания',
    };
  }
  if (explicit) {
    return {
      enabled: setting === true,
      explicit: true,
      factor: speed,
      why: setting === true ? 'включена вручную' : 'выключена вручную',
    };
  }
  const enabled = speed >= LIVE_DRAFT_MIN_FACTOR;
  return {
    enabled,
    explicit: false,
    factor: speed,
    why: enabled
      ? `включена сама: движок считает в ${Math.round(speed)} раз быстрее речи и успевает ещё и черновик`
      : 'выключена сама: на этом режиме черновик занял бы процессор у готового текста',
  };
}

export default { resolveLiveDraft, LIVE_DRAFT_MIN_FACTOR };
