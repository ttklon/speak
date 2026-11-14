/** Быстрые константы, зависящие от окружения. */

import { engineName } from './recognition/engine.js';

export const ENGINE_LABEL = engineName();

export const IS_ELECTRON =
  typeof window !== 'undefined' && Boolean(window.zspeakly?.isElectron);
