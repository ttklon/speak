import { useMemo, useState } from 'react';
import { Keyboard, Plus, RefreshCw, Trash2 } from 'lucide-react';
import Icon from '../components/ui/Icon.jsx';
import { Button, Keys, SearchInput, Tabs } from '../components/ui/Controls.jsx';
import { Toggle } from '../components/ui/Toggle.jsx';
import ShortcutRecorder from '../components/modals/ShortcutRecorder.jsx';
import AddInstructionModal from '../components/modals/AddInstructionModal.jsx';
import { useAppData } from '../state/AppDataProvider.jsx';
import { useToast } from '../state/ToastProvider.jsx';
import { keysLabel, toAccelerator } from '../lib/utils.js';

export default function HotkeysPage() {
  const {
    settings,
    updateSettings,
    voiceHotkeys,
    toggleHotkey,
    updateHotkey,
    resetHotkeys,
    presets,
    togglePreset,
    updatePresetKeys,
    instructions,
    addInstruction,
    removeInstruction,
    updateInstruction,
  } = useAppData();
  const { push } = useToast();
  const [tab, setTab] = useState('voice');
  const [recorder, setRecorder] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState('');

  /** Сохраняет сочетание: локально, в настройки и в глобальные хоткеи Electron. */
  const applyCombo = (hk, keys) => {
    if (!keys?.length) return;
    if (hk.id === 'dictation') {
      updateSettings({ dictationKeys: keys, dictationKey: toAccelerator(keys) });
      window.zspeakly?.native?.setDictationHotkey?.(toAccelerator(keys));
    }
    updateHotkey(hk.id, { keys });
    push({ title: 'Сочетание обновлено', description: keysLabel(keys), tone: 'success' });
  };

  const filteredVoice = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return voiceHotkeys;
    return voiceHotkeys.filter(
      (h) => h.title.toLowerCase().includes(q) || h.description.toLowerCase().includes(q),
    );
  }, [voiceHotkeys, query]);

  const filteredPresets = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return presets;
    return presets.filter((p) => p.title.toLowerCase().includes(q));
  }, [presets, query]);

  const filteredCustom = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return instructions;
    return instructions.filter(
      (i) => i.title.toLowerCase().includes(q) || i.prompt.toLowerCase().includes(q),
    );
  }, [instructions, query]);

  return (
    <div className="page scroll-area">
      <div className="page__head">
        <div>
          <h1 className="page__title">Горячие клавиши</h1>
          <p className="page__sub">
            Настройте сочетания клавиш для активации ZSpeakly. Нажмите клавиши, чтобы начать запись,
            отпустите — текст подставится в активное поле.
          </p>
        </div>
        <div className="page__actions">
          <Button variant="white" size="sm" icon={<Plus size={13} />} onClick={() => setAddOpen(true)}>
            Добавить новую инструкцию
          </Button>
        </div>
      </div>

      <div className="hk-toolbar">
        <Tabs
          variant="underline"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'voice', label: 'Голосовые сочетания клавиш', count: voiceHotkeys.length },
            { id: 'recommended', label: 'Рекомендуемые горячие клавиши', count: presets.length },
            { id: 'custom', label: 'Мои горячие клавиши', count: instructions.length },
          ]}
        />
        <SearchInput value={query} onChange={setQuery} placeholder="Поиск" />
      </div>

      {tab === 'voice' ? (
        <div className="stack-8">
          {filteredVoice.map((hk) => (
            <div key={hk.id} className="hk-block">
              <div className="hk-row">
                <div className={`hk-row__icon hk-row__icon--${hk.tone || 'slate'}`}>
                  <Icon name={hk.icon || 'mic'} size={15} />
                </div>
                <div className="hk-row__body">
                  <div className="hk-row__title">
                    {hk.title}
                    {hk.isNew ? <span className="badge-new">НОВОЕ</span> : null}
                  </div>
                  <div className="hk-row__desc">{hk.description}</div>
                </div>
                <div className="hk-row__side">
                  {hk.keys?.length ? (
                    <div className="hk-row__keys">
                      <Keys
                        keys={hk.keys}
                        size="sm"
                        onRemove={() => updateHotkey(hk.id, { keys: [] })}
                      />
                      {hk.double ? <span className="sep">×2</span> : null}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="hk-row__add"
                      onClick={() =>
                        setRecorder({
                          title: `Сочетание для «${hk.title}»`,
                          onCapture: (keys) => applyCombo(hk, keys),
                        })
                      }
                    >
                      <Plus size={10} /> Записать сочетание клавиш
                    </button>
                  )}
                  <div className="hk-row__controls">
                    {hk.keys?.length ? (
                      <button
                        type="button"
                        className="hk-row__add"
                        onClick={() =>
                          setRecorder({
                            title: `Сочетание для «${hk.title}»`,
                            onCapture: (keys) => applyCombo(hk, keys),
                          })
                        }
                      >
                        <Plus size={10} /> Изменить сочетание
                      </button>
                    ) : null}
                    <Toggle checked={hk.enabled} onChange={() => toggleHotkey(hk.id)} label={hk.title} />
                  </div>
                </div>
              </div>

              {hk.id === 'screen-aware' ? (
                <div className="hk-row--sub">
                  <div className="hk-row__body">
                    <div className="hk-row__title">Стиль письма</div>
                    <div className="hk-row__desc">
                      Настроение — подключите приложение для чата, чтобы ответы звучали как вы
                    </div>
                  </div>
                  <Button
                    variant="white"
                    size="sm"
                    onClick={() =>
                      push({
                        title: 'Стиль письма',
                        description: 'Обучение стилю идёт офлайн: ZSpeakly анализирует ваши тексты локально.',
                      })
                    }
                  >
                    Подключить
                  </Button>
                </div>
              ) : null}
            </div>
          ))}

          <div className="hk-reset">
            <Button variant="bare" size="sm" icon={<RefreshCw size={12} />} onClick={resetHotkeys}>
              Сбросить все сочетания
            </Button>
          </div>
        </div>
      ) : null}

      {tab === 'recommended' ? (
        <div className="stack-8">
          <p className="hk-note">
            Готовые AI-инструкции. Выделите текст, нажмите сочетание — ZSpeakly перепишет его локально.
            Работает без интернета: правила + словарь, либо ваша локальная модель Ollama.
          </p>
          {filteredPresets.map((p) => (
            <div key={p.id} className="preset-row">
              <span className={`preset-row__dot ${p.enabled ? 'is-on' : ''}`} />
              <div className="grow">
                <div className="hk-row__title">{p.title}</div>
                <div className="hk-row__desc">{p.description}</div>
              </div>
              <div className="preset-row__keys">
                <Keys keys={p.keys || []} size="sm" />
                <button
                  type="button"
                  className="hk-row__add"
                  onClick={() =>
                    setRecorder({
                      title: `Сочетание для «${p.title}»`,
                      onCapture: (keys) => {
                        updatePresetKeys(p.id, keys);
                        push({ title: 'Сочетание обновлено', description: keysLabel(keys), tone: 'success' });
                      },
                    })
                  }
                >
                  <Plus size={10} /> Записать
                </button>
              </div>
              <Toggle checked={p.enabled} onChange={() => togglePreset(p.id)} label={p.title} />
            </div>
          ))}
        </div>
      ) : null}

      {tab === 'custom' ? (
        <div className="stack-8">
          {filteredCustom.length === 0 ? (
            <div className="empty">
              <div className="empty__icon">
                <Keyboard size={22} />
              </div>
              <div className="empty__title">Своих инструкций пока нет</div>
              <div className="empty__desc">
                Добавьте промпт и сочетание клавиш — например «Сделать формально» или «Перевести на
                английский».
              </div>
              <div className="empty__action">
                <Button variant="white" size="sm" icon={<Plus size={13} />} onClick={() => setAddOpen(true)}>
                  Добавить инструкцию
                </Button>
              </div>
            </div>
          ) : (
            filteredCustom.map((item) => (
              <div key={item.id} className="preset-row">
                <span className={`preset-row__dot ${item.enabled ? 'is-on' : ''}`} />
                <div className="grow">
                  <div className="hk-row__title">{item.title}</div>
                  <div className="hk-row__desc">
                    {item.description || item.prompt.slice(0, 90)}
                  </div>
                </div>
                {item.keys?.length ? <Keys keys={item.keys} size="sm" /> : null}
                <Toggle
                  checked={item.enabled}
                  onChange={() => updateInstruction?.(item.id, { enabled: !item.enabled })}
                  label={item.title}
                />
                <button
                  type="button"
                  className="icon-btn icon-btn--sm icon-btn--danger"
                  onClick={() => removeInstruction(item.id)}
                  aria-label="Удалить"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}

      <ShortcutRecorder
        open={Boolean(recorder)}
        title={recorder?.title || 'Записать сочетание клавиш'}
        onClose={() => setRecorder(null)}
        onCapture={(keys) => {
          recorder?.onCapture?.(keys);
          setRecorder(null);
        }}
      />

      <AddInstructionModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSave={(data) => {
          addInstruction(data);
          push({ title: 'Инструкция добавлена', description: data.title, tone: 'success' });
          setAddOpen(false);
          setTab('custom');
        }}
      />
    </div>
  );
}
