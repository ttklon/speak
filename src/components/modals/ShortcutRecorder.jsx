import { useEffect, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import { Button } from '../ui/Controls.jsx';
import { captureCombo, isComboComplete, keysLabel } from '../../lib/utils.js';

/** Модалка «Записать сочетание клавиш» — как «+ Добавить сочетание» в видео. */
export default function ShortcutRecorder({ open, onClose, onCapture, title = 'Записать сочетание клавиш' }) {
  const [combo, setCombo] = useState([]);

  useEffect(() => {
    if (open) setCombo([]);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        onClose?.();
        return;
      }
      if (e.key === 'Enter' && isComboComplete(combo)) {
        onCapture?.(combo);
        return;
      }
      const next = captureCombo(e);
      if (next.length) setCombo(next);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, combo, onCapture, onClose]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      subtitle="Нажмите нужную комбинацию. Enter — сохранить, Esc — отмена."
      width={400}
      footer={
        <>
          <Button variant="bare" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="white" disabled={!isComboComplete(combo)} onClick={() => onCapture?.(combo)}>
            Сохранить
          </Button>
        </>
      }
    >
      <div className="combo-capture">
        <div className={`combo-capture__box ${combo.length ? 'is-filled' : ''}`}>
          {combo.length ? (
            <span className="keys keys--lg">
              {combo.map((k) => (
                <span key={k} className="key">
                  {k}
                </span>
              ))}
            </span>
          ) : (
            <span className="combo-capture__hint">Нажмите сочетание…</span>
          )}
        </div>
        <div className="combo-capture__caption">
          {combo.length ? keysLabel(combo) : 'Например Ctrl + Alt + Space'}
        </div>
      </div>
    </Modal>
  );
}
