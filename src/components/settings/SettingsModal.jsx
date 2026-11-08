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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS.filter((s) => s.label.toLowerCase().includes(q));
  }, [query]);

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
          Настройки применяются сразу и хранятся локально · {settings.language.toUpperCase()}
        </span>
        <Button variant="white" size="sm" onClick={onClose}>
          Готово
        </Button>
      </div>
    </Modal>
  );
}
