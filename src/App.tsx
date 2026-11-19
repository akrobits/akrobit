import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { WelcomeSplash } from './components/WelcomeSplash';
import { LoginScreen } from './components/LoginScreen';
import { MainDashboard } from './components/MainDashboard';
import { ClientPortalPage } from './components/ClientPortalPage';
import { useBackHandler } from './lib/backNavigation';
import { isClientPortalRoute } from './lib/clientPortal';

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error.message };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[100dvh] bg-slate-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-lg p-6 space-y-4">
            <div className="flex items-center gap-3">
              <img src="/akrobit-icon.png" alt="Akrobit" className="w-10 h-10 rounded-xl" />
              <h2 className="text-base font-bold text-[#145f96]">Ocurrió un problema inesperado</h2>
            </div>
            <p className="text-xs text-slate-600 break-words bg-slate-50 rounded-xl p-3 border border-slate-200">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="w-full min-h-[44px] rounded-xl bg-[#145f96] text-white font-bold text-sm cursor-pointer"
            >
              Recargar Akrobit
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AkrobitRouter() {
  const { user, isVerified, loading } = useAuth();
  const [enteredFromSplash, setEnteredFromSplash] = useState<boolean>(() => {
    try {
      const hasSharedContact =
        typeof window !== 'undefined' &&
        new URLSearchParams(window.location.search).has('sharedContact');
      if (hasSharedContact) {
        sessionStorage.setItem('akrobit_entered_splash', '1');
        return true;
      }
      return sessionStorage.getItem('akrobit_entered_splash') === '1';
    } catch {
      return false;
    }
  });

  const handleEnterSplash = () => {
    try {
      sessionStorage.setItem('akrobit_entered_splash', '1');
    } catch {
      // Ignore storage errors
    }
    setEnteredFromSplash(true);
  };

  const handleBackToSplash = () => {
    try {
      sessionStorage.removeItem('akrobit_entered_splash');
    } catch {
      // Ignore storage errors
    }
    setEnteredFromSplash(false);
  };

  useBackHandler(enteredFromSplash && (!user || !isVerified), handleBackToSplash);

  if (!enteredFromSplash) {
    return <WelcomeSplash onEnter={handleEnterSplash} />;
  }

  if (loading) {
    return (
      <div className="min-h-[100dvh] bg-[#145f96] flex flex-col items-center justify-center gap-3 text-white p-6">
        <img
          src="/akrobit-icon.png"
          alt="Akrobit"
          className="w-16 h-16 rounded-2xl animate-pulse shadow-lg"
        />
        <p className="text-sm font-semibold tracking-wide">Cargando Akrobit...</p>
      </div>
    );
  }

  if (!user || !isVerified) {
    return <LoginScreen onBackToSplash={handleBackToSplash} />;
  }

  return <MainDashboard />;
}

export default function App() {
  if (isClientPortalRoute()) {
    return (
      <AppErrorBoundary>
        <ClientPortalPage />
      </AppErrorBoundary>
    );
  }

  return (
    <AppErrorBoundary>
      <AuthProvider>
        <AkrobitRouter />
      </AuthProvider>
    </AppErrorBoundary>
  );
}
