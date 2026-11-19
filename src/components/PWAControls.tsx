import React, { useState } from 'react';
import { Download, WifiOff, RefreshCw } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

interface PWAInstallButtonProps {
  variant?: 'light' | 'dark';
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ variant = 'light' }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) return null;

  const baseClass =
    variant === 'dark'
      ? 'bg-white/15 hover:bg-white/25 text-white border border-white/25'
      : 'bg-[#145f96] hover:bg-[#0e4670] text-white border border-[#145f96]';

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 min-h-[40px] ${baseClass}`}
      >
        <Download className="w-4 h-4 shrink-0" />
        <span>Instalar App</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 min-h-[40px] ${baseClass}`}
        >
          <Download className="w-3.5 h-3.5 shrink-0" />
          <span>Instalar</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4">
            <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl border border-slate-200 text-slate-900">
              <div className="flex items-center gap-3 mb-3">
                <img src="/akrobit-icon.png" alt="Akrobit" className="w-10 h-10 rounded-xl" />
                <h3 className="text-base font-bold text-[#145f96]">Instalar Akrobit en iOS</h3>
              </div>
              <p className="text-sm text-slate-600 leading-relaxed">
                1. Toca el botón <strong>Compartir</strong> en la barra inferior de Safari.
                <br />
                2. Desliza hacia abajo y selecciona <strong>Agregar a inicio</strong>.
              </p>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-5 w-full rounded-xl bg-[#145f96] py-2.5 text-sm font-semibold text-white hover:bg-[#0e4670] transition-colors cursor-pointer"
              >
                Entendido
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

export const OfflineIndicator: React.FC<{ pendingCount?: number }> = ({ pendingCount = 0 }) => {
  const isOnline = useOnlineStatus();

  if (isOnline && pendingCount === 0) return null;

  return (
    <div
      role="status"
      className={`fixed bottom-4 left-4 z-40 flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold shadow-lg border ${
        !isOnline
          ? 'bg-amber-600 text-white border-amber-500'
          : 'bg-[#145f96] text-white border-[#69b8e9]/40'
      }`}
    >
      {!isOnline ? (
        <>
          <WifiOff className="w-3.5 h-3.5 shrink-0" />
          <span>Modo sin internet · Guardado local activo</span>
        </>
      ) : (
        <>
          <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin" />
          <span>Sincronizando {pendingCount} registro(s)</span>
        </>
      )}
    </div>
  );
};
