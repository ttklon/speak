import { useMemo, useState } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import { useAppData } from '../state/AppDataProvider.jsx';
import { useToast } from '../state/ToastProvider.jsx';
import { Button, SearchInput, Tabs } from '../components/ui/Controls.jsx';
import Modal from '../components/ui/Modal.jsx';
import { Toggle } from '../components/ui/Toggle.jsx';
import { dayLabel } from '../lib/utils.js';

export default function DictionaryPage() {
  const { dictionary, addDictionaryWord, removeDictionaryWord, settings, updateSettings } = useAppData();
  const { push } = useToast();
  const [tab, setTab] = useState('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [word, setWord] = useState('');
  const [pron, setPron] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = dictionary;
    if (q) list = list.filter((d) => d.word.toLowerCase().includes(q));
    if (tab === 'with-pron') list = list.filter((d) => d.pronunciation);
    if (tab === 'without-pron') list = list.filter((d) => !d.pronunciation);
    return list;
  }, [dictionary, query, tab]);

  const submit = () => {
    // слово уже есть — добавление заменит его, поэтому и сообщение другое
    const exists = dictionary.some((w) => w.word.toLowerCase() === word.trim().toLowerCase());
    const entry = addDictionaryWord(word, pron);
    if (entry) {
      push({
        title: exists ? 'Слово обновлено' : 'Слово добавлено',
        description: exists ? `${entry.word} — уже было в словаре` : entry.word,
        tone: 'success',
      });
      setWord('');
      setPron('');
      setOpen(false);
    }
  };

  return (
    <div className="page scroll-area">
      <div className="page__head">
        <div>
          <h1 className="page__title">Словарь</h1>
          <p className="page__sub">
            Добавляйте термины, которые ZSpeakly часто распознаёт неправильно: имена, названия компаний,
            техническую терминологию. Словарь подмешивается в промпт распознавания и в постобработку.
          </p>
        </div>
        <div className="page__actions">
          <Button variant="ghost" size="sm" icon={<Plus size={13} />} onClick={() => setOpen(true)}>
            Добавить
          </Button>
        </div>
      </div>

      <div className="dict-toolbar">
        <Tabs
          variant="underline"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'all', label: 'Все', count: dictionary.length },
            { id: 'with-pron', label: 'С произношением', count: dictionary.filter((d) => d.pronunciation).length },
            {
              id: 'without-pron',
              label: 'Без произношения',
              count: dictionary.filter((d) => !d.pronunciation).length,
            },
          ]}
        />
        <SearchInput value={query} onChange={setQuery} placeholder="Поиск" icon={<Search size={12} />} />
      </div>

      {filtered.length === 0 ? (
        <div className="dict-empty">
          <p>
            Слов пока нет. Добавьте термины, которые часто распознаются неправильно, например имена или
            техническую терминологию.
          </p>
          <Button variant="white" size="sm" icon={<Plus size={13} />} onClick={() => setOpen(true)}>
            Добавить слово
          </Button>
        </div>
      ) : (
        <div className="dict-list">
          {filtered.map((entry) => (
            <div key={entry.id} className="dict-row">
              <span className="dict-row__word">{entry.word}</span>
              <span className="dict-row__pron">{entry.pronunciation || '—'}</span>
              <span className="dict-row__date">{dayLabel(entry.createdAt)}</span>
              <button
                type="button"
                className="icon-btn icon-btn--sm icon-btn--danger"
                onClick={() => {
                  removeDictionaryWord(entry.id);
                  // слово можно вернуть: список ведётся вручную и терять его жалко
                  push({
                    title: 'Слово удалено',
                    description: entry.word,
                    tone: 'warn',
                    ttl: 8000,
                    action: {
                      label: 'Вернуть',
                      onClick: () => addDictionaryWord(entry.word, entry.pronunciation),
                    },
                  });
                }}
                aria-label="Удалить"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="dict-settings">
        <div className="setting-row">
          <div className="setting-row__label">
            Применять словарь при диктовке
            <div className="setting-row__desc">
              Исправляет распознанный текст: «зи спикли» → «ZSpeakly».
            </div>
          </div>
          <Toggle
            checked={settings.dictionaryEnabled !== false}
            onChange={(v) => updateSettings({ dictionaryEnabled: v })}
          />
        </div>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Добавить в словарь"
        width={420}
        footer={
          <>
            <Button variant="bare" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button variant="white" onClick={submit} disabled={!word.trim()}>
              Добавить
            </Button>
          </>
        }
      >
        <div className="stack-12">
          <div className="field">
            <label className="field__label" htmlFor="dict-word">
              Новое слово
            </label>
            <input
              id="dict-word"
              className="input"
              data-autofocus
              value={word}
              placeholder="Например: Алтайтара"
              onChange={(e) => setWord(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="dict-pron">
              Произношение <span className="opt">необязательно</span>
            </label>
            <input
              id="dict-pron"
              className="input"
              value={pron}
              placeholder="алтай-тара"
              onChange={(e) => setPron(e.target.value)}
            />
            <span className="field__hint">Помогает распознаванию, если слово звучит иначе, чем пишется.</span>
          </div>
        </div>
      </Modal>
    </div>
  );
}
