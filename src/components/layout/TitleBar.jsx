import { Maximize2, Minus, X } from 'lucide-react';
import { isElectron } from '../../lib/storage.js';

export default function TitleBar({ title = 'ZSpeakly' }) {
  const wc = window.zspeakly?.window;

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
        <button type="button" className="win-btn" onClick={() => wc.toggleMaximize()} aria-label="Развернуть">
          <Maximize2 size={12} strokeWidth={1.6} />
        </button>
        <button type="button" className="win-btn win-btn--close" onClick={() => wc.close()} aria-label="Закрыть">
          <X size={14} strokeWidth={1.6} />
        </button>
      </div>
    </div>
  );
}
