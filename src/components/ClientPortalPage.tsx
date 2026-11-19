import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Eye,
  EyeOff,
  History,
  KeyRound,
  LogOut,
  MessageCircle,
  Phone,
  ShieldCheck,
} from 'lucide-react';
import { doc, getDoc, getDocFromServer, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';
import {
  AKROBIT_BUSINESS_PHONE,
  AKROBIT_CATALOG_URL,
  AKROBIT_PRIMARY_DOMAIN,
  computePortalKey,
  formatPortalDateTime,
  normalizePortalPhoneInput,
} from '../lib/clientPortal';
import { useBackHandler } from '../lib/backNavigation';
import {
  buildWhatsAppLink,
  calculateCalendarDaysElapsed,
  calculateProratedInterestCeil,
  formatCurrency,
  getPortalAgingTier,
  isAndroidDevice,
  round2,
} from '../lib/finance';
import type { ClientPortalSnapshot } from '../types';

const PORTAL_SESSION_KEY = 'akrobit_client_portal_key';

export const ClientPortalPage: React.FC = () => {
  const [phoneInput, setPhoneInput] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [showCode, setShowCode] = useState(false);

  const [activeKey, setActiveKey] = useState<string>(() => {
    try {
      return sessionStorage.getItem(PORTAL_SESSION_KEY) || '';
    } catch {
      return '';
    }
  });
  const [portal, setPortal] = useState<ClientPortalSnapshot | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const handleExitPortal = () => {
    try {
      sessionStorage.removeItem(PORTAL_SESSION_KEY);
    } catch {
      // Ignore storage errors
    }
    setActiveKey('');
    setPortal(null);
    setCodeInput('');
    setErrorMsg('');
  };

  useBackHandler(Boolean(portal), handleExitPortal);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title = 'Akrobit · Portal de Clientes';
    }
  }, []);

  useEffect(() => {
    const refreshNow = () => setNowMs(Date.now());
    const interval = window.setInterval(refreshNow, 60_000);
    window.addEventListener('focus', refreshNow);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refreshNow();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshNow);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    if (!activeKey) {
      setPortal(null);
      return;
    }

    const portalRef = doc(db, 'clientPortals', activeKey);
    const unsub = onSnapshot(
      portalRef,
      (snap) => {
        if (!snap.exists()) {
          handleExitPortal();
          setErrorMsg(
            'Tu código de acceso fue renovado o ya no está activo. Solicita el código actual por WhatsApp.'
          );
          return;
        }
        setPortal(snap.data() as ClientPortalSnapshot);
      },
      (err) => {
        console.error('ClientPortal listener error:', err);
      }
    );

    return () => unsub();
  }, [activeKey]);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    const normalizedPhone = normalizePortalPhoneInput(phoneInput);
    const cleanCode = codeInput.replace(/\D/g, '');

    if (!normalizedPhone || normalizedPhone.length < 8) {
      setErrorMsg('Ingresa tu número de teléfono completo (ej. +50576881122 o tus 8 dígitos).');
      return;
    }
    if (cleanCode.length !== 6) {
      setErrorMsg('Ingresa el código secreto de 6 dígitos que recibiste por WhatsApp.');
      return;
    }

    setLoading(true);
    try {
      const candidateKey = await computePortalKey(normalizedPhone, cleanCode);
      const ref = doc(db, 'clientPortals', candidateKey);

      let snap;
      try {
        snap = await getDocFromServer(ref);
      } catch {
        snap = await getDoc(ref);
      }

      if (!snap.exists()) {
        setErrorMsg(
          'Teléfono o código secreto incorrectos. Verifica tus datos o solicita tu código por WhatsApp.'
        );
        return;
      }

      try {
        sessionStorage.setItem(PORTAL_SESSION_KEY, candidateKey);
      } catch {
        // Ignore storage errors
      }
      setPortal(snap.data() as ClientPortalSnapshot);
      setActiveKey(candidateKey);
    } catch (err) {
      console.error('Portal lookup error:', err);
      setErrorMsg('No se pudo verificar tu cuenta en este momento. Revisa tu conexión e intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  };

  const isAndroid = isAndroidDevice();
  const inIframe = typeof window !== 'undefined' && window.top !== window.self;
  const openInBlankTab = !isAndroid || inIframe;

  const normalizedTypedPhone = normalizePortalPhoneInput(phoneInput);
  const hasTypedPhone = normalizedTypedPhone.replace(/\D/g, '').length >= 8;

  const forgotCodeMessage = hasTypedPhone
    ? `Hola Akrobit, olvidé mi PIN de 6 dígitos para consultar mi cuenta en el portal. Mi número registrado es: ${normalizedTypedPhone}. ¿Me lo pueden reenviar, por favor?`
    : 'Hola Akrobit, solicito mi PIN de 6 dígitos para consultar mi estado de cuenta en el portal.';

  const forgotCodeWaLink = buildWhatsAppLink(AKROBIT_BUSINESS_PHONE, forgotCodeMessage);

  const clientSupportWaLink = buildWhatsAppLink(
    AKROBIT_BUSINESS_PHONE,
    portal
      ? `Hola Akrobit, soy ${portal.clientName}. Escribo respecto a mi estado de cuenta.`
      : 'Hola Akrobit, escribo respecto a mi estado de cuenta.'
  );

  const livePortalSummary = useMemo(() => {
    if (!portal) {
      return {
        liveCredits: [],
        totalNio: 0,
        totalUsd: 0,
        maxDaysWithoutPayment: 0,
        overallTier: 'green' as const,
      };
    }

    let totalNio = 0;
    let totalUsd = 0;
    let maxDaysWithoutPayment = 0;

    const liveCredits = portal.activeCredits.map((cr) => {
      const hasActivity = typeof cr.lastActivityMs === 'number' && cr.lastActivityMs > 0;
      const daysElapsed = hasActivity
        ? calculateCalendarDaysElapsed(cr.lastActivityMs!, nowMs)
        : 0;

      let accruedInterest = 0;
      if (hasActivity) {
        if (cr.interestMode === 'prorated_daily') {
          accruedInterest = calculateProratedInterestCeil(
            cr.currentBalance,
            cr.interestRate,
            daysElapsed
          );
        } else {
          const extraDays = Math.max(0, daysElapsed - 30);
          if (extraDays > 0) {
            accruedInterest = calculateProratedInterestCeil(
              cr.currentBalance,
              cr.interestRate,
              extraDays
            );
          }
        }
      }

      const totalDueToday = round2(cr.currentBalance + accruedInterest);
      if (cr.currency === 'NIO') totalNio = round2(totalNio + totalDueToday);
      else totalUsd = round2(totalUsd + totalDueToday);

      if (daysElapsed > maxDaysWithoutPayment) {
        maxDaysWithoutPayment = daysElapsed;
      }

      return {
        ...cr,
        daysElapsed,
        accruedInterest,
        totalDueToday,
        tier: getPortalAgingTier(daysElapsed),
      };
    });

    if (portal.activeCredits.length === 0) {
      totalNio = portal.totalNio;
      totalUsd = portal.totalUsd;
    }

    return {
      liveCredits,
      totalNio,
      totalUsd,
      maxDaysWithoutPayment,
      overallTier: getPortalAgingTier(maxDaysWithoutPayment),
    };
  }, [portal, nowMs]);

  return (
    <div className="min-h-[100dvh] bg-slate-50 flex flex-col">
      {/* Official Akrobit Corporate Header */}
      <header className="w-full bg-[#145f96] shadow-md">
        <div className="mx-auto max-w-4xl px-4 py-2.5 flex items-center justify-center">
          <img
            src="/akrobit-banner.png"
            alt="Akrobit Logotipo Oficial"
            className="h-12 sm:h-14 w-auto max-w-full object-contain"
          />
        </div>
        <div className="grid grid-cols-4 h-1 w-full">
          <div className="bg-[#a1d63e]" />
          <div className="bg-[#df7729]" />
          <div className="bg-[#69b8e9]" />
          <div className="bg-[#d12925]" />
        </div>
      </header>

      <main className="flex-1 px-3 sm:px-6 py-6">
        {!portal ? (
          <div className="mx-auto max-w-md pt-2 sm:pt-6">
            <div className="rounded-2xl bg-white border-2 border-[#145f96]/20 shadow-xl p-6 sm:p-8 space-y-5">
              <div className="flex items-center gap-3">
                <img
                  src="/akrobit-icon.png"
                  alt="Akrobit"
                  className="w-11 h-11 rounded-xl shadow-sm shrink-0"
                />
                <div>
                  <h1 className="text-lg font-bold text-[#145f96]">Portal de Clientes</h1>
                  <p className="text-xs text-slate-500">
                    Consulta tu saldo en tiempo real · {AKROBIT_PRIMARY_DOMAIN}
                  </p>
                </div>
              </div>

              {errorMsg && (
                <div className="rounded-xl bg-[#d12925]/10 border border-[#d12925]/30 px-3.5 py-2.5 text-xs font-semibold text-[#b91c1c]">
                  {errorMsg}
                </div>
              )}

              <form onSubmit={handleUnlock} className="space-y-4">
                <div>
                  <label
                    htmlFor="portal-phone"
                    className="block text-xs font-bold text-[#145f96] mb-1.5"
                  >
                    Número de teléfono
                  </label>
                  <div className="relative">
                    <Phone className="w-4 h-4 text-[#69b8e9] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      id="portal-phone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      value={phoneInput}
                      onChange={(e) => setPhoneInput(e.target.value)}
                      placeholder="Ej. +50576881122 o 76881122"
                      className="w-full min-h-[46px] rounded-xl border-2 border-[#145f96]/25 bg-slate-50/70 pl-10 pr-4 text-sm font-mono text-slate-900 placeholder:font-sans placeholder:text-slate-400 focus:border-[#69b8e9] focus:bg-white focus:outline-none transition-colors"
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="portal-code"
                    className="block text-xs font-bold text-[#145f96] mb-1.5"
                  >
                    Código secreto (6 dígitos)
                  </label>
                  <div className="relative">
                    <KeyRound className="w-4 h-4 text-[#df7729] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      id="portal-code"
                      type={showCode ? 'text' : 'password'}
                      inputMode="numeric"
                      maxLength={6}
                      value={codeInput}
                      onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="••••••"
                      className="w-full min-h-[46px] rounded-xl border-2 border-[#145f96]/25 bg-slate-50/70 pl-10 pr-12 text-base font-mono font-bold tracking-[0.25em] text-slate-900 placeholder:tracking-widest placeholder:text-slate-400 focus:border-[#df7729] focus:bg-white focus:outline-none transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => setShowCode((prev) => !prev)}
                      aria-label={showCode ? 'Ocultar código' : 'Ver código'}
                      className="absolute right-1 top-1/2 -translate-y-1/2 min-h-[40px] min-w-[40px] flex items-center justify-center text-slate-500 hover:text-[#145f96] cursor-pointer"
                    >
                      {showCode ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full min-h-[48px] rounded-xl bg-[#145f96] hover:bg-[#0e4670] disabled:opacity-60 text-white font-bold text-sm shadow-md transition-colors cursor-pointer"
                >
                  {loading ? 'Verificando acceso...' : 'Ver mi estado de cuenta'}
                </button>
              </form>

              <div className="border-t border-slate-100 pt-4 text-center space-y-2">
                <p className="text-xs text-slate-500">¿No tienes u olvidaste tu PIN de acceso?</p>
                <a
                  href={forgotCodeWaLink}
                  target={openInBlankTab ? '_blank' : undefined}
                  rel={openInBlankTab ? 'noopener noreferrer' : undefined}
                  className="w-full min-h-[44px] rounded-xl bg-[#25D366]/15 hover:bg-[#25D366]/25 border border-[#25D366]/40 text-slate-900 font-bold text-xs flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 px-3"
                >
                  <MessageCircle className="w-4 h-4 text-[#15803d] shrink-0" />
                  <span>Solicitar PIN por WhatsApp</span>
                </a>
                <p className="text-[11px] text-slate-500 leading-snug">
                  {hasTypedPhone
                    ? `Tu número (${normalizedTypedPhone}) se incluirá automáticamente en el mensaje.`
                    : 'Escribe tu número arriba antes de tocar el botón para enviarlo ya incluido.'}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl space-y-4">
            {/* Client Summary Header */}
            <div className="rounded-2xl bg-[#145f96] text-white p-4 sm:p-5 shadow-md space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#a1d63e] mb-0.5">
                    <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                    <span>Estado de cuenta verificado · En vivo</span>
                  </div>
                  <h1 className="text-lg sm:text-xl font-bold truncate">{portal.clientName}</h1>
                  <p className="text-[11px] text-white/75">
                    Actualizado: {formatPortalDateTime(portal.updatedAt)}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleExitPortal}
                  className="min-h-[40px] px-3 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-bold flex items-center gap-1.5 cursor-pointer shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Salir</span>
                </button>
              </div>

              {livePortalSummary.totalNio <= 0 && livePortalSummary.totalUsd <= 0 ? (
                <div className="rounded-xl bg-[#a1d63e]/20 border border-[#a1d63e]/50 px-4 py-3 flex items-center gap-2.5">
                  <CheckCircle2 className="w-5 h-5 text-[#a1d63e] shrink-0" />
                  <div>
                    <p className="text-sm font-bold text-white">¡Cuenta al día!</p>
                    <p className="text-xs text-white/85">
                      No tienes saldos pendientes en este momento.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="rounded-xl bg-white/10 px-3.5 py-2.5 border border-white/15">
                      <span className="text-[11px] text-white/75 block">Total al día (C$)</span>
                      <span className="text-base font-bold font-mono tabular-nums text-[#a1d63e]">
                        {formatCurrency(livePortalSummary.totalNio, 'NIO')}
                      </span>
                    </div>
                    <div className="rounded-xl bg-white/10 px-3.5 py-2.5 border border-white/15">
                      <span className="text-[11px] text-white/75 block">Total al día (USD)</span>
                      <span className="text-base font-bold font-mono tabular-nums text-[#69b8e9]">
                        {formatCurrency(livePortalSummary.totalUsd, 'USD')}
                      </span>
                    </div>
                  </div>

                  {/* Corporate Aging Banner: Green (1-19d) | Orange (20-29d) | Red (30+d) */}
                  {(() => {
                    const days = livePortalSummary.maxDaysWithoutPayment;
                    const tier = livePortalSummary.overallTier;

                    if (tier === 'red') {
                      return (
                        <div className="rounded-xl bg-[#d12925] px-4 py-3 flex items-start gap-2.5 shadow-sm">
                          <AlertTriangle className="w-5 h-5 text-white shrink-0 mt-0.5" />
                          <div className="text-xs leading-snug text-white">
                            <p className="font-bold text-sm">
                              Llevas {days} días sin realizar abono o pago
                            </p>
                            <p className="text-white/90 mt-0.5">
                              El interés se calcula proporcionalmente sobre tu saldo de capital hasta el día exacto de tu pago.
                            </p>
                          </div>
                        </div>
                      );
                    }

                    if (tier === 'orange') {
                      return (
                        <div className="rounded-xl bg-[#df7729] px-4 py-2.5 flex items-center justify-between gap-2 text-xs text-white shadow-sm">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="w-2.5 h-2.5 rounded-full bg-white shrink-0" />
                            <span className="font-bold truncate">
                              {days} días sin abono · Próximo a vencimiento (30 días)
                            </span>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div className="rounded-xl bg-[#a1d63e]/20 border border-[#a1d63e]/50 px-3.5 py-2 flex items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="w-2.5 h-2.5 rounded-full bg-[#a1d63e] shrink-0" />
                          <span className="font-bold text-[#a1d63e] truncate">
                            {days === 0
                              ? 'Cuenta al día · Hoy es día 0'
                              : `Cuenta al día · ${days} día${days === 1 ? '' : 's'} transcurrido${days === 1 ? '' : 's'}`}
                          </span>
                        </div>
                        <span className="text-[11px] text-white/80 shrink-0">Estado normal</span>
                      </div>
                    );
                  })()}
                </>
              )}
            </div>

            {/* Active Credits Breakdown (Read-Only, Live Daily Interest) */}
            {livePortalSummary.liveCredits.length > 0 && (
              <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden shadow-sm">
                <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-bold text-[#145f96]">
                    <CreditCard className="w-4 h-4" />
                    <span>Créditos Activos</span>
                  </div>
                  <span className="text-xs font-semibold text-slate-500">
                    {livePortalSummary.liveCredits.length} activo(s)
                  </span>
                </div>

                <div className="divide-y divide-slate-200/70 akrobit-zebra-rows">
                  {livePortalSummary.liveCredits.map((cr, idx) => {
                    const tierUnderlineCls =
                      cr.tier === 'red'
                        ? 'shadow-[inset_0_-3px_0_0_#d12925]'
                        : cr.tier === 'orange'
                          ? 'shadow-[inset_0_-3px_0_0_#df7729]'
                          : 'shadow-[inset_0_-2px_0_0_#a1d63e]';
                    const tierTextCls =
                      cr.tier === 'red'
                        ? 'text-[#d12925]'
                        : cr.tier === 'orange'
                          ? 'text-[#df7729]'
                          : 'text-[#4d7c0f]';

                    return (
                      <div
                        key={`${cr.label}-${idx}`}
                        className={`px-4 py-3.5 space-y-2 ${tierUnderlineCls}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm font-bold text-[#145f96]">{cr.label}</p>
                              <span className={`text-xs font-bold ${tierTextCls}`}>
                                {cr.daysElapsed >= 30
                                  ? `· ${cr.daysElapsed} días sin abono o pago`
                                  : `· ${cr.daysElapsed} día${cr.daysElapsed === 1 ? '' : 's'}`}
                              </span>
                            </div>
                            <p className="text-xs text-slate-500">
                              {cr.dateLabel} · Tasa mensual: {cr.interestRate}% s/saldo
                            </p>
                          </div>

                          <div className="text-right shrink-0">
                            <span className="text-[11px] text-slate-500 block">
                              Total al día de hoy
                            </span>
                            <span className="text-sm font-mono font-bold text-slate-900 tabular-nums">
                              {formatCurrency(cr.totalDueToday, cr.currency)}
                            </span>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 rounded-xl bg-slate-50/90 border border-slate-200/80 px-3 py-2 text-[11px]">
                          <div>
                            <span className="text-slate-500 block">Capital vigente</span>
                            <span className="font-mono font-bold text-slate-800 tabular-nums">
                              {formatCurrency(cr.currentBalance, cr.currency)}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-500 block">
                              Interés al día ({cr.daysElapsed}d)
                            </span>
                            <span className={`font-mono font-bold tabular-nums ${tierTextCls}`}>
                              + {formatCurrency(cr.accruedInterest, cr.currency)}
                            </span>
                          </div>
                          {cr.interestMode === 'prorated_daily' && cr.projected30DayTotal ? (
                            <div className="col-span-2 sm:col-span-1">
                              <span className="text-slate-500 block">Ref. a 30 días</span>
                              <span className="font-mono font-semibold text-[#145f96] tabular-nums">
                                {formatCurrency(cr.projected30DayTotal, cr.currency)}
                              </span>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Complete Movements Ledger */}
            <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden shadow-sm">
              <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-bold text-[#145f96]">
                  <History className="w-4 h-4" />
                  <span>Historial de Movimientos</span>
                </div>
                <span className="text-xs text-slate-500">
                  {portal.recentTransactions.length} registro(s)
                </span>
              </div>

              {portal.recentTransactions.length === 0 ? (
                <p className="text-xs text-slate-500 px-4 py-6 text-center">
                  Aún no tienes movimientos registrados.
                </p>
              ) : (
                <div className="divide-y divide-slate-200/70 akrobit-zebra-rows">
                  {portal.recentTransactions.map((tx, idx) => (
                    <div
                      key={idx}
                      className="px-4 py-3 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="min-w-0">
                        <p className="font-bold text-slate-900">
                          {tx.type === 'credit'
                            ? `Crédito otorgado (${tx.interestRate}%)`
                            : tx.type === 'payment'
                              ? 'Abono realizado'
                              : 'Ajuste de registro'}
                        </p>
                        <p className="text-slate-500">{tx.dateLabel}</p>
                        {tx.note && <p className="text-slate-500 truncate">{tx.note}</p>}
                      </div>
                      <div className="text-right shrink-0 font-mono tabular-nums">
                        <p
                          className={`font-bold ${
                            tx.type === 'payment' ? 'text-[#4d7c0f]' : 'text-[#145f96]'
                          }`}
                        >
                          {tx.type === 'payment' ? '-' : ''}
                          {formatCurrency(tx.amount, tx.currency)}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          Saldo: {formatCurrency(tx.newBalance, tx.currency)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer Actions: WhatsApp Business & Catalog */}
            <div className="space-y-2.5 pt-1 pb-6">
              <a
                href={clientSupportWaLink}
                target={openInBlankTab ? '_blank' : undefined}
                rel={openInBlankTab ? 'noopener noreferrer' : undefined}
                className="w-full min-h-[48px] rounded-xl bg-[#25D366] hover:bg-[#1fb857] text-slate-950 font-bold text-sm shadow-md flex items-center justify-center gap-2 transition-colors"
              >
                <MessageCircle className="w-5 h-5" />
                <span>Consultar o reportar pago por WhatsApp</span>
              </a>

              <a
                href={AKROBIT_CATALOG_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full min-h-[44px] rounded-xl bg-white border border-slate-200 hover:bg-slate-50 text-[#145f96] font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                <span>Ver Catálogo de Akrobit</span>
              </a>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
