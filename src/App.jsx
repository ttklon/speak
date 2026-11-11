import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/layout/Sidebar.jsx';
import TitleBar from './components/layout/TitleBar.jsx';
import HomePage from './pages/HomePage.jsx';
import DictionaryPage from './pages/DictionaryPage.jsx';
import HotkeysPage from './pages/HotkeysPage.jsx';
import ClipboardPage from './pages/ClipboardPage.jsx';
import SettingsModal from './components/settings/SettingsModal.jsx';
import ProfileModal from './components/modals/ProfileModal.jsx';
import DictationHUD from './components/ui/DictationHUD.jsx';
import OnboardingModal from './components/modals/OnboardingModal.jsx';
import { useRoute, navigate, replace } from './lib/router.js';
import { keysLabel } from './lib/utils.js';
import { useAppData } from './state/AppDataProvider.jsx';
import { useToast } from './state/ToastProvider.jsx';

const PAGES = {
  home: HomePage,
  dictionary: DictionaryPage,
  hotkeys: HotkeysPage,
  clipboard: ClipboardPage,
};

export default function App() {
  const route = useRoute();
  const { settings, updateSettings, presets, instructions, voiceHotkeys } = useAppData();
  const { push } = useToast();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState('account');
  const [profileOpen, setProfileOpen] = useState(false);

  // «НОВОЕ» у буфера — не вечная наклейка: после первого захода гаснет
  useEffect(() => {
    if (route.page === 'clipboard' && !settings.seenClipboard) updateSettings({ seenClipboard: true });
  }, [route.page, settings.seenClipboard, updateSettings]);

  const prevPage = useRef(route.page);
  const openedFromHash = useRef(false);

  // Поддержка прямых ссылок вида #/settings?section=features
  useEffect(() => {
    // пока не спросили имя — не перекрываем приветствие настройками
    if (route.page === 'settings' && settings.onboarded) {
      openedFromHash.current = true;
      setSettingsSection(route.params.section || 'account');
      setSettingsOpen(true);
      // replace, а не navigate: иначе hashchange закроет только что открытые настройки
      replace(route.params.from || 'home');
    }
  }, [route, settings.onboarded]);

  // Переход на другую страницу закрывает модалки (кроме случая открытия из hash)
  useEffect(() => {
    if (prevPage.current === route.page) return;
    prevPage.current = route.page;
    if (openedFromHash.current) {
      openedFromHash.current = false;
      return;
    }
    setProfileOpen(false);
    setSettingsOpen(false);
  }, [route.page]);

  // Ctrl+, — настройки, Ctrl+K — поиск по буферу
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        navigate('clipboard');
        setTimeout(() => {
          const input = document.querySelector('.clip-toolbar .search-input input');
          input?.focus();
        }, 90);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Команды из трея / меню Electron
  // Тема: тёмная / светлая / как в системе. Значение уходит в data-theme,
  // палитра живёт в base.css (светлая там уже была, но выбрать её было нельзя).
  useEffect(() => {
    const theme = ['light', 'system', 'dark'].includes(settings.theme) ? settings.theme : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme =
      theme === 'system' ? 'light dark' : theme === 'light' ? 'light' : 'dark';
  }, [settings.theme]);

  // Автозапуск: настройка живёт в localStorage, а системе о ней нужно сказать
  // отдельно. Раньше это происходило только при ручном щелчке тумблера —
  // после переезда профиля или переустановки автозапуск молча терялся.
  useEffect(() => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.setAutoLaunch) return;
    bridge.setAutoLaunch(Boolean(settings.autoLaunch)).catch?.(() => {});
  }, [settings.autoLaunch]);

  // AI-инструкции должны срабатывать в любом приложении и на любой странице,
  // а не только когда открыт раздел «Горячие клавиши». Регистрируем их здесь,
  // на уровне приложения.
  useEffect(() => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.setDictationHotkey) return;
    const all = [...(presets || []), ...(instructions || [])];
    const textActions = all
      .filter((a) => a.enabled && a.keys?.length)
      .map((a) => ({ id: a.id, title: a.title, keys: a.keys, enabled: true, prompt: a.prompt || '' }));
    bridge
      .setDictationHotkey({
        dictationKey: settings.dictationKey || 'Control+Alt+Space',
        textActions,
        // голосовые сочетания: раньше они были только подписями в интерфейсе
        voiceHotkeys: (voiceHotkeys || []).map((h) => ({
          id: h.id,
          title: h.title,
          keys: h.keys,
          enabled: Boolean(h.enabled),
          mode: h.mode || (h.id === 'hands-free' ? 'toggle' : 'hold'),
        })),
      })
      .catch?.(() => {});
  }, [presets, instructions, settings.dictationKey, voiceHotkeys]);

  useEffect(() => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.onCommand) return undefined;
    return bridge.onCommand((command) => {
      if (command === 'settings') setSettingsOpen(true);
      // из трея: «Диагностика» открывает настройки сразу на нужном разделе
      if (command === 'diagnostics') {
        setSettingsSection('diagnostics');
        setSettingsOpen(true);
      }
      if (command === 'clipboard') navigate('clipboard');
      if (command === 'home') navigate('home');
      if (command === 'mobile') {
        setSettingsSection('account');
        setSettingsOpen(true);
      }
      if (command === 'about') {
        setSettingsSection('about');
        setSettingsOpen(true);
      }
    });
  }, []);

  // Сочетание занято — сказать вслух, а не молчать. Слушаем на уровне
  // приложения: конфликт может всплыть при запуске, когда раздел «Горячие
  // клавиши» ещё не открывали, и раньше сообщение просто терялось.
  useEffect(() => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.onHotkeyConflict) return undefined;
    return bridge.onHotkeyConflict((payload) => {
      const keys = keysLabel(payload?.keys || []);
      push({
        title: payload?.id === 'dictation' ? 'Сочетание диктовки занято' : 'Сочетание занято',
        description: `${keys || 'Сочетание'} — ${payload?.reason || 'уже используется другой программой'}. Выберите другое в «Горячих клавишах».`,
        tone: 'warn',
        ttl: 10000,
      });
      window.dispatchEvent(new CustomEvent('zs:hotkey-conflict', { detail: payload }));
    });
  }, [push]);

  // Новые элементы буфера из main-процесса
  useEffect(() => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.onClipboard) return undefined;
    return bridge.onClipboard((item) => {
      if (item?.text) {
        window.dispatchEvent(new CustomEvent('zs:clipboard', { detail: item }));
      }
    });
  }, []);

  // Обновление приходит само: слушаем статус апдейтера на уровне приложения,
  // а не только внутри «О программе». Иначе человек узнавал о новой версии,
  // лишь случайно открыв настройки.
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.zspeakly?.native : null;
    if (!bridge?.onUpdateStatus) return undefined;
    let announced = null;
    return bridge.onUpdateStatus((next) => {
      if (next.status === 'downloaded' && announced !== next.version) {
        announced = next.version;
        push({
          title: `Обновление ${next.version} загружено`,
          description: 'Перезапустите приложение, чтобы применить — или нажмите здесь.',
          tone: 'success',
          ttl: 12000,
          action: { label: 'Перезапустить', onClick: () => bridge.installUpdate?.() },
        });
      }
      if (next.status === 'available' && announced !== next.version) {
        announced = next.version;
        push({
          title: `Доступна версия ${next.version}`,
          description: 'Скачиваю в фоне — можно продолжать работу.',
          tone: 'success',
          ttl: 9000,
        });
      }
    });
  }, [push]);

  const openPresets = useCallback(() => {
    navigate('hotkeys');
    setTimeout(() => {
      const tab = Array.from(document.querySelectorAll('.hk-toolbar .tabs__tab')).find((b) =>
        /Рекомендуемые/i.test(b.textContent || ''),
      );
      tab?.click();
    }, 120);
  }, []);
  const openProfile = useCallback(() => setProfileOpen(true), []);
  const openSettings = useCallback((section = 'account') => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    updateSettings({ lastSettingsVisit: Date.now() });
  }, [updateSettings]);

  const content = useMemo(() => {
    if (page(route) === 'home') return <HomePage onOpenSettings={openSettings} />;
    const Page = PAGES[page(route)] || HomePage;
    return <Page onOpenSettings={openSettings} />;
  }, [route, openSettings]);

  return (
    <div className="app-shell">
      <div className="app-window">
        <TitleBar />
        <div className="app-body">
          <Sidebar
            page={page(route)}
            onOpenSettings={() => openSettings('account')}
            onOpenProfile={openProfile}
            onOpenPresets={openPresets}
          />
          <main className="content">{content}</main>
        </div>
      </div>

      <DictationHUD />

      <ProfileModal
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        onOpenSettings={() => {
          setProfileOpen(false);
          openSettings('account');
        }}
      />
      <OnboardingModal />

      <SettingsModal
        open={settingsOpen}
        section={settingsSection}
        onSectionChange={setSettingsSection}
        onClose={closeSettings}
      />
    </div>
  );
}

function page(route) {
  return route.page === 'settings' ? 'home' : route.page;
}
