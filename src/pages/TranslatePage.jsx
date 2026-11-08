import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Mic, Monitor, Search, Square, Subtitles, Volume2 } from 'lucide-react';
import { Button, EmptyState, Select } from '../components/ui/Controls.jsx';
import { useAppData } from '../state/AppDataProvider.jsx';
import { useToast } from '../state/ToastProvider.jsx';
import { LANGUAGES } from '../lib/config.js';
import { createRecognizer, langTag } from '../lib/recognition/engine.js';
import { translate } from '../lib/translate.js';
import { dayLabel, timeHM, truncate, uid } from '../lib/utils.js';

const SOURCES = [
  { value: 'mic', label: 'Микрофон' },
  { value: 'system', label: 'Система' },
  { value: 'both', label: 'Микрофон + Система' },
];

export default function TranslatePage() {
  const { settings, updateSettings, sessions, addSession } = useAppData();
  const { push } = useToast();
  const [mode, setMode] = useState('transcript');
  const [source, setSource] = useState('both');
  const [target, setTarget] = useState(settings.translateTarget || 'en');
  const [live, setLive] = useState(false);
  const [srcText, setSrcText] = useState('');
  const [dstText, setDstText] = useState('');
  const [lines, setLines] = useState([]);
  const [engine, setEngine] = useState('offline');
  const [query, setQuery] = useState('');
  const recRef = useRef(null);
  const targetRef = useRef(target);
  const sessionStart = useRef(0);
  const linesRef = useRef([]);

  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  useEffect(() => () => recRef.current?.abort?.(), []);

  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      s.lines?.some((l) => l.src.toLowerCase().includes(q) || l.dst.toLowerCase().includes(q)),
    );
  }, [sessions, query]);

  const handleSentence = async (sentence) => {
    const clean = sentence.trim();
    if (!clean) return;
    setSrcText(clean);
    const res = await translate(clean, { from: settings.language || 'ru', to: targetRef.current, settings });
    setDstText(res.text);
    setEngine(res.engine);
    const line = { id: uid('ln'), src: clean, dst: res.text, at: Date.now() };
    linesRef.current = [...linesRef.current, line].slice(-200);
    setLines(linesRef.current);
  };

  const startSession = async () => {
    setLines([]);
    linesRef.current = [];
    setSrcText('');
    setDstText('');
    setLive(true);
    sessionStart.current = Date.now();

    let stream = null;
    if (source !== 'system') {
      try {
        stream = await navigator.mediaDevices?.getUserMedia({ audio: true });
      } catch {
        push({
          title: 'Микрофон недоступен',
          description: 'Разрешите доступ в настройках Windows.',
          tone: 'warn',
        });
      }
    } else if (window.zspeakly?.native?.getSystemAudio) {
      try {
        stream = await window.zspeakly.native.getSystemAudio();
      } catch {
        push({ title: 'Системный звук недоступен', tone: 'warn' });
      }
    }

    const recognizer = createRecognizer({
      lang: langTag(settings.language),
      onPartial: ({ text, interim }) => setSrcText([text, interim].filter(Boolean).join(' ')),
      onFinal: ({ last }) => {
        if (last) handleSentence(last);
      },
    });
    recRef.current = recognizer;
    try {
      recognizer.start();
    } catch {
      push({ title: 'Не удалось запустить сессию', tone: 'warn' });
    }
    if (stream) stream.getTracks().forEach(() => {});
  };

  const stopSession = () => {
    recRef.current?.stop?.();
    recRef.current = null;
    setLive(false);
    setSrcText('');
    setDstText('');
    if (linesRef.current.length) {
      addSession({
        id: uid('sess'),
        mode,
        source,
        from: settings.language || 'ru',
        to: targetRef.current,
        startedAt: sessionStart.current || Date.now(),
        durationMs: Date.now() - (sessionStart.current || Date.now()),
        lines: linesRef.current,
      });
      push({ title: 'Сессия сохранена', description: `${linesRef.current.length} реплик`, tone: 'success' });
    }
  };

  const exportSession = (session) => {
    const body = [
      `# Живой перевод · ${new Date(session.startedAt).toLocaleString('ru-RU')}`,
      `${session.from} → ${session.to}`,
      '',
      ...session.lines.map((l) => `- ${l.src}\n  → ${l.dst}`),
    ].join('\n');
    const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `translate-${session.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const previewDst = mode === 'subtitles' ? truncate(dstText, 88) : dstText;

  return (
    <div className="page scroll-area">
      <div className="page__head">
        <div>
          <h1 className="page__title">Живой перевод</h1>
          <p className="page__sub">Речь транскрибируется и переводится в реальном времени.</p>
        </div>
      </div>

      <div className="trans-mode">
        <button
          type="button"
          className={`trans-mode__card ${mode === 'transcript' ? 'is-active' : ''}`}
          onClick={() => setMode('transcript')}
        >
          <span className="trans-mode__icon">
            <Mic size={14} />
          </span>
          <span>
            <span className="trans-mode__title">Транскрипт</span>
            <span className="trans-mode__desc">Читайте в ZSpeakly. Для одних встреч.</span>
          </span>
        </button>
        <button
          type="button"
          className={`trans-mode__card ${mode === 'subtitles' ? 'is-active' : ''}`}
          onClick={() => setMode('subtitles')}
        >
          <span className="trans-mode__icon">
            <Subtitles size={14} />
          </span>
          <span>
            <span className="trans-mode__title">Субтитры</span>
            <span className="trans-mode__desc">Поверх любого приложения. Для Zoom или видео.</span>
          </span>
        </button>
      </div>

      <div className="trans-settings">
        <div className="setting-row">
          <div className="setting-row__label">Источник</div>
          <Select
            value={source}
            onChange={setSource}
            options={SOURCES}
            width={180}
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">Перевести на</div>
          <Select
            value={target}
            onChange={(v) => {
              setTarget(v);
              updateSettings({ translateTarget: v });
            }}
            options={LANGUAGES.map((l) => ({ value: l.id, label: l.native }))}
            width={180}
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">
            Движок перевода
            <div className="setting-row__desc">
              Офлайн-словарь и правила работают всегда. Для свободных фраз подключите локальную модель Ollama.
            </div>
          </div>
          <span className="setting-row__value">{engine === 'llm' ? 'локальная модель' : 'офлайн-словарь'}</span>
        </div>
      </div>

      <button type="button" className={`trans-start ${live ? 'is-live' : ''}`} onClick={live ? stopSession : startSession}>
        {live ? <Square size={13} fill="currentColor" /> : <Mic size={14} />}
        {live ? 'Остановить сессию' : 'Начать сессию'}
      </button>

      {live ? <div className="trans-progress"><span style={{ width: '68%' }} /></div> : null}

      {live || srcText ? (
        <div className="trans-live">
          <div className="trans-live__row">
            <span className="trans-live__tag">RU</span>
            <span>{srcText || <span className="muted">Говорите…</span>}</span>
          </div>
          <div className="trans-live__row" style={{ marginTop: 6 }}>
            <span className="trans-live__tag trans-live__tag--dst">{target.toUpperCase()}</span>
            <span className="trans-live__dst">{previewDst || <span className="muted">Перевод появится здесь…</span>}</span>
            {dstText ? (
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                onClick={() => {
                  navigator.clipboard?.writeText(dstText);
                  push({ title: 'Перевод скопирован', tone: 'success' });
                }}
                aria-label="Скопировать"
              >
                <Volume2 size={12} />
              </button>
            ) : null}
          </div>
          {mode === 'subtitles' ? (
            <div className="trans-subtitle">
              <Subtitles size={13} /> Окно субтитров будет закреплено поверх приложений в Electron-сборке.
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="section-head" style={{ marginTop: 20 }}>
        <h2 className="section-head__title">История</h2>
        <label className="search-input" style={{ width: 168 }}>
          <Search size={12} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по сессиям"
          />
        </label>
      </div>

      {filteredSessions.length === 0 ? (
        <EmptyState
          title={query ? `Для «${query}» результатов не найдено` : 'Пока нет сессий живого перевода'}
          description={
            query
              ? 'Попробуйте другой запрос.'
              : 'Нажмите «Начать сессию», и каждая реплика появится здесь с переводом.'
          }
          compact
        />
      ) : (
        <div className="stack-8">
          {filteredSessions.map((session) => (
            <div key={session.id} className="trans-session">
              <div className="trans-session__head">
                <span className="trans-session__title">
                  {LANGUAGES.find((l) => l.id === session.from)?.native || session.from} →{' '}
                  {LANGUAGES.find((l) => l.id === session.to)?.native || session.to}
                </span>
                <span className="trans-session__meta">
                  {dayLabel(session.startedAt)}, {timeHM(session.startedAt)}
                </span>
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => exportSession(session)}
                  aria-label="Экспорт"
                >
                  <Download size={12} />
                </button>
              </div>
              {session.lines.slice(0, 6).map((line) => (
                <div key={line.id} className="trans-line">
                  <span className="trans-line__time">{timeHM(line.at)}</span>
                  <span>
                    <span className="trans-line__src">{line.src}</span>
                    <br />
                    <span className="trans-line__dst">{line.dst}</span>
                  </span>
                </div>
              ))}
              {session.lines.length > 6 ? (
                <div className="muted" style={{ fontSize: 9.5, marginTop: 4 }}>
                  ещё {session.lines.length - 6} реплик
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {mode === 'subtitles' && !live ? (
        <div className="notice notice--info" style={{ marginTop: 16 }}>
          <span className="notice__icon"><Monitor size={13} /></span>
          <span>
            «Субтитры» показывают перевод отдельным окном поверх других приложений. В браузерной
            версии это превью; в установленном ZSpeakly окно создаётся системой.
          </span>
        </div>
      ) : null}
    </div>
  );
}
