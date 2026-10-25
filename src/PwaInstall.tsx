import { useEffect, useState } from 'react';
import { Download, Share2, X } from 'lucide-react';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function isInstalled() {
  if (navigator.userAgent.includes('SpaceMapNative/')) return true;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone;
  return window.matchMedia('(display-mode: standalone)').matches || iosStandalone === true;
}

export default function PwaInstall() {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isInstalled);
  const [helpOpen, setHelpOpen] = useState(false);
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const android = /Android/i.test(navigator.userAgent);

  useEffect(() => {
    if (!helpOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setHelpOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [helpOpen]);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPromptEvent(null);
      setHelpOpen(false);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = async () => {
    if (!promptEvent) {
      setHelpOpen(true);
      return;
    }
    await promptEvent.prompt();
    const result = await promptEvent.userChoice;
    setPromptEvent(null);
    if (result.outcome === 'accepted') setInstalled(true);
  };

  if (installed) return null;

  return (
    <>
      <button
        className="app-install-button"
        aria-label="Установить приложение"
        onClick={() => void install()}
      >
        <Download size={15} />
        <span>Установить приложение</span>
      </button>
      {helpOpen && (
        <div className="modal-backdrop" onClick={() => setHelpOpen(false)}>
          <section
            className="modal install-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="install-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close"
              aria-label="Закрыть установку"
              onClick={() => setHelpOpen(false)}
            >
              <X size={20} />
            </button>
            <span className="modal-icon install-modal-icon">
              {ios ? <Share2 size={24} /> : <Download size={24} />}
            </span>
            <h2 id="install-title">Карта пространства — как приложение</h2>
            {ios ? (
              <ol className="install-steps">
                <li>Откройте эту страницу в Safari.</li>
                <li>Нажмите «Поделиться» внизу экрана.</li>
                <li>Выберите «На экран Домой», затем «Добавить».</li>
              </ol>
            ) : android ? (
              <ol className="install-steps">
                <li>Откройте меню Chrome ⋮.</li>
                <li>Нажмите «Установить приложение» или «Добавить на главный экран».</li>
                <li>Подтвердите установку — карта откроется в отдельном окне.</li>
              </ol>
            ) : (
              <ol className="install-steps">
                <li>В Chrome или Edge откройте меню браузера.</li>
                <li>Выберите «Установить приложение» или значок установки в адресной строке.</li>
                <li>После установки карта запускается в собственном окне.</li>
              </ol>
            )}
            <p className="modal-help">
              Это устанавливаемая веб-версия: она открывает актуальную карту с сервера. Для
              автономного просмотра отдельно скачайте офлайн-карту. LiDAR-сканирование доступно в
              companion-приложении для поддерживаемых iPhone/iPad Pro.
            </p>
            <button className="primary-button" onClick={() => setHelpOpen(false)}>
              Понятно <X size={15} />
            </button>
          </section>
        </div>
      )}
    </>
  );
}
