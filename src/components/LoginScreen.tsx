import React, { useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  MoreVertical,
  RefreshCw,
  ShieldCheck,
  User,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useBackHandler } from '../lib/backNavigation';

type AuthView = 'login' | 'forgot';

interface SecurityChallenge {
  prompt: string;
  answer: number;
}

function createSecurityChallenge(): SecurityChallenge {
  const randInt = (min: number, max: number) =>
    Math.floor(Math.random() * (max - min + 1)) + min;

  const pattern = randInt(0, 3);
  if (pattern === 0) {
    const a = randInt(4, 9);
    const b = randInt(3, 8);
    const c = randInt(5, 19);
    return { prompt: `(${a} × ${b}) + ${c}`, answer: a * b + c };
  }
  if (pattern === 1) {
    const a = randInt(5, 9);
    const b = randInt(4, 8);
    const c = randInt(3, 14);
    return { prompt: `(${a} × ${b}) - ${c}`, answer: a * b - c };
  }
  if (pattern === 2) {
    const a = randInt(11, 24);
    const b = randInt(4, 15);
    const c = randInt(2, 3);
    return { prompt: `(${a} + ${b}) × ${c}`, answer: (a + b) * c };
  }
  const a = randInt(12, 35);
  const b = randInt(3, 8);
  const c = randInt(3, 7);
  return { prompt: `${a} + (${b} × ${c})`, answer: a + b * c };
}

