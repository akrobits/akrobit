import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search, UserCheck, X } from 'lucide-react';
import type { ContactCandidate } from '../lib/contactsAdapter';
import { cleanPhoneInput } from '../lib/finance';
import { useBackHandler } from '../lib/backNavigation';
import {
  clearGoogleContactsToken,
  connectGoogleContacts,
  fetchGoogleContacts,
  getCachedGoogleAccountEmail,
  hasCachedGoogleContactsToken,
  loadCachedContactsDirectory,
  saveCachedContactsDirectory,
} from '../lib/googleContacts';

export type ImportModalMode = 'closed' | 'google' | 'vcf' | 'android-native';

interface ContactImportModalProps {
  mode: ImportModalMode;
  currentUserId: string;
  initialCandidates?: ContactCandidate[];
  onClose: () => void;
  onSelectContact: (name: string, phone: string, sourceLabel: string) => void | Promise<void>;
}

export const ContactImportModal: React.FC<ContactImportModalProps> = ({
  mode,
  currentUserId,
  initialCandidates = [],
  onClose,
  onSelectContact,
}) => {
  const [candidates, setCandidates] = useState<ContactCandidate[]>(initialCandidates);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [needsGoogleSignIn, setNeedsGoogleSignIn] = useState(false);
  const [connectedEmail, setConnectedEmail] = useState<string | null>(getCachedGoogleAccountEmail());

  useBackHandler(mode !== 'closed', onClose);

  useEffect(() => {
    if (mode === 'closed') {
      setSearchQuery('');
      setErrorMsg('');
      return;
    }

    if (mode === 'vcf' || mode === 'android-native') {
      setCandidates(initialCandidates);
      setNeedsGoogleSignIn(false);
      setLoading(false);
      setErrorMsg('');
      return;
    }

    if (mode === 'google') {
      setSearchQuery('');
      setErrorMsg('');
      void initGoogleMode();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, initialCandidates, currentUserId]);

  const initGoogleMode = async () => {
    const cachedSnapshot = await loadCachedContactsDirectory(currentUserId);
    if (cachedSnapshot && cachedSnapshot.contacts.length > 0) {
      setCandidates(cachedSnapshot.contacts);
      setConnectedEmail(cachedSnapshot.googleEmail || getCachedGoogleAccountEmail());
      setNeedsGoogleSignIn(false);
      setLoading(false);

      // Silently refresh in background ONLY if an in-memory access token is active
      if (hasCachedGoogleContactsToken()) {
        try {
          const { accessToken, email } = await connectGoogleContacts(false);
          const fresh = await fetchGoogleContacts(accessToken);
          setCandidates(fresh);
          setConnectedEmail(email);
          await saveCachedContactsDirectory(currentUserId, email, fresh);
        } catch {
          // Keep cached directory silently if background refresh fails
        }
      }
      return;
    }

    if (hasCachedGoogleContactsToken()) {
      await loadGoogleContactsWithCachedToken();
    } else {
      setNeedsGoogleSignIn(true);
      setCandidates([]);
    }
  };

  const loadGoogleContactsWithCachedToken = async () => {
    setLoading(true);
    setErrorMsg('');
    try {
      const { accessToken, email } = await connectGoogleContacts(false);
      setConnectedEmail(email);
      const list = await fetchGoogleContacts(accessToken);
      setCandidates(list);
      setNeedsGoogleSignIn(false);
      await saveCachedContactsDirectory(currentUserId, email, list);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'AUTH_EXPIRED') {
        clearGoogleContactsToken();
        setErrorMsg('Para sincronizar contactos nuevos, vuelve a confirmar tu cuenta de Google.');
        if (candidates.length === 0) {
          setNeedsGoogleSignIn(true);
        }
      } else {
        setErrorMsg(msg || 'No se pudieron actualizar los contactos de Google.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleConnectClick = async (forceSwitch: boolean) => {
    setErrorMsg('');
    setLoading(true);
    try {
      const { accessToken, email } = await connectGoogleContacts(forceSwitch);
      setConnectedEmail(email);
      const list = await fetchGoogleContacts(accessToken);
      setCandidates(list);
      setNeedsGoogleSignIn(false);
      await saveCachedContactsDirectory(currentUserId, email, list);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (raw.includes('popup-closed-by-user') || raw.includes('cancelled-popup-request')) {
        setErrorMsg('Cerraste la ventana de Google antes de completar el permiso.');
      } else if (raw.includes('popup-blocked')) {
        setErrorMsg('El navegador bloqueó la ventana de Google. Toca el botón de nuevo para permitirla.');
      } else if (raw === 'AUTH_EXPIRED') {
        clearGoogleContactsToken();
        if (candidates.length === 0) setNeedsGoogleSignIn(true);
        setErrorMsg('No se obtuvo permiso de lectura de contactos. Intenta conectarte otra vez.');
      } else {
        setErrorMsg(`No se pudo conectar Google Contactos: ${raw}`);
      }
      if (!hasCachedGoogleContactsToken() && candidates.length === 0) {
        setNeedsGoogleSignIn(true);
      }
    } finally {
      setLoading(false);
    }
  };

  const filteredCandidates = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.phones.some((p) => cleanPhoneInput(p).toLowerCase().includes(q) || p.toLowerCase().includes(q))
    );
  }, [candidates, searchQuery]);

  if (mode === 'closed') return null;

  const title =
    mode === 'google'
      ? 'Buscar en Google Contactos'
      : mode === 'android-native'
        ? 'Contactos del Teléfono'
        : 'Seleccionar contacto';

  const sourceLabel =
    mode === 'google'
      ? 'Google Contactos'
      : mode === 'android-native'
        ? 'agenda nativa'
        : 'agenda';

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-slate-950/65 backdrop-blur-sm p-0 sm:p-4">
      <div className="w-full sm:max-w-lg max-h-[88dvh] flex flex-col rounded-t-3xl sm:rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
        <div className="bg-[#145f96] px-5 py-4 flex items-center justify-between text-white shrink-0">
          <div className="min-w-0">
            <h3 className="text-base font-bold truncate">{title}</h3>
            {mode === 'google' && connectedEmail && !needsGoogleSignIn && (
              <p className="text-[11px] text-[#a1d63e] font-medium truncate">{connectedEmail}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar selector de contactos"
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl hover:bg-white/15 cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {mode === 'google' && needsGoogleSignIn ? (
          <div className="p-6 space-y-5 overflow-y-auto">
            <div className="rounded-2xl bg-[#69b8e9]/10 border border-[#69b8e9]/35 p-4 space-y-2">
              <p className="text-sm font-bold text-[#145f96]">
                Vincula tus contactos una sola vez
              </p>
              <p className="text-xs text-slate-600 leading-relaxed">
                Conecta tu cuenta de Google donde guardas tus contactos. Quedarán guardados en tu
                dispositivo para que los próximos ingresos sean instantáneos sin volver a conectarte.
              </p>
            </div>

            {errorMsg && (
              <p className="text-xs font-semibold text-[#d12925] bg-[#d12925]/10 border border-[#d12925]/25 rounded-xl px-3.5 py-2.5">
                {errorMsg}
              </p>
            )}

            <button
              type="button"
              disabled={loading}
              onClick={() => handleGoogleConnectClick(true)}
              className="w-full min-h-[48px] rounded-xl bg-white border border-[#747775] hover:bg-slate-50 active:bg-slate-100 disabled:opacity-60 px-4 flex items-center justify-center gap-3 shadow-sm transition-colors cursor-pointer"
            >
              <svg
                version="1.1"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 48 48"
                className="w-5 h-5 shrink-0"
                aria-hidden="true"
              >
                <path
                  fill="#EA4335"
                  d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                />
                <path
                  fill="#4285F4"
                  d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                />
                <path
                  fill="#FBBC05"
                  d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                />
                <path
                  fill="#34A853"
                  d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                />
              </svg>
              <span className="text-sm font-semibold text-[#1f1f1f]">
                {loading ? 'Conectando con Google...' : 'Continuar con Google'}
              </span>
            </button>
          </div>
        ) : (
          <div className="flex flex-col flex-1 min-h-0">
            <div className="p-3.5 border-b border-slate-200 space-y-2.5 shrink-0 bg-slate-50">
              <div className="relative">
                <Search className="w-4 h-4 text-[#145f96] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Buscar por nombre o teléfono..."
                  className="w-full min-h-[44px] rounded-xl bg-white border border-slate-300 pl-10 pr-4 text-sm text-slate-900 focus:border-[#69b8e9] focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-between gap-2 text-xs text-slate-600">
                <span className="font-medium">
                  {loading
                    ? 'Sincronizando contactos...'
                    : `${filteredCandidates.length} contacto(s) con teléfono`}
                </span>

                {mode === 'google' && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() =>
                        hasCachedGoogleContactsToken()
                          ? loadGoogleContactsWithCachedToken()
                          : handleGoogleConnectClick(false)
                      }
                      className="px-2.5 py-1.5 rounded-lg bg-white border border-slate-300 text-[#145f96] font-semibold hover:bg-slate-100 inline-flex items-center gap-1 cursor-pointer"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                      <span>Sincronizar</span>
                    </button>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => handleGoogleConnectClick(true)}
                      className="px-2.5 py-1.5 rounded-lg bg-white border border-slate-300 text-slate-700 font-semibold hover:bg-slate-100 cursor-pointer"
                    >
                      Cuenta
                    </button>
                  </div>
                )}
              </div>

              {errorMsg && (
                <p className="text-xs font-semibold text-[#d12925] bg-[#d12925]/10 border border-[#d12925]/25 rounded-xl px-3 py-2">
                  {errorMsg}
                </p>
              )}
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-slate-200/70 akrobit-zebra-rows">
              {loading && candidates.length === 0 ? (
                <div className="py-14 text-center text-sm text-slate-500">
                  Obteniendo lista de contactos...
                </div>
              ) : filteredCandidates.length === 0 ? (
                <div className="py-12 px-5 text-center space-y-2">
                  <p className="text-sm font-semibold text-slate-700">
                    {candidates.length === 0
                      ? 'Esta cuenta no tiene contactos con número telefónico.'
                      : `No hay coincidencias para "${searchQuery}".`}
                  </p>
                  {mode === 'google' && candidates.length === 0 && (
                    <p className="text-xs text-slate-500">
                      Si tus contactos están en otro correo de tu teléfono, pulsa{' '}
                      <strong>Cuenta</strong> arriba.
                    </p>
                  )}
                </div>
              ) : (
                filteredCandidates.map((contact) => (
                  <div key={contact.id} className="px-4 py-3 space-y-2 transition-colors">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-bold text-slate-900 truncate">{contact.name}</p>
                      <span className="text-[11px] font-semibold text-slate-400 shrink-0">
                        {contact.phones.length} núm.
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {contact.phones.map((phone, idx) => {
                        const clean = cleanPhoneInput(phone);
                        const hasPrefix = clean.startsWith('+');
                        return (
                          <button
                            key={`${contact.id}_${idx}`}
                            type="button"
                            onClick={() => {
                              onClose();
                              void onSelectContact(contact.name, phone, sourceLabel);
                            }}
                            className="px-3 py-2 rounded-xl border border-[#69b8e9] bg-white hover:bg-[#a1d63e]/20 hover:border-[#a1d63e] text-left flex items-center gap-2 transition-colors cursor-pointer"
                          >
                            <UserCheck className="w-4 h-4 text-[#145f96] shrink-0" />
                            <span className="text-xs font-mono font-bold text-slate-900">
                              {clean || phone}
                            </span>
                            {!hasPrefix && (
                              <span className="text-[10px] font-bold text-[#df7729]">
                                +prefijo
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
