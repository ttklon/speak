import { useMemo, useState } from 'react';
import { Plus, Search, Star, Trash2 } from 'lucide-react';
import { knownAliases } from '../lib/dictionary/aliases.js';
import { useAppData } from '../state/AppDataProvider.jsx';
import { useToast } from '../state/ToastProvider.jsx';
import { Button, SearchInput, Tabs } from '../components/ui/Controls.jsx';
import Modal from '../components/ui/Modal.jsx';
import { Toggle } from '../components/ui/Toggle.jsx';
import { dayLabel } from '../lib/utils.js';
import { SNIPPET_LIMITS, normalizePhrase, snippetExamples } from '../lib/snippets.js';
import { rankDictionary } from '../lib/dictionary/rank.js';

export default function DictionaryPage() {
  const {
    dictionary,
    addDictionaryWord,
    removeDictionaryWord,
    toggleDictionaryPin,
    snippets,
    addSnippet,
    removeSnippet,
    restoreSnippet,
    settings,
    updateSettings,
  } = useAppData();
  const { push } = useToast();
  const [tab, setTab] = useState('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [word, setWord] = useState('');
  const [pron, setPron] = useState('');
  const [pin, setPin] = useState(false);
  // Быстрые блоки: фраза-триггер и текст, который вместо неё вставляется.
  const [snipOpen, setSnipOpen] = useState(false);
  const [snipTrigger, setSnipTrigger] = useState('');
  const [snipBody, setSnipBody] = useState('');
  const snippetPhraseCounts = useMemo(() => {
    const counts = new Map();
    for (const snippet of snippets) {
      const phrase = normalizePhrase(snippet.trigger);
      counts.set(phrase, (counts.get(phrase) || 0) + 1);
    }
    return counts;
  }, [snippets]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Тот же порядок, в котором слова уходят в подсказку движку: список в
    // интерфейсе не должен врать о том, что модель увидит первым.
    let list = rankDictionary(dictionary);
    if (q) list = list.filter((d) => d.word.toLowerCase().includes(q));
    if (tab === 'with-pron') list = list.filter((d) => d.pronunciation);
    if (tab === 'without-pron') list = list.filter((d) => !d.pronunciation);
    return list;
  }, [dictionary, query, tab]);

  const submit = () => {
    // слово уже есть — добавление заменит его, поэтому и сообщение другое
    const exists = dictionary.some((w) => w.word.toLowerCase() === word.trim().toLowerCase());
    const entry = addDictionaryWord(word, pron, { pinned: pin });
    if (entry) {
      push({
        title: exists ? 'Слово обновлено' : 'Слово добавлено',
        description: exists ? `${entry.word} — уже было в словаре` : entry.word,
        tone: 'success',
      });
      setWord('');
      setPron('');
      setPin(false);
      setOpen(false);
    }
  };

  const submitSnippet = () => {
    const entry = addSnippet(snipTrigger, snipBody);
    if (!entry) return;
    push({
      title: 'Блок сохранён',
      description: `Скажите «${entry.trigger}» — вставится ваш текст`,
      tone: 'success',
    });
    setSnipTrigger('');
    setSnipBody('');
    setSnipOpen(false);
  };

  return (
    <div className="page scroll-area">
      <div className="page__head">
        <div>
          <h1 className="page__title">Словарь</h1>
          <p className="page__sub">
            Имена и термины, которые распознаются неправильно: словарь подсказывает их модели и правит
            текст после распознавания.
          </p>
        </div>
        {/* Когда слов нет, кнопка в шапке дублировала «Добавить слово» из пустого
            состояния: две кнопки об одном. */}
        {dictionary.length ? (
          <div className="page__actions">
            <Button variant="ghost" size="sm" icon={<Plus size={13} />} onClick={() => setOpen(true)}>
              Добавить
            </Button>
          </div>
        ) : null}
      </div>

      {/* Вкладки и поиск по пустому словарю — три нуля и поле, куда нечего писать */}
      {dictionary.length ? (
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
      ) : null}

      {/* Порядок списка — не декорация: подсказка движку короткая, и в неё
          попадают первые слова. Об этом лучше сказать словами. */}
      {dictionary.length ? (
        <p className="settings-note dict-order-note">
          Порядок подсказки движку: закреплённые, затем часто диктуемые, затем новые.
        </p>
      ) : null}

      {filtered.length === 0 ? (
        <div className="dict-empty">
          <p>Пока пусто. Добавьте имя или термин — и он перестанет распознаваться неправильно.</p>
          <Button variant="white" size="sm" icon={<Plus size={13} />} onClick={() => setOpen(true)}>
            Добавить слово
          </Button>
        </div>
      ) : (
        <div className="dict-list">
          {filtered.map((entry) => (
            <div key={entry.id} className="dict-row" data-pinned={entry.pinned ? '1' : '0'}>
              <button
                type="button"
                className="icon-btn icon-btn--sm dict-row__pin"
                data-on={entry.pinned ? '1' : '0'}
                aria-pressed={Boolean(entry.pinned)}
                aria-label={
                  entry.pinned ? `Открепить «${entry.word}»` : `Закрепить «${entry.word}»: будет первым в подсказке`
                }
                title={
                  entry.pinned
                    ? 'Закреплено: слово всегда идёт первым в подсказке движку'
                    : 'Закрепить: слово важнее остальных и всегда попадёт в подсказку'
                }
                onClick={() => toggleDictionaryPin(entry.id)}
              >
                <Star size={12} fill={entry.pinned ? 'currentColor' : 'none'} />
              </button>
              <span className="dict-row__word">{entry.word}</span>
              {/* Известное произношение подставляется в текст и без записи:
                  «зум» → Zoom, «телеграм» → Telegram. Показываем его, чтобы
                  человек не вписывал руками то, что приложение уже знает. */}
              <span
                className={`dict-row__pron ${entry.pronunciation ? '' : 'is-known'}`}
                title={
                  entry.pronunciation
                    ? 'Своё произношение: им заменяется слово в распознанном тексте'
                    : 'Известное произношение: подставляется в текст автоматически'
                }
              >
                {entry.pronunciation || knownAliases(entry.word)[0] || '—'}
              </span>
              {/* Частота — не украшение: по ней словарь сортируется, когда
                  закреплённых нет. «0» не показываем: это шум. */}
              <span className="dict-row__hits" title="Сколько раз слово встретилось в распознанном тексте">
                {entry.hits > 0 ? `${entry.hits}×` : ''}
              </span>
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
                      onClick: () =>
                        addDictionaryWord(entry.word, entry.pronunciation, { pinned: entry.pinned }),
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

      {/* Быстрые блоки. Лежат рядом со словарём, потому что это тоже «мои
          слова»: словарь правит написание, блок заменяет всю фразу. */}
      <div className="settings-group">
        <div className="settings-group__title">Быстрые блоки</div>
        <div className="settings-group__desc">
          Скажите фразу целиком — вместо неё вставится готовый текст: подпись, адрес, шаблон ответа.
          {snippets.length ? ` Сейчас есть: ${snippetExamples(snippets).join(', ')}.` : ''}
        </div>
        {snippets.length ? (
          <div className="snippet-list">
            {snippets.map((snippet) => (
              <div key={snippet.id} className="snippet-row">
                <div className="grow" style={{ textAlign: 'left' }}>
                  <div className="snippet-row__trigger">«{snippet.trigger}»</div>
                  {snippetPhraseCounts.get(normalizePhrase(snippet.trigger)) > 1 && (
                    <div className="field__hint">Фраза совпадает с другим блоком — диктовка не развернёт её, пока дубликат не удалён.</div>
                  )}
                  <div className="snippet-row__body">
                    {snippet.body.length > 90 ? `${snippet.body.slice(0, 90)}…` : snippet.body}
                  </div>
                  <details>
                    <summary>Показать полный текст</summary>
                    <textarea className="input" rows={5} readOnly value={snippet.body} aria-label={`Полный текст блока «${snippet.trigger}»`} />
                  </details>
                </div>
                <button
                  type="button"
                  className="icon-btn icon-btn--sm icon-btn--danger"
                  aria-label={`Удалить блок «${snippet.trigger}»`}
                  onClick={() => {
                    removeSnippet(snippet.id);
                    push({
                      title: 'Блок удалён',
                      description: snippet.trigger,
                      tone: 'warn',
                      ttl: 8000,
                      action: {
                        label: 'Вернуть',
                        onClick: () => restoreSnippet(snippet),
                      },
                    });
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="settings-note">
            Пока блоков нет. Пример: триггер «моя подпись», текст — имя, должность и телефон. Скажете
            «моя подпись» — вставится всё сразу.
          </div>
        )}
        <div className="page__actions" style={{ marginTop: 10 }}>
          <Button variant="ghost" size="sm" icon={<Plus size={13} />} onClick={() => setSnipOpen(true)}>
            Добавить блок
          </Button>
        </div>
      </div>

      <Modal
        open={snipOpen}
        onClose={() => setSnipOpen(false)}
        title="Новый быстрый блок"
        width={460}
        footer={
          <>
            <Button variant="bare" onClick={() => setSnipOpen(false)}>
              Отмена
            </Button>
            <Button variant="white" onClick={submitSnippet} disabled={!snipTrigger.trim() || !snipBody.trim()}>
              Сохранить
            </Button>
          </>
        }
      >
        <div className="stack-12">
          <div className="field">
            <label className="field__label" htmlFor="snip-trigger">
              Что сказать
            </label>
            <input
              id="snip-trigger"
              className="input"
              data-autofocus
              value={snipTrigger}
              placeholder="Например: моя подпись"
              onChange={(e) => setSnipTrigger(e.target.value)}
            />
            <span className="field__hint">
              Блок срабатывает, только если сказать эту фразу целиком и ничего больше. Не более {SNIPPET_LIMITS.trigger} символов.
            </span>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="snip-body">
              Что вставить
            </label>
            <textarea
              id="snip-body"
              className="input"
              rows={5}
              value={snipBody}
              placeholder={'С уважением,\nИван Петров\n+7 900 000-00-00'}
              onChange={(e) => setSnipBody(e.target.value)}
            />
            <span className="field__hint">Не более {SNIPPET_LIMITS.body} символов. Пробелы и переносы сохраняются.</span>
          </div>
        </div>
      </Modal>

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
          <div className="setting-row">
            <div className="setting-row__label">
              Закрепить
              <div className="setting-row__desc">
                Важное слово всегда будет первым в подсказке, даже если слов в словаре много.
              </div>
            </div>
            <Toggle checked={pin} onChange={setPin} />
          </div>
        </div>
      </Modal>
    </div>
  );
}
