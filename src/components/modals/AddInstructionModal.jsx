import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { Button, Keys } from '../ui/Controls.jsx';
import ShortcutRecorder from './ShortcutRecorder.jsx';
import { keysLabel } from '../../lib/utils.js';

/** Модалка «Добавить новую инструкцию» — как в видео (кадр 320s). */
export default function AddInstructionModal({ open, onClose, onSave }) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [description, setDescription] = useState('');
  const [keys, setKeys] = useState([]);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle('');
      setPrompt('');
      setDescription('');
      setKeys([]);
      setRecording(false);
    }
  }, [open]);

  const canSave = title.trim() && prompt.trim();

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Добавить новую инструкцию"
        width={500}
        footer={
          <>
            <Button variant="bare" onClick={onClose}>
              Отмена
            </Button>
            <Button
              variant="white"
              disabled={!canSave}
              onClick={() => onSave({ title, prompt, description, keys })}
            >
              Добавить
            </Button>
          </>
        }
      >
        <div className="stack-12">
          <div className="field">
            <label className="field__label" htmlFor="instr-title">
              Название<span className="req">*</span>
            </label>
            <input
              id="instr-title"
              className="input"
              data-autofocus
              placeholder="Новая инструкция"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="instr-prompt">
              Инструкция (AI-промпт)<span className="req">*</span>
            </label>
            <span className="field__hint">
              AI-промпт, который будет использоваться для обработки выделенного текста.
            </span>
            <textarea
              id="instr-prompt"
              className="textarea"
              placeholder="Введите ваш AI-промпт здесь…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
            />
          </div>

          <div className="field">
            <span className="field__label">Сочетание клавиш</span>
            {keys.length ? (
              <div className="instr-combo">
                <Keys keys={keys} size="md" onRemove={() => setKeys([])} />
                <span className="field__hint">{keysLabel(keys)}</span>
              </div>
            ) : (
              <button type="button" className="instr-add-combo" onClick={() => setRecording(true)}>
                <Plus size={11} /> Записать сочетание клавиш
              </button>
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="instr-desc">
              Описание <span className="opt">Краткое описание, отображается в списке инструкций</span>
            </label>
            <input
              id="instr-desc"
              className="input"
              placeholder="Опишите, что делает эта инструкция…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
      </Modal>

      <ShortcutRecorder
        open={recording}
        onClose={() => setRecording(false)}
        onCapture={(next) => {
          setKeys(next);
          setRecording(false);
        }}
      />
    </>
  );
}
