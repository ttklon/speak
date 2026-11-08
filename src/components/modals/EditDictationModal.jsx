import { useEffect, useState } from 'react';
import { Check, GraduationCap } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { Button } from '../ui/Controls.jsx';
import { useAppData } from '../../state/AppDataProvider.jsx';
import { useToast } from '../../state/ToastProvider.jsx';
import { learnFromEdit } from '../../lib/dictionary/learn.js';
import { dayLabel, timeHM } from '../../lib/utils.js';

/**
 * Правка расшифровки. После сохранения ZSpeakly сам предлагает добавить
 * исправленные слова в словарь — ровно тот сценарий, что автор видео показал
 * на «зелёнке».
 */
export default function EditDictationModal({ open, item, onClose }) {
  const { dictionary, addDictionaryWord, updateDictation } = useAppData();
  const { push } = useToast();
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => {
    if (!open) return;
    setText(item?.text || '');
    setSuggestions([]);
  }, [open, item]);

  const save = () => {
    const next = text.trim();
    if (item && next && next !== item.text) updateDictation(item.id, { text: next });
    if (item && next !== item.text) {
      const found = learnFromEdit(item.text, next, dictionary);
      if (found.length) {
        setSuggestions(found);
        return;
      }
      push({ title: 'Расшифровка обновлена', tone: 'success' });
    }
    onClose?.();
  };

  const addAll = () => {
    suggestions.forEach((s) => addDictionaryWord(s.word, s.pronunciation));
    push({
      title: 'Добавлено в словарь',
      description: suggestions.map((s) => s.word).join(', '),
      tone: 'success',
    });
    onClose?.();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Правка расшифровки"
      subtitle={item ? `${dayLabel(item.createdAt)}, ${timeHM(item.createdAt)}` : ''}
      width={520}
      footer={
        suggestions.length ? (
          <>
            <Button variant="bare" onClick={onClose}>
              Позже
            </Button>
            <Button variant="white" icon={<Check size={13} />} onClick={addAll}>
              Добавить {suggestions.length > 1 ? `${suggestions.length} слова` : 'слово'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="bare" onClick={onClose}>
              Отмена
            </Button>
            <Button variant="white" onClick={save}>
              Сохранить
            </Button>
          </>
        )
      }
    >
      <div className="stack-12">
        <textarea
          className="input edit-dictation"
          data-autofocus
          rows={7}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {suggestions.length ? (
          <div className="learn-card">
            <div className="learn-card__head">
              <GraduationCap size={14} />
              <span>Добавить в словарь, чтобы больше не распознавалось с ошибкой?</span>
            </div>
            <ul className="learn-card__list">
              {suggestions.map((s) => (
                <li key={s.word}>
                  <b>{s.word}</b>
                  <span className="muted"> ← {s.pronunciation}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="field__hint">
            Исправили ошибку распознавания? ZSpeakly запомнит слово и предложит добавить его в словарь.
          </p>
        )}
      </div>
    </Modal>
  );
}
