import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Bug, LayoutGrid, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { Button } from '../ui/Controls.jsx';
import { useAppData } from '../../state/AppDataProvider.jsx';
import { SETTING_ENTRIES } from './settingsIndex.js';
import { SETTINGS_SECTIONS, resolveSection } from '../../lib/settingsSections.js';
import { observeSettingRow } from './observeSettingRow.js';

// Секции настроек грузятся по требованию: на старте приложения они не нужны,
// а тянут за собой диагностику, сравнение моделей и менеджер моделей.
// Они не входят в начальный файл интерфейса.
const AccountSection = lazy(() => import('./sections/AccountSection.jsx'));
const AppSection = lazy(() => import('./sections/AppSection.jsx'));
const FeaturesSection = lazy(() => import('./sections/FeaturesSection.jsx'));
const DataSection = lazy(() => import('./sections/DataSection.jsx'));
const DiagnosticsSection = lazy(() => import('./sections/DiagnosticsSection.jsx'));
const NetworkSection = lazy(() => import('./sections/NetworkSection.jsx'));
const AboutSection = lazy(() => import('./sections/AboutSection.jsx'));

// Названия разделов живут в lib/settingsSections.js: по ним же проверяются
// подсказки «Настройки → Раздел» в ошибках и тостах.
const SECTION_ICONS = {
  dictation: SlidersHorizontal,
  app: LayoutGrid,
  data: ShieldCheck,
  diagnostics: Bug,
};
const SECTIONS = SETTINGS_SECTIONS.map((section) => ({ ...section, icon: SECTION_ICONS[section.id] }));

export default function SettingsModal({ open, section, onSectionChange, onClose }) {
  const { settings } = useAppData();
  const [query, setQuery] = useState('');
  const [pendingJump, setPendingJump] = useState(null);
  const mainRef = useRef(null);
  const active = SECTIONS.find((s) => s.id === resolveSection(section)) || SECTIONS[0];

  // поиск ищет и по названиям разделов, и по конкретным строкам внутри них:
  // раньше запрос «звук» давал пустой экран
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    // Совпадение в названии важнее совпадения в описании: на «микрофон»
    // первой должна стоять строка «Микрофон», а не «Плавающий индикатор».
    const score = (e) => {
      const title = e.title.toLowerCase();
      if (title === q) return 0;
      if (title.startsWith(q)) return 1;
      if (title.includes(q)) return 2;
      if (e.sectionLabel.toLowerCase().includes(q)) return 3;
      return 4;
    };
    return SETTING_ENTRIES.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.sectionLabel.toLowerCase().includes(q) ||
        (e.desc || '').toLowerCase().includes(q),
    )
      .sort((a, b) => score(a) - score(b))
      .slice(0, 12);
  }, [query]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    // раздел показываем, даже если совпала только строка внутри него
    const withHits = new Set(matches.map((m) => m.section));
    return SECTIONS.filter((s) => s.label.toLowerCase().includes(q) || withHits.has(s.id));
  }, [query, matches]);

  useEffect(() => {
    if (!open) setPendingJump(null);
  }, [open]);

  // Следим за появлением строки после загрузки раздела. При закрытии,
  // переходе в другой раздел или новом поиске наблюдатель отменяется.
  useEffect(() => {
    if (!open || !pendingJump || resolveSection(pendingJump.section) !== active.id || !mainRef.current) return undefined;
    let target;
    let timer;
    const stop = observeSettingRow(mainRef.current, pendingJump.title, (row) => {
      target = row;
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add('is-highlight');
      timer = setTimeout(() => row.classList.remove('is-highlight'), 1600);
    });
    return () => {
      stop();
      clearTimeout(timer);
      target?.classList.remove('is-highlight');
    };
  }, [open, pendingJump, active.id]);

  const jumpTo = (entry) => {
    setPendingJump({ ...entry });
    onSectionChange(entry.section);
    setQuery('');
  };

  const changeSection = (id) => {
    setPendingJump(null);
    onSectionChange(id);
  };

  // Четыре раздела вместо семи: смежное стоит рядом, а не за отдельной вкладкой.
  // «Сеть» — это настройки локальной модели, значит место ей в «Диктовке»;
  // имя и «О программе» — в «Приложении».
  const body = {
    dictation: (
      <>
        <FeaturesSection />
        <NetworkSection />
      </>
    ),
    app: (
      <>
        <AccountSection />
        <AppSection />
        <AboutSection />
      </>
    ),
    data: <DataSection onOpenSection={changeSection} />,
    diagnostics: <DiagnosticsSection />,
  }[active.id];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Настройки"
      width={780}
      className="settings-modal"
      footer={null}
      headClassName="modal__head--split"
    >
      <div className="settings-shell">
        <div className="settings-side">
          <label className="search-input settings-side__search">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по настройкам"
            />
          </label>
          {matches.length ? (
            <div className="settings-search-results">
              {matches.map((m) => (
                <button
                  key={`${m.section}|${m.title}`}
                  type="button"
                  className="settings-search-hit"
                  onClick={() => jumpTo(m)}
                >
                  <span className="settings-search-hit__title">{m.title}</span>
                  <span className="settings-search-hit__where">{m.sectionLabel}</span>
                </button>
              ))}
            </div>
          ) : null}
          <nav>
            {filtered.map((s) => {
              const IconCmp = s.icon;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`settings-nav ${active.id === s.id ? 'is-active' : ''}`}
                  onClick={() => changeSection(s.id)}
                >
                  <IconCmp size={14} strokeWidth={1.7} />
                  <span>{s.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
        <div className="settings-main" ref={mainRef}>
          {/* Один заголовок на вкладку: раньше внутри «Приложения» стояли три
              одинаковых по весу заголовка, и было непонятно, где что. */}
          <header className="settings-main__head">
            <h2 className="settings-section__title">{active.label}</h2>
            <p className="settings-section__desc">{active.desc}</p>
          </header>
          <Suspense key={active.id} fallback={<p className="settings-loading" role="status">Загрузка раздела…</p>}>
            {body}
          </Suspense>
        </div>
      </div>
      <div className="settings-footer">
        <span className="settings-foot__hint">
          Настройки применяются сразу и хранятся локально · {String(settings.language || 'ru').toUpperCase()}
        </span>
        <Button variant="white" size="sm" onClick={onClose}>
          Готово
        </Button>
      </div>
    </Modal>
  );
}
