import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CalendarPlus,
  CheckCircle2,
  Circle,
  Download,
  FileAudio,
  Mic,
  Square,
  Upload,
  Wand2,
} from 'lucide-react';
import { Button } from '../components/ui/Controls.jsx';
import Modal from '../components/ui/Modal.jsx';
import { useAppData } from '../state/AppDataProvider.jsx';
import { useToast } from '../state/ToastProvider.jsx';
import { createLevelMeter, msToClock } from '../lib/audio/devices.js';
import { createRecognizer, langTag } from '../lib/recognition/engine.js';
import { OPS } from '../lib/ai/textops.js';
import { summarizeTranscript } from '../lib/ai/summarizer.js';
import { dayLabel, timeHM, uid, words } from '../lib/utils.js';

export default function MeetingsPage() {
  const { meetingNotes, addMeetingNote, updateMeetingNote, removeMeetingNote, settings } = useAppData();
  const { push } = useToast();
  const [activeId, setActiveId] = useState(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [liveLines, setLiveLines] = useState([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const recRef = useRef(null);
  const meterRef = useRef(null);
  const streamRef = useRef(null);
  const startedAt = useRef(0);
  const liveRef = useRef([]);

  const active = useMemo(() => meetingNotes.find((n) => n.id === activeId), [meetingNotes, activeId]);

  useEffect(() => {
    if (!recording) return undefined;
    const t = setInterval(() => setElapsed(Date.now() - startedAt.current), 200);
    return () => clearInterval(t);
  }, [recording]);

  useEffect(() => () => {
    recRef.current?.abort?.();
    meterRef.current?.dispose?.();
    streamRef.current?.getTracks?.().forEach((t) => t.stop());
  }, []);

  const startRecording = async () => {
    setLiveLines([]);
    liveRef.current = [];
    startedAt.current = Date.now();
    setElapsed(0);
    setRecording(true);

    try {
      const stream = await navigator.mediaDevices?.getUserMedia({ audio: true });
      streamRef.current = stream;
      meterRef.current = await createLevelMeter(stream);
      const meterTimer = setInterval(() => setLevel(meterRef.current?.level?.() || 0), 120);
      meterRef.current.__timer = meterTimer;
    } catch {
      push({ title: 'Микрофон недоступен', description: 'Запись продолжится без индикатора уровня.', tone: 'warn' });
    }

    const finalized = [];
    const recognizer = createRecognizer({
      lang: langTag(settings.language),
      onPartial: ({ interim }) => {
        // показываем подтверждённые фразы + текущий черновик
        const composed = [...finalized, interim].filter(Boolean);
        liveRef.current = composed;
        setLiveLines(composed);
      },
      onFinal: ({ text }) => {
        const sentence = String(text || '').trim();
        if (sentence) finalized.push(sentence);
        liveRef.current = [...finalized];
        setLiveLines(liveRef.current);
      },
      onLevel: setLevel,
    });
    recRef.current = recognizer;
    try {
      recognizer.start();
    } catch {
      push({ title: 'Не удалось начать запись', tone: 'warn' });
    }
  };

  const stopRecording = () => {
    const durationMs = Date.now() - startedAt.current;
    const transcript = liveRef.current.filter(Boolean).join(' ').trim();
    recRef.current?.stop?.();
    recRef.current = null;
    clearInterval(meterRef.current?.__timer);
    meterRef.current?.dispose?.();
    meterRef.current = null;
    streamRef.current?.getTracks?.().forEach((t) => t.stop());
    streamRef.current = null;
    setRecording(false);
    setLevel(0);

    const note = {
      id: uid('meet'),
      title: newTitle || `Встреча ${new Date().toLocaleDateString('ru-RU')} ${timeHM(Date.now())}`,
      createdAt: Date.now(),
      durationMs: Math.max(1000, durationMs),
      transcript: transcript || 'Запись без распознанной речи.',
      summary: OPS.summary(transcript || ''),
      todos: OPS.todos(transcript || ''),
      words: words(transcript),
      source: 'mic',
    };
    addMeetingNote(note);
    setActiveId(note.id);
    setNewTitle('');
    push({ title: 'Заметка сохранена', description: note.title, tone: 'success' });
  };

  const summarize = async (note) => {
    setBusy(true);
    try {
      const res = await summarizeTranscript(note.transcript, settings);
      updateMeetingNote(note.id, {
        summary: res.summary,
        todos: res.tasks.length ? res.tasks : OPS.todos(note.transcript),
      });
      push({
        title: 'Резюме готово',
        description: res.engine === 'llm' ? 'Локальная модель Ollama' : 'Офлайн-алгоритм: без облака',
        tone: 'success',
      });
    } finally {
      setBusy(false);
    }
  };

  const exportNote = (note) => {
    const body = [
      `# ${note.title}`,
      '',
      `Дата: ${new Date(note.createdAt).toLocaleString('ru-RU')}`,
      `Длительность: ${msToClock(note.durationMs)} · ${note.words} слов`,
      '',
      '## Расшифровка',
      note.transcript,
      '',
      '## Резюме',
      note.summary || '—',
      '',
      '## Задачи',
      ...(note.todos?.length ? note.todos.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`) : ['—']),
    ].join('\n');
    const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${note.title.replace(/[^\p{L}\p{N}\s-]/gu, '').trim() || 'meeting'}.md`;
    a.click();
    URL.revokeObjectURL(url);
    push({ title: 'Экспортировано в Markdown', tone: 'success' });
  };

  if (active) {
    return (
      <div className="page scroll-area">
        <div className="meeting-detail__head">
          <button type="button" className="icon-btn" onClick={() => setActiveId(null)} aria-label="Назад">
            <ArrowLeft size={15} />
          </button>
          <div className="grow">
            <h1 className="meeting-detail__title">{active.title}</h1>
            <div className="meeting-detail__meta">
              {dayLabel(active.createdAt)}, {timeHM(active.createdAt)} · {msToClock(active.durationMs)} ·{' '}
              {active.words} слов
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={<Wand2 size={12} />}
            loading={busy}
            onClick={() => summarize(active)}
          >
            Резюмировать
          </Button>
          <Button variant="ghost" size="sm" icon={<Download size={12} />} onClick={() => exportNote(active)}>
            Экспорт
          </Button>
          <button
            type="button"
            className="icon-btn icon-btn--danger"
            onClick={() => {
              removeMeetingNote(active.id);
              setActiveId(null);
              push({ title: 'Заметка удалена' });
            }}
            aria-label="Удалить"
          >
            ×
          </button>
        </div>

        <div className="meeting-detail__grid">
          <section>
            <h3 className="meeting-block__title">Расшифровка</h3>
            <div className="meeting-block__body">{active.transcript}</div>
          </section>
          <aside className="stack-12">
            <div className="info-card">
              <div className="info-card__title">Резюме</div>
              <div className="meeting-summary">
                {active.summary ? (
                  active.summary.split('\n').map((line, i) =>
                    line.startsWith('**') ? (
                      <div key={i} className="meeting-summary__head">
                        {line.replace(/\*\*/g, '')}
                      </div>
                    ) : (
                      <div key={i} className="meeting-summary__line">
                        {line || '\u00A0'}
                      </div>
                    ),
                  )
                ) : (
                  <span className="muted">Нажмите «Резюмировать», чтобы получить тезисы, решения и задачи.</span>
                )}
              </div>
            </div>
            <div className="info-card">
              <div className="info-card__title">Задачи</div>
              {active.todos?.length ? (
                <div className="meeting-todos">
                  {active.todos.map((t, i) => (
                    <button
                      key={i}
                      type="button"
                      className={`meeting-todo ${t.done ? 'is-done' : ''}`}
                      onClick={() =>
                        updateMeetingNote(active.id, {
                          todos: active.todos.map((x, idx) => (idx === i ? { ...x, done: !x.done } : x)),
                        })
                      }
                    >
                      {t.done ? <CheckCircle2 size={13} /> : <Circle size={13} />}
                      <span>{t.text}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="muted" style={{ fontSize: 10 }}>
                  Задачи появятся после резюмирования.
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className="page scroll-area">
      <div className="page__head">
        <div>
          <h1 className="page__title">Заметки о встречах</h1>
          <p className="page__sub">
            Записывайте, расшифровывайте и суммируйте аудио. Всё происходит на вашем устройстве:
            аудио и текст не покидают компьютер.
          </p>
        </div>
      </div>

      <div className="meet-cards">
        <button type="button" className="meet-card" onClick={() => setCalendarOpen(true)}>
          <div className="meet-card__icon">
            <CalendarPlus size={15} />
          </div>
          <div className="meet-card__title">Подключить календарь</div>
          <div className="meet-card__desc">ZSpeakly начнёт запись автоматически по событиям</div>
        </button>
        <button type="button" className="meet-card" onClick={() => setNewOpen(true)}>
          <div className="meet-card__icon">
            <Mic size={15} />
          </div>
          <div className="meet-card__title">Новая заметка</div>
          <div className="meet-card__desc">Запись с микрофона и расшифровка в реальном времени</div>
        </button>
        <button type="button" className="meet-card" onClick={() => setImportOpen(true)}>
          <div className="meet-card__icon">
            <Upload size={15} />
          </div>
          <div className="meet-card__title">Import File</div>
          <div className="meet-card__desc">Загрузите текст или расшифровку и получите резюме</div>
        </button>
      </div>

      {recording ? (
        <div className="recorder">
          <div>
            <div className="recorder__label">Идёт запись</div>
            <div className="recorder__time">{msToClock(elapsed)}</div>
          </div>
          <div className="recorder__wave" aria-hidden>
            {Array.from({ length: 42 }).map((_, i) => (
              <span
                key={i}
                className="recorder__bar"
                style={{ height: `${12 + Math.min(88, level * 100 * (0.4 + ((i * 37) % 60) / 100))}%` }}
              />
            ))}
          </div>
          <Button variant="danger" size="sm" icon={<Square size={11} fill="currentColor" />} onClick={stopRecording}>
            Остановить
          </Button>
        </div>
      ) : null}

      {recording ? (
        <div className="meeting-live">
          <div className="meeting-live__head">
            <span className="dot-live" /> Живая расшифровка
          </div>
          <div className="meeting-live__body">
            {liveLines.filter(Boolean).length ? (
              liveLines.filter(Boolean).map((line, i) => <p key={i}>{line}</p>)
            ) : (
              <p className="muted">Говорите — текст появится здесь…</p>
            )}
          </div>
        </div>
      ) : null}

      <div className="section-head">
        <h2 className="section-head__title">Мои заметки</h2>
        <span className="recent__footer-text">{meetingNotes.length} записей</span>
      </div>

      {meetingNotes.length === 0 ? (
        <div className="empty">
          <div className="empty__icon">
            <FileAudio size={22} />
          </div>
          <div className="empty__title">Пока нет заметок</div>
          <div className="empty__desc">
            Нажмите «Новая заметка», чтобы записать встречу с микрофона. Расшифровка и резюме
            сохранятся локально.
          </div>
        </div>
      ) : (
        <div>
          {meetingNotes.map((note) => (
            <button key={note.id} type="button" className="meet-note" onClick={() => setActiveId(note.id)}>
              <div className="meet-note__icon">
                <FileAudio size={14} />
              </div>
              <div className="meet-note__body">
                <div className="meet-note__title">{note.title}</div>
                <div className="meet-note__meta">
                  {dayLabel(note.createdAt)}, {timeHM(note.createdAt)} · {msToClock(note.durationMs)} ·{' '}
                  {note.words} слов
                </div>
              </div>
              {note.summary ? <span className="meet-note__badge">резюме</span> : null}
              <ArrowLeft size={13} style={{ transform: 'rotate(180deg)', opacity: 0.4 }} />
            </button>
          ))}
        </div>
      )}

      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="Новая заметка"
        subtitle="Дайте название — оно пригодится в списке записей."
        width={400}
        footer={
          <>
            <Button variant="bare" onClick={() => setNewOpen(false)}>
              Отмена
            </Button>
            <Button
              variant="white"
              icon={<Mic size={13} />}
              onClick={() => {
                setNewOpen(false);
                startRecording();
              }}
            >
              Начать запись
            </Button>
          </>
        }
      >
        <div className="field">
          <label className="field__label" htmlFor="meet-title">
            Название
          </label>
          <input
            id="meet-title"
            className="input"
            data-autofocus
            placeholder="Например: Созвон по релизу"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
        </div>
      </Modal>

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="Import File"
        subtitle="Вставьте расшифровку или загрузите .txt / .md — ZSpeakly сделает резюме и задачи."
        width={520}
        footer={
          <>
            <Button variant="bare" onClick={() => setImportOpen(false)}>
              Отмена
            </Button>
            <Button
              variant="white"
              disabled={!importText.trim()}
              onClick={async () => {
                const res = await summarizeTranscript(importText, settings);
                const note = {
                  id: uid('meet'),
                  title: importText.trim().split('\n')[0].slice(0, 60) || 'Импортированная заметка',
                  createdAt: Date.now(),
                  durationMs: words(importText) * 420,
                  transcript: importText.trim(),
                  summary: res.summary,
                  todos: res.tasks.length ? res.tasks : OPS.todos(importText),
                  words: words(importText),
                  source: 'import',
                };
                addMeetingNote(note);
                setImportOpen(false);
                setImportText('');
                setActiveId(note.id);
                push({ title: 'Импорт готов', description: note.title, tone: 'success' });
              }}
            >
              Импортировать
            </Button>
          </>
        }
      >
        <div className="stack-12">
          <label className="file-drop">
            <Upload size={18} />
            <span>Выберите файл .txt или .md</span>
            <input
              type="file"
              accept=".txt,.md,text/plain,text/markdown"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setImportText(await file.text());
              }}
            />
          </label>
          <div className="field">
            <label className="field__label" htmlFor="import-text">
              Или вставьте текст
            </label>
            <textarea
              id="import-text"
              className="textarea"
              rows={7}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder="Вставьте расшифровку встречи…"
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={calendarOpen}
        onClose={() => setCalendarOpen(false)}
        title="Подключить календарь"
        subtitle="Офлайн-версия: ZSpeakly читает локальный календарь Windows и предлагает начать запись."
        width={440}
        footer={
          <Button variant="white" onClick={() => setCalendarOpen(false)}>
            Понятно
          </Button>
        }
      >
        <div className="notice notice--info">
          <span className="notice__icon">i</span>
          <span>
            Доступ к календарю запрашивается у системы. Данные не отправляются в облако — ZSpeakly
            работает полностью локально. Пока подключение можно включить вручную: создайте заметку и
            вставьте ссылку на встречу в описание.
          </span>
        </div>
      </Modal>
    </div>
  );
}