interface LoginScreenProps {
  onBackToSplash: () => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onBackToSplash }) => {
  const {
    user,
    isVerified,
    signInWithEmail,
    sendResetEmail,
    resendVerificationEmail,
    refreshUserSession,
    logout,
  } = useAuth();

  const [view, setView] = useState<AuthView>('login');
  const [menuOpen, setMenuOpen] = useState(false);

  useBackHandler(view !== 'login', () => {
    setErrorMsg('');
    setInfoMsg('');
    setResetSent(false);
    setView('login');
  });
  useBackHandler(menuOpen, () => setMenuOpen(false));

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Complex 2-step security challenge for Password Recovery
  const [resetEmail, setResetEmail] = useState('');
  const [challenge, setChallenge] = useState<SecurityChallenge>(() => createSecurityChallenge());
  const [challengeAnswer, setChallengeAnswer] = useState('');
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState<number>(0);
  const [resetSent, setResetSent] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [infoMsg, setInfoMsg] = useState('');

  const regenerateChallenge = () => {
    setChallenge(createSecurityChallenge());
    setChallengeAnswer('');
  };

  const mapAuthError = (err: unknown): string => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('auth/invalid-credential') || msg.includes('auth/wrong-password')) {
      return 'Usuario o contraseña incorrectos. Verifica tus datos o usa "Olvidé contraseña".';
    }
    if (msg.includes('auth/user-not-found')) {
      return 'No existe una cuenta registrada con ese correo.';
    }
    if (msg.includes('auth/email-already-in-use')) {
      return 'Ese correo ya está registrado. Inicia sesión o recupera tu contraseña.';
    }
    if (msg.includes('auth/weak-password')) {
      return 'La contraseña debe tener al menos 6 caracteres.';
    }
    if (msg.includes('auth/invalid-email')) {
      return 'Ingresa un correo electrónico válido.';
    }
    if (msg.includes('auth/too-many-requests')) {
      return 'Demasiados intentos seguidos. Espera un momento por seguridad.';
    }
    if (msg.includes('auth/operation-not-allowed')) {
      return 'El inicio con Correo/Contraseña aún debe activarse en Firebase Console (Authentication → Sign-in method).';
    }
    return 'No se pudo completar la operación. Verifica tu conexión e intenta de nuevo.';
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setInfoMsg('');
    if (!email.trim() || !password) {
      setErrorMsg('Completa tu usuario (correo) y contraseña.');
      return;
    }
    setSubmitting(true);
    try {
      await signInWithEmail(email, password);
    } catch (err) {
      setErrorMsg(mapAuthError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setInfoMsg('');

    const now = Date.now();
    if (lockedUntil > now) {
      const waitSec = Math.ceil((lockedUntil - now) / 1000);
      setErrorMsg(`Demasiados intentos fallidos. Espera ${waitSec} segundos para volver a intentar.`);
      return;
    }

    if (!resetEmail.trim() || !resetEmail.includes('@')) {
      setErrorMsg('Ingresa el correo electrónico asociado a tu cuenta.');
      return;
    }

    const parsedAnswer = Number(challengeAnswer.trim());
    if (!challengeAnswer.trim() || !Number.isFinite(parsedAnswer) || parsedAnswer !== challenge.answer) {
      const nextAttempts = failedAttempts + 1;
      setFailedAttempts(nextAttempts);
      if (nextAttempts >= 3) {
        setLockedUntil(Date.now() + 30_000);
        setFailedAttempts(0);
        setErrorMsg('Verificación incorrecta 3 veces. Espera 30 segundos por seguridad.');
      } else {
        setErrorMsg(`Resultado incorrecto (intento ${nextAttempts} de 3). Resuelve la nueva operación.`);
      }
      regenerateChallenge();
      return;
    }

    setFailedAttempts(0);
    setSubmitting(true);
    try {
      await sendResetEmail(resetEmail);
      setResetSent(true);
      setInfoMsg(
        `Hemos enviado un enlace seguro de restablecimiento a ${resetEmail.trim()}. Revisa tu bandeja de entrada o spam.`
      );
    } catch (err) {
      setErrorMsg(mapAuthError(err));
      regenerateChallenge();
    } finally {
      setSubmitting(false);
    }
  };

  // Pending email verification screen for newly registered email/password accounts
  if (user && !isVerified) {
    return (
      <div className="min-h-[100dvh] bg-slate-50 flex flex-col">
        <div className="w-full bg-[#145f96] border-b-4 border-[#df7729] flex items-center justify-center px-4 py-2.5">
          <img
            src="/akrobit-banner.png"
            alt="Akrobit"
            className="h-12 sm:h-14 w-auto object-contain"
          />
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-lg p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-[#69b8e9]/15 text-[#145f96] flex items-center justify-center">
                <ShieldCheck className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-[#145f96]">Verifica tu correo</h2>
                <p className="text-xs text-slate-500">{user.email}</p>
              </div>
            </div>

            <p className="text-sm text-slate-600 leading-relaxed">
              Por seguridad de tus registros en <strong>Akrobit</strong>, confirma tu dirección de
              correo electrónico desde el enlace que te enviamos antes de acceder al panel.
            </p>

            {infoMsg && (
              <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-3.5 py-2.5 text-xs font-medium text-emerald-800">
                {infoMsg}
              </div>
            )}

            <div className="space-y-2.5 pt-1">
              <button
                type="button"
                onClick={async () => {
                  setInfoMsg('');
                  await refreshUserSession();
                }}
                className="w-full min-h-[46px] rounded-xl bg-[#a1d63e] hover:bg-[#8ec22f] text-slate-950 font-bold text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" />
                <span>Ya verifiqué mi correo, entrar</span>
              </button>

              <button
                type="button"
                onClick={async () => {
                  await resendVerificationEmail();
                  setInfoMsg('Correo de verificación reenviado correctamente.');
                }}
                className="w-full min-h-[44px] rounded-xl border border-[#145f96]/30 text-[#145f96] hover:bg-[#145f96]/5 font-semibold text-sm transition-colors cursor-pointer"
              >
                Reenviar correo de verificación
              </button>

              <button
                type="button"
                onClick={logout}
                className="w-full py-2 text-xs font-medium text-slate-500 hover:text-slate-800 cursor-pointer"
              >
                Cerrar sesión e ingresar con otra cuenta
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] w-full bg-slate-50 flex flex-col">
      {/* Top Horizontal Corporate Banner — full Akrobit logo with original #145f96 corporate background */}
      <header className="w-full bg-[#145f96] shadow-md">
        <div className="mx-auto max-w-5xl px-3 sm:px-6 py-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onBackToSplash}
            aria-label="Volver a portada"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-white/85 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <div className="flex-1 flex items-center justify-center overflow-hidden">
            <img
              src="/akrobit-banner.png"
              alt="Akrobit Logotipo Oficial"
              className="h-12 sm:h-16 w-auto max-w-full object-contain"
            />
          </div>

          {/* Balanced right spacer matching back button width */}
          <div className="w-[44px] shrink-0" aria-hidden="true" />
        </div>

        {/* Four-color corporate accent hairline inspired by the Akrobit icon */}
        <div className="grid grid-cols-4 h-1 w-full">
          <div className="bg-[#a1d63e]" />
          <div className="bg-[#df7729]" />
          <div className="bg-[#69b8e9]" />
          <div className="bg-[#d12925]" />
        </div>
      </header>

      {/* Main Auth Area */}
      <main className="flex-1 flex items-center justify-center px-4 py-6 sm:py-10">
        <div className="relative w-full max-w-md rounded-2xl bg-white border-2 border-[#145f96]/20 shadow-xl p-6 sm:p-8">
          {/* Card Header with Top-Right Hidden Options Icon */}
          <div className="flex items-start justify-between gap-3 mb-6">
            <div className="flex items-center gap-3">
              <img
                src="/akrobit-icon.png"
                alt="Akrobit"
                className="w-11 h-11 rounded-xl shadow-sm shrink-0"
              />
              <div>
                <h1 className="text-xl font-bold text-[#145f96]">
                  {view === 'login' ? 'Inicio de Sesión' : 'Recuperar Contraseña'}
                </h1>
                <p className="text-xs text-slate-500">
                  {view === 'login'
                    ? 'Ingresa tus credenciales corporativas'
                    : 'Verificación de identidad Akrobit'}
                </p>
              </div>
            </div>

            {/* Right-corner hidden menu icon containing "Olvidé contraseña" */}
            <div className="relative">
              <button
                type="button"
                aria-label="Opciones de acceso"
                onClick={() => setMenuOpen((prev) => !prev)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-[#145f96] hover:bg-[#145f96]/8 border border-slate-200 transition-colors cursor-pointer"
              >
                <MoreVertical className="w-5 h-5" />
              </button>

              {menuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setMenuOpen(false)}
                    aria-hidden="true"
                  />
                  <div className="absolute right-0 mt-1.5 w-56 rounded-xl bg-white border border-slate-200 shadow-xl py-1.5 z-20">
                    {view === 'login' ? (
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          setErrorMsg('');
                          setInfoMsg('');
                          setResetSent(false);
                          setResetEmail(email);
                          regenerateChallenge();
                          setView('forgot');
                        }}
                        className="w-full px-4 py-2.5 text-left text-sm font-medium text-slate-800 hover:bg-[#df7729]/10 hover:text-[#145f96] flex items-center gap-2.5 cursor-pointer"
                      >
                        <KeyRound className="w-4 h-4 text-[#df7729]" />
                        <span>Olvidé contraseña</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          setErrorMsg('');
                          setInfoMsg('');
                          setResetSent(false);
                          setView('login');
                        }}
                        className="w-full px-4 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-[#69b8e9]/10 hover:text-[#145f96] flex items-center gap-2.5 cursor-pointer"
                      >
                        <User className="w-4 h-4 text-[#69b8e9]" />
                        <span>Volver a Iniciar sesión</span>
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          {errorMsg && (
            <div className="mb-4 rounded-xl bg-[#d12925]/10 border border-[#d12925]/30 px-3.5 py-2.5 text-xs font-medium text-[#b91c1c]">
              {errorMsg}
            </div>
          )}

          {infoMsg && (
            <div className="mb-4 rounded-xl bg-[#a1d63e]/15 border border-[#a1d63e]/40 px-3.5 py-2.5 text-xs font-medium text-slate-800 flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-[#4d7c0f] shrink-0 mt-0.5" />
              <span>{infoMsg}</span>
            </div>
          )}

          {/* VIEW 1: LOGIN FORM */}
          {view === 'login' && (
            <form onSubmit={handleLoginSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="login-email"
                  className="block text-xs font-bold text-[#145f96] mb-1.5"
                >
                  Usuario (Correo electrónico)
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-[#69b8e9] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="login-email"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="usuario@akrobit.com"
                    className="w-full min-h-[46px] rounded-xl border-2 border-[#145f96]/25 bg-slate-50/70 pl-10 pr-4 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#69b8e9] focus:bg-white focus:outline-none transition-colors"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="login-password"
                  className="block text-xs font-bold text-[#145f96] mb-1.5"
                >
                  Contraseña
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-[#df7729] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full min-h-[46px] rounded-xl border-2 border-[#145f96]/25 bg-slate-50/70 pl-10 pr-12 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#df7729] focus:bg-white focus:outline-none transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={showPassword ? 'Ocultar contraseña' : 'Ver contraseña'}
                    className="absolute right-1 top-1/2 -translate-y-1/2 min-h-[40px] min-w-[40px] flex items-center justify-center text-slate-500 hover:text-[#145f96] cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full min-h-[48px] rounded-xl bg-[#145f96] hover:bg-[#0e4670] disabled:opacity-60 text-white font-semibold text-base shadow-md transition-colors cursor-pointer flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <span className="text-sm font-bold">Verificando...</span>
                ) : (
                  <>
                    <span className="tracking-tight leading-none">Acceder a</span>
                    <img
                      src="/akrobit-logo-tight.png"
                      alt="Akrobit"
                      className="h-5 w-auto object-contain"
                    />
                  </>
                )}
              </button>
            </form>
          )}

          {/* VIEW 2: FORGOT PASSWORD WITH COMPLEX SECURITY VERIFICATION */}
          {view === 'forgot' && (
            <form onSubmit={handleResetSubmit} className="space-y-4">
              <div className="rounded-xl bg-[#145f96]/5 border border-[#145f96]/20 p-3.5 text-xs text-slate-700 leading-relaxed flex items-start gap-2.5">
                <ShieldCheck className="w-5 h-5 text-[#145f96] shrink-0 mt-0.5" />
                <span>
                  Para proteger tu cuenta, resuelve la verificación de seguridad y enviaremos un
                  enlace único de cambio de contraseña a tu correo registrado.
                </span>
              </div>

              <div>
                <label
                  htmlFor="reset-email"
                  className="block text-xs font-bold text-[#145f96] mb-1.5"
                >
                  Correo de la cuenta
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-[#69b8e9] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="reset-email"
                    type="email"
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value)}
                    placeholder="usuario@akrobit.com"
                    className="w-full min-h-[46px] rounded-xl border-2 border-[#145f96]/25 bg-slate-50/70 pl-10 pr-4 text-sm text-slate-900 focus:border-[#69b8e9] focus:bg-white focus:outline-none"
                  />
                </div>
              </div>

              <div className="rounded-xl border-2 border-[#145f96]/20 bg-slate-50 p-3.5 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="reset-challenge"
                    className="text-xs font-bold text-[#145f96]"
                  >
                    Verificación de seguridad (2 pasos)
                  </label>
                  <button
                    type="button"
                    onClick={regenerateChallenge}
                    className="inline-flex items-center gap-1 text-[11px] font-bold text-[#145f96] hover:text-[#df7729] transition-colors cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Otro reto</span>
                  </button>
                </div>

                <div
                  aria-label={`Operación de seguridad: ${challenge.prompt}`}
                  className="rounded-xl bg-[#145f96] px-4 py-2.5 flex items-center justify-center relative overflow-hidden select-none"
                >
                  <svg
                    viewBox="0 0 260 44"
                    className="w-full max-w-[260px] h-10"
                    role="img"
                    aria-label={challenge.prompt}
                  >
                    <line x1="10" y1="8" x2="250" y2="36" stroke="#69b8e9" strokeOpacity="0.22" strokeWidth="1.5" />
                    <line x1="20" y1="38" x2="240" y2="8" stroke="#df7729" strokeOpacity="0.24" strokeWidth="1.5" />
                    <text
                      x="130"
                      y="29"
                      textAnchor="middle"
                      fill="#ffffff"
                      fontSize="20"
                      fontWeight="700"
                      fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                      letterSpacing="2"
                    >
                      {challenge.prompt} = ?
                    </text>
                  </svg>
                </div>

                <input
                  id="reset-challenge"
                  type="number"
                  inputMode="numeric"
                  value={challengeAnswer}
                  onChange={(e) => setChallengeAnswer(e.target.value)}
                  placeholder="Ingresa el resultado exacto"
                  className="w-full min-h-[46px] rounded-xl border-2 border-[#145f96]/25 bg-white px-3.5 text-sm font-mono font-bold text-slate-900 tabular-nums focus:border-[#a1d63e] focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={submitting || resetSent}
                className="w-full min-h-[48px] rounded-xl bg-[#df7729] hover:bg-[#c8641a] disabled:opacity-60 text-white font-bold text-sm shadow-md transition-colors cursor-pointer"
              >
                {submitting
                  ? 'Enviando enlace seguro...'
                  : resetSent
                    ? 'Enlace enviado al correo'
                    : 'Enviar enlace de recuperación'}
              </button>

              <button
                type="button"
                onClick={() => {
                  setErrorMsg('');
                  setInfoMsg('');
                  setResetSent(false);
                  setView('login');
                }}
                className="w-full py-2 text-xs font-semibold text-[#145f96] hover:underline cursor-pointer"
              >
                Volver al inicio de sesión
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
};
