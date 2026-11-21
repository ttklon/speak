import { useEffect, useState } from 'react';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { isElectron } from '../../lib/storage.js';

export default function TitleBar({ title = 'ZSpeakly' }) {
  const wc = window.zspeakly?.window;
  // Развёрнуто ли окно: приложение может открыться уже развёрнутым (оно
  // помнит это состояние), и тогда иконка «Развернуть» врёт — по ней нельзя
  // вернуть окно в прежний размер.
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    // Спрашиваем состояние один раз при появлении: событие maximize могло
    // случиться раньше, чем мост был готов слушать.
    let alive = true;
    Promise.resolve(wc?.state?.())
      .then((state) => {
        if (alive) setMaximized(Boolean(state?.maximized));
      })
      .catch(() => {});
    const off = wc?.onMaximized?.((value) => setMaximized(Boolean(value)));
    return () => {
      alive = false;
      try {
        off?.();
      } catch {
        /* окно уже закрыто */
      }
    };
  }, [wc]);

  if (!isElectron() || !wc) {
    return (
      <div className="titlebar titlebar--browser">
        <div className="titlebar__drag">
          <span className="titlebar__title">{title}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="titlebar">
      <div className="titlebar__drag" onDoubleClick={() => wc.toggleMaximize()}>
        <span className="titlebar__title">{title}</span>
      </div>
      <div className="titlebar__controls">
        <button type="button" className="win-btn" onClick={() => wc.minimize()} aria-label="Свернуть">
          <Minus size={14} strokeWidth={1.6} />
        </button>
        <button
          type="button"
          className="win-btn"
          onClick={() => wc.toggleMaximize()}
          aria-label={maximized ? 'Восстановить окно' : 'Развернуть'}
          title={maximized ? 'Восстановить окно' : 'Развернуть'}
        >
          {maximized ? <Minimize2 size={12} strokeWidth={1.6} /> : <Maximize2 size={12} strokeWidth={1.6} />}
        </button>
        <button type="button" className="win-btn win-btn--close" onClick={() => wc.close()} aria-label="Закрыть">
          <X size={14} strokeWidth={1.6} />
        </button>
      </div>
    </div>
  );
}
