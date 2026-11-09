/** Быстрые константы, зависящие от окружения. */

import { engineName, hasNativeStt, hasWebSpeech } from './recognition/engine.js';

export const ENGINE_LABEL = engineName();

export const HAS_NATIVE = hasNativeStt();
export const HAS_WEB_SPEECH = hasWebSpeech;

export const IS_ELECTRON =
  typeof window !== 'undefined' && Boolean(window.zspeakly?.isElectron);

export const PLATFORM =
  typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || '')
    ? 'Windows'
    : typeof navigator !== 'undefined'
      ? navigator.platform || 'Browser'
      : 'unknown';
