/** Тосты — всплывающие подтверждения внизу окна (как системные уведомления ZSpeakly). */

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Check, Info, TriangleAlert, X } from 'lucide-react';

const ToastContext = createContext(null);

let seq = 0;

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);

  const dismiss = useCallback((id) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (toast) => {
      seq += 1;
      const id = `t_${seq}`;
      const item = typeof toast === 'string' ? { title: toast } : { ...toast, id };
      setItems((prev) => [...prev.slice(-3), { ...item, id }]);
      const ttl = item.ttl ?? 3200;
      if (ttl > 0) setTimeout(() => dismiss(id), ttl);
      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone || 'default'}`}>
            <span className="toast__icon">
              {t.tone === 'success' ? (
                <Check size={14} strokeWidth={2.4} />
              ) : t.tone === 'warn' ? (
                <TriangleAlert size={14} strokeWidth={2.2} />
              ) : (
                <Info size={14} strokeWidth={2.2} />
              )}
            </span>
            <div className="toast__body">
              <div className="toast__title">{t.title}</div>
              {t.description ? <div className="toast__desc">{t.description}</div> : null}
            </div>
            <button type="button" className="toast__close" onClick={() => dismiss(t.id)} aria-label="Закрыть">
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

export default ToastProvider;
