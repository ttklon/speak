/** Плавающий индикатор записи: «Слушаю…» с пульсацией уровня микрофона. */

import { useEffect, useRef } from 'react';
import { Mic, Square, X } from 'lucide-react';
import { useDictation } from '../../state/DictationProvider.jsx';
import { useAppData } from '../../state/AppDataProvider.jsx';

export default function DictationHUD() {
  const { state, draft, level, elapsed, stop, setHudOpen, error } = useDictation();
  const { settings } = useAppData();
  // настройка «Плавающий индикатор записи»: выключили — плашки нет,
  // но ошибки показываем всегда, иначе человек не поймёт, почему тишина
  const indicatorOn = settings.showFloatingIndicator !== false;
  // Ошибку показываем даже при выключенном индикаторе и после остановки —
  // иначе «ничего не произошло» и понять причину невозможно.
  // Если пользователь сам скрыл плашку, она не всплывает обратно на каждом
  // такте уровня; новая ошибка всё равно открывает её.
  const open = Boolean(error) || ((state === 'listening' || state === 'processing') && indicatorOn);
  const meterRef = useRef(null);

  useEffect(() => {
    if (!meterRef.current) return;
    meterRef.current.style.setProperty('--level', String(level));
  }, [level]);

  if (!open) return null;
  const seconds = (elapsed / 1000).toFixed(1);
  const idle = state !== 'listening' && state !== 'processing';

  return (
    <div className="hud" role="status" aria-live="polite">
      <div className="hud__pulse" ref={meterRef}>
        <span className="hud__ring" />
        <span className="hud__ring hud__ring--2" />
        <span className="hud__dot" />
      </div>
      <div className="hud__body">
        <div className="hud__title">
          {idle ? 'Запись остановлена' : state === 'processing' ? 'Транскрибирую…' : 'Слушаю…'}
          {idle ? null : <span className="hud__time">{seconds} с</span>}
        </div>
        <div className="hud__text">
          {draft ? (
            <span className="hud__draft">{draft}</span>
          ) : (
            <span className="hud__hint">
              {idle ? 'Причина — ниже. Запись не идёт.' : 'Говорите — текст появится здесь'}
            </span>
          )}
        </div>
      </div>
      <div className="hud__actions">
        {state === 'listening' ? (
          <button type="button" className="hud__btn" onClick={stop} aria-label="Остановить запись">
            <Square size={11} fill="currentColor" />
          </button>
        ) : (
          <span className="hud__btn hud__btn--ghost" aria-hidden="true">
            {idle && error ? <X size={12} /> : <Mic size={12} />}
          </span>
        )}
        <button
          type="button"
          className="hud__btn hud__btn--ghost"
          onClick={() => setHudOpen(false)}
          aria-label="Скрыть"
        >
          <X size={12} />
        </button>
      </div>
      <div className="hud__meter" aria-hidden>
        {Array.from({ length: 28 }).map((_, i) => (
          <span key={i} className="hud__bar" style={{ '--i': i }} />
        ))}
      </div>
      {error ? (
        <div className="hud__error">
          <strong>{error.title}</strong>
          {error.hint ? <span className="hud__error-hint">{error.hint}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
