import { useState } from 'react';
import { ChevronRight, Sparkles, User } from 'lucide-react';
import Icon from '../ui/Icon.jsx';
import { NAV } from '../../lib/config.js';
import { navigate } from '../../lib/router.js';
import { useAppData } from '../../state/AppDataProvider.jsx';
import { useToast } from '../../state/ToastProvider.jsx';

export default function Sidebar({ page, onOpenSettings, onOpenProfile, onOpenPresets }) {
  const { profile, settings } = useAppData();
  const { push } = useToast();
  const [hovered, setHovered] = useState(null);

  const go = (id) => navigate(id);

  return (
    <aside className="sidebar">
      <nav className="sidebar__nav" aria-label="Основная навигация">
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-item ${page === item.id ? 'is-active' : ''}`}
            onClick={() => go(item.id)}
            onMouseEnter={() => setHovered(item.id)}
            onMouseLeave={() => setHovered(null)}
          >
            <Icon name={item.icon} size={15} strokeWidth={1.6} className="nav-item__icon" />
            <span className="nav-item__label">{item.label}</span>
            {item.badge && !(item.id === 'clipboard' && settings.seenClipboard) ? (
              <span className="badge-new">{item.badge}</span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="sidebar__bottom">
        <button type="button" className="plan-card plan-card--action" onClick={onOpenPresets}>
          <div className="plan-card__title">AI-инструкции</div>
          <div className="plan-card__limit">Выдели текст — нажми клавиши</div>
          <p className="plan-card__text">Переписать, сократить, перевести. Офлайн, без лимитов.</p>
          <span className="btn btn--white btn--sm btn--block">
            <Sparkles size={12} /> Открыть
          </span>
        </button>

        <button type="button" className="sidebar__link sidebar__link--settings" onClick={onOpenSettings}>
          <Icon name="settings" size={14} strokeWidth={1.6} />
          <span>Настройки</span>
          <ChevronRight size={13} className="sidebar__link-arrow" />
        </button>

        <button type="button" className="profile" onClick={onOpenProfile} title="Профиль">
          <span className="profile__avatar">{(profile?.name || 'Z')[0].toUpperCase()}</span>
          <span className="profile__email">{profile?.name || 'локальный профиль'}</span>
          <User size={12} className="profile__logout" />
        </button>
      </div>
    </aside>
  );
}
