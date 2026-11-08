import { useMemo, useState } from 'react';
import { CircleUser, Info, LayoutGrid, ShieldCheck, SlidersHorizontal, Wifi } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { Button, Select } from '../ui/Controls.jsx';
import { Toggle } from '../ui/Toggle.jsx';
import AccountSection from './sections/AccountSection.jsx';
import AppSection from './sections/AppSection.jsx';
import FeaturesSection from './sections/FeaturesSection.jsx';
import DataSection from './sections/DataSection.jsx';
import NetworkSection from './sections/NetworkSection.jsx';
import AboutSection from './sections/AboutSection.jsx';
import { useAppData } from '../../state/AppDataProvider.jsx';
import { SETTING_ENTRIES } from './settingsIndex.js';

const SECTIONS = [
  { id: 'account', label: 'Аккаунт', icon: CircleUser },
  { id: 'app', label: 'Приложение', icon: LayoutGrid },
  { id: 'features', label: 'Функции', icon: SlidersHorizontal },
  { id: 'data', label: 'Данные и разрешения', icon: ShieldCheck },
  { id: 'network', label: 'Сеть', icon: Wifi },
  { id: 'about', label: 'О программе', icon: Info },
];

export default function SettingsModal({ open, section, onSectionChange, onClose }) {
  const { settings } = useAppData();
  const [query, setQuery] = useState('');

  // поиск ищет и по названиям разделов, и по конкретным строкам внутри них:
  // раньше запрос «звук» давал пустой экран
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return SETTING_ENTRIES.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.sectionLabel.toLowerCase().includes(q) ||
        (e.desc || '').toLowerCase().includes(q),
    ).slice(0, 12);
  }, [query]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    // раздел показываем, даже если совпала только строка внутри него
    const withHits = new Set(matches.map((m) => m.section));
    return SECTIONS.filter((s) => s.label.toLowerCase().includes(q) || withHits.has(s.id));
  }, [query, matches]);

  // переход к найденной строке: открываем раздел и подсвечиваем совпадение
  const jumpTo = (entry) => {
    onSectionChange(entry.section);
    setQuery('');
    setTimeout(() => {
      const target = [...document.querySelectorAll('.settings-main .setting-row')].find((row) =>
        row.textContent.toLowerCase().includes(entry.title.toLowerCase()),
      );
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target?.classList.add('is-highlight');
      setTimeout(() => target?.classList.remove('is-highlight'), 1600);
    }, 120);
  };

  const active = SECTIONS.find((s) => s.id === section) || SECTIONS[0];

  const body = {
    account: <AccountSection />,
    app: <AppSection />,
    features: <FeaturesSection />,
    data: <DataSection onOpenSection={onSectionChange} />,
    network: <NetworkSection />,
    about: <AboutSection />,
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
                  onClick={() => onSectionChange(s.id)}
                >
                  <IconCmp size={14} strokeWidth={1.7} />
                  <span>{s.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
        <div className="settings-main">{body}</div>
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
