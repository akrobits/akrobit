import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Contact,
  Link2,
  MoreVertical,
  Pencil,
  Search,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { ORG_ID, db } from '../lib/firebase';
import {
  cleanPhoneInput,
  formatCurrency,
  generateDocId,
  round2,
  validateInternationalPhone,
} from '../lib/finance';
import { ClientDetailModal } from './ClientDetailModal';
import { ContactImportModal, type ImportModalMode } from './ContactImportModal';
import {
  hasNativeApkContactsBridge,
  readFromNativeApkContacts,
  type ContactCandidate,
} from '../lib/contactsAdapter';
import {
  attachPortalSnapshotToBatch,
  computePortalKey,
  generatePortalCode,
  getPublicPortalUrl,
  syncClientPortalFromServer,
} from '../lib/clientPortal';
import { useBackHandler } from '../lib/backNavigation';
import type { Client, Credit, CreditTransaction, InvoicePayload } from '../types';

interface CreditCashModuleProps {
  clients: Client[];
  credits: Credit[];
  transactions: CreditTransaction[];
  currentUserId: string;
  currentUserName: string;
  isAdmin: boolean;
  incomingSharedContacts?: ContactCandidate[];
  onConsumeSharedContacts?: () => void;
  onBackToDashboard: () => void;
  onTriggerInvoice: (invoice: InvoicePayload) => void;
}

type ModalMode = 'none' | 'add' | 'edit_pick' | 'edit_form' | 'delete_pick' | 'delete_confirm';

async function commitWithOfflineGrace(promise: Promise<void>): Promise<void> {
  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, 1200);
  });
  await Promise.race([promise, timeout]);
}

export const CreditCashModule: React.FC<CreditCashModuleProps> = ({
  clients,
  credits,
  transactions,
  currentUserId,
  currentUserName,
  isAdmin,
  incomingSharedContacts = [],
  onConsumeSharedContacts,
  onBackToDashboard,
  onTriggerInvoice,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  const [modalMode, setModalModeState] = useState<ModalMode>(() => {
    try {
      return sessionStorage.getItem('akrobit_cc_modal') === 'add' ? 'add' : 'none';
    } catch {
      return 'none';
    }
  });

  const setModalMode = (mode: ModalMode) => {
    try {
      if (mode === 'add') {
        sessionStorage.setItem('akrobit_cc_modal', 'add');
      } else {
        sessionStorage.removeItem('akrobit_cc_modal');
      }
    } catch {
      // Ignore storage errors
    }
    setModalModeState(mode);
  };
  const [targetClient, setTargetClient] = useState<Client | null>(null);

  const [formName, setFormName] = useState(() => {
    try {
      const raw = sessionStorage.getItem('akrobit_cc_draft');
      return raw ? (JSON.parse(raw) as { name?: string }).name || '' : '';
    } catch {
      return '';
    }
  });
  const [formPhone, setFormPhone] = useState(() => {
    try {
      const raw = sessionStorage.getItem('akrobit_cc_draft');
      return raw ? (JSON.parse(raw) as { phone?: string }).phone || '' : '';
    } catch {
      return '';
    }
  });
  const [formNotes, setFormNotes] = useState(() => {
    try {
      const raw = sessionStorage.getItem('akrobit_cc_draft');
      return raw ? (JSON.parse(raw) as { notes?: string }).notes || '' : '';
    } catch {
      return '';
    }
  });
  const [contactHint, setContactHint] = useState('');
  const [contactToast, setContactToast] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [importModalMode, setImportModalMode] = useState<ImportModalMode>('closed');
  const [importCandidates, setImportCandidates] = useState<ContactCandidate[]>([]);

  const phoneInputRef = useRef<HTMLInputElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    try {
      if (modalMode === 'add') {
        sessionStorage.setItem(
          'akrobit_cc_draft',
          JSON.stringify({ name: formName, phone: formPhone, notes: formNotes })
        );
      } else {
        sessionStorage.removeItem('akrobit_cc_draft');
      }
    } catch {
      // Ignore storage errors
    }
  }, [modalMode, formName, formPhone, formNotes]);

  const saveNewClientRecord = async (
    rawName: string,
    rawPhone: string,
    rawNotes: string
  ): Promise<boolean> => {
    setFormError('');
    if (!currentUserId) {
      setFormError('Sesión no lista. Recarga la página e intenta de nuevo.');
      return false;
    }

    const cleanName = rawName.replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim();
    if (cleanName.length < 1) {
      setFormError('Ingresa el nombre del cliente.');
      return false;
    }

    const phoneCheck = validateInternationalPhone(rawPhone);
    if (!phoneCheck.valid) {
      setFormError(phoneCheck.error || 'Número de teléfono inválido.');
      return false;
    }

    setSaving(true);
    const id = generateDocId('cli');
    try {
      const normalizedPhone = phoneCheck.normalized.slice(0, 32);
      const safeName = cleanName.slice(0, 120);
      const portalCode = generatePortalCode();
      const portalKey = await computePortalKey(normalizedPhone, portalCode);

      const batch = writeBatch(db);
      batch.set(doc(db, 'clients', id), {
        id,
        name: safeName,
        phone: normalizedPhone,
        notes: rawNotes.trim().slice(0, 300),
        portalCode,
        portalKey,
        orgId: ORG_ID,
        createdBy: currentUserId,
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      attachPortalSnapshotToBatch(batch, portalKey, id, safeName, [], []);

      await commitWithOfflineGrace(batch.commit());
      try {
        sessionStorage.removeItem('akrobit_cc_draft');
      } catch {
        // Ignore storage errors
      }
      setFormName('');
      setFormPhone('');
      setFormNotes('');
      setModalMode('none');
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Error guardando cliente:', msg);
      setFormError(`No se pudo guardar el cliente: ${msg}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const activeClients = useMemo(
    () =>
      clients
        .filter((c) => c.active !== false)
        .sort((a, b) => a.name.localeCompare(b.name, 'es')),
    [clients]
  );

  const filteredClients = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return activeClients;
    return activeClients.filter(
      (c) => c.name.toLowerCase().includes(q) || c.phone.toLowerCase().includes(q)
    );
  }, [activeClients, searchQuery]);

  const selectedClient = useMemo(
    () => activeClients.find((c) => c.id === selectedClientId) || null,
    [activeClients, selectedClientId]
  );

  const syncedLegacyIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const c of activeClients) {
      if (c.portalCode && c.portalKey) continue;
      if (syncedLegacyIdsRef.current.has(c.id)) continue;
      syncedLegacyIdsRef.current.add(c.id);
      void syncClientPortalFromServer(c.id).catch((err) => {
        console.warn('No se pudo inicializar portal del cliente:', c.id, err);
        syncedLegacyIdsRef.current.delete(c.id);
      });
    }
  }, [activeClients]);

  useBackHandler(Boolean(selectedClient), () => setSelectedClientId(null));
  useBackHandler(menuOpen, () => setMenuOpen(false));
  useBackHandler(modalMode !== 'none', () => setModalMode('none'));
  useBackHandler(modalMode === 'edit_form', () => {
    setFormError('');
    setModalMode('edit_pick');
  });
  useBackHandler(modalMode === 'delete_confirm', () => {
    setFormError('');
    setModalMode('delete_pick');
  });

  const clientBalances = useMemo(() => {
    const map = new Map<string, { nio: number; usd: number }>();
    for (const cr of credits) {
      if (cr.status !== 'active' || cr.currentBalance <= 0) continue;
      const cur = map.get(cr.clientId) || { nio: 0, usd: 0 };
      if (cr.currency === 'NIO') cur.nio = round2(cur.nio + cr.currentBalance);
      else cur.usd = round2(cur.usd + cr.currentBalance);
      map.set(cr.clientId, cur);
    }
    return map;
  }, [credits]);

  const processPickedContact = async (rawName: string, rawTel: string, sourceLabel: string) => {
    const cleanName = rawName.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
    const cleanedTel = cleanPhoneInput(rawTel);

    if (cleanName) setFormName(cleanName);
    if (cleanedTel) setFormPhone(cleanedTel);

    if (!cleanName && !cleanedTel) {
      setFormError(
        'El contacto seleccionado llegó sin nombre ni teléfono. Verifica en tu agenda que tenga número y vuelva a intentar.'
      );
      return;
    }

    if (!cleanedTel) {
      setFormError(
        'El contacto llegó sin número de teléfono (asegúrate de marcar el número en la agenda antes de tocar Listo).'
      );
      setTimeout(() => phoneInputRef.current?.focus(), 50);
      return;
    }

    const phoneCheck = validateInternationalPhone(cleanedTel);
    if (!cleanName) {
      setFormError('El contacto llegó sin nombre. Escribe el nombre completo y pulsa Agregar.');
      setTimeout(() => nameInputRef.current?.focus(), 50);
      return;
    }

    if (!phoneCheck.valid) {
      setContactHint(
        `Contacto "${cleanName}" cargado con el número ${cleanedTel}. Agrega su código de país (ej. +505 o +1) antes de pulsar Agregar.`
      );
      setFormError(phoneCheck.error || 'Falta el código de país (+).');
      setTimeout(() => phoneInputRef.current?.focus(), 50);
      return;
    }

    const savedOk = await saveNewClientRecord(cleanName, phoneCheck.normalized, '');
    if (savedOk) {
      setContactToast(`Cliente guardado (${sourceLabel}): ${cleanName} · ${phoneCheck.normalized}`);
      setTimeout(() => setContactToast(''), 4500);
    }
  };

  useEffect(() => {
    if (!incomingSharedContacts || incomingSharedContacts.length === 0) return;
    const sharedList = [...incomingSharedContacts];
    onConsumeSharedContacts?.();
    setFormError('');
    setContactHint('');
    setModalMode('add');

    if (sharedList.length === 1 && sharedList[0].phones.length <= 1) {
      void processPickedContact(
        sharedList[0].name,
        sharedList[0].phones[0] || '',
        'Compartir con Akrobit'
      );
    } else {
      setImportCandidates(sharedList);
      setImportModalMode('vcf');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingSharedContacts]);

  const handleOpenContactsImporter = async () => {
    setFormError('');
    setContactHint('');

    if (hasNativeApkContactsBridge()) {
      try {
        const nativeList = await readFromNativeApkContacts();
        if (nativeList.length === 1 && nativeList[0].phones.length <= 1) {
          await processPickedContact(
            nativeList[0].name,
            nativeList[0].phones[0] || '',
            'agenda Android'
          );
          return;
        }
        if (nativeList.length > 0) {
          setImportCandidates(nativeList);
          setImportModalMode('android-native');
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setFormError(`No se pudo leer la agenda nativa Android: ${msg}`);
        return;
      }
    }

    setImportCandidates([]);
    setImportModalMode('google');
  };

  const openAddClient = () => {
    setMenuOpen(false);
    setFormName('');
    setFormPhone('');
    setFormNotes('');
    setContactHint('');
    setFormError('');
    setModalMode('add');
  };

  const handleSaveNewClient = async (e: React.FormEvent) => {
    e.preventDefault();
    await saveNewClientRecord(formName, formPhone, formNotes);
  };

  const handleSaveEditedClient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetClient) return;
    setFormError('');
    const cleanName = formName.replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim();
    if (cleanName.length < 1) {
      setFormError('Ingresa el nombre del cliente.');
      return;
    }
    const phoneCheck = validateInternationalPhone(formPhone);
    if (!phoneCheck.valid) {
      setFormError(phoneCheck.error || 'Número de teléfono inválido.');
      return;
    }

    setSaving(true);
    try {
      const safeName = cleanName.slice(0, 120);
      const safePhone = phoneCheck.normalized.slice(0, 32);
      const portalCode = targetClient.portalCode || generatePortalCode();
      const newPortalKey = await computePortalKey(safePhone, portalCode);
      const clientCredits = credits.filter((c) => c.clientId === targetClient.id);
      const clientTxs = transactions.filter((t) => t.clientId === targetClient.id);

      const batch = writeBatch(db);
      if (targetClient.portalKey && targetClient.portalKey !== newPortalKey) {
        batch.delete(doc(db, 'clientPortals', targetClient.portalKey));
      }
      batch.update(doc(db, 'clients', targetClient.id), {
        name: safeName,
        phone: safePhone,
        notes: formNotes.trim().slice(0, 300),
        portalCode,
        portalKey: newPortalKey,
        updatedAt: serverTimestamp(),
      });
      attachPortalSnapshotToBatch(
        batch,
        newPortalKey,
        targetClient.id,
        safeName,
        clientCredits,
        clientTxs
      );

      await commitWithOfflineGrace(batch.commit());
      setModalMode('none');
      setTargetClient(null);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setFormError(`No se pudo actualizar: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteClient = async () => {
    if (!targetClient) return;
    setFormError('');
    setSaving(true);
    try {
      const batch = writeBatch(db);
      if (isAdmin) {
        batch.delete(doc(db, 'clients', targetClient.id));
      } else {
        batch.update(doc(db, 'clients', targetClient.id), {
          active: false,
          updatedAt: serverTimestamp(),
        });
      }
      if (targetClient.portalKey) {
        batch.delete(doc(db, 'clientPortals', targetClient.portalKey));
      }

      await commitWithOfflineGrace(batch.commit());
      if (selectedClientId === targetClient.id) setSelectedClientId(null);
      setModalMode('none');
      setTargetClient(null);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setFormError(`No se pudo eliminar: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  if (selectedClient) {
    const clientCredits = credits.filter((c) => c.clientId === selectedClient.id);
    const clientTxs = transactions.filter((t) => t.clientId === selectedClient.id);

    return (
      <div className="mx-auto max-w-4xl px-3 sm:px-6 py-4">
        <ClientDetailModal
          client={selectedClient}
          credits={clientCredits}
          transactions={clientTxs}
          currentUserId={currentUserId}
          currentUserName={currentUserName}
          isAdmin={isAdmin}
          onBack={() => setSelectedClientId(null)}
          onTriggerInvoice={onTriggerInvoice}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-3 sm:px-6 py-4 space-y-4">
      {/* Top Internal Bar: Back + Search Input + 3-dot Menu (Agregar / Editar / Eliminar Clientes) */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBackToDashboard}
          aria-label="Volver al panel principal"
          className="min-h-[46px] min-w-[46px] flex items-center justify-center rounded-xl bg-white border border-slate-200 text-[#145f96] hover:bg-slate-50 shadow-sm cursor-pointer shrink-0"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        <div className="relative flex-1">
          <Search className="w-4 h-4 text-[#145f96] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar cliente en Credit Cash..."
            className="w-full min-h-[46px] rounded-xl bg-white border-2 border-[#145f96]/20 pl-10 pr-4 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#69b8e9] focus:outline-none shadow-sm"
          />
        </div>

        {/* Top-Right 3-dot menu ONLY containing Agregar Clientes, Editar Clientes, Eliminar Clientes */}
        <div className="relative shrink-0">
          <button
            type="button"
            aria-label="Configuración de clientes"
            onClick={() => setMenuOpen((prev) => !prev)}
            className="min-h-[46px] min-w-[46px] flex items-center justify-center rounded-xl bg-[#145f96] text-white hover:bg-[#0e4670] shadow-sm cursor-pointer"
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
                <button
                  type="button"
                  onClick={openAddClient}
                  className="w-full px-4 py-3 text-left text-sm font-semibold text-slate-800 hover:bg-[#a1d63e]/15 flex items-center gap-2.5 cursor-pointer"
                >
                  <UserPlus className="w-4 h-4 text-[#4d7c0f]" />
                  <span>Agregar Clientes</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setModalMode('edit_pick');
                  }}
                  className="w-full px-4 py-3 text-left text-sm font-semibold text-slate-800 hover:bg-[#69b8e9]/15 flex items-center gap-2.5 cursor-pointer"
                >
                  <Pencil className="w-4 h-4 text-[#145f96]" />
                  <span>Editar Clientes</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setModalMode('delete_pick');
                  }}
                  className="w-full px-4 py-3 text-left text-sm font-semibold text-[#d12925] hover:bg-[#d12925]/10 flex items-center gap-2.5 cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>Eliminar Clientes</span>
                </button>
                <div className="my-1 border-t border-slate-100" />
                <button
                  type="button"
                  onClick={async () => {
                    setMenuOpen(false);
                    const portalUrl = getPublicPortalUrl();
                    try {
                      await navigator.clipboard.writeText(portalUrl);
                      setContactToast(`Enlace del Portal de Clientes copiado: ${portalUrl}`);
                    } catch {
                      setContactToast(`Enlace del Portal: ${portalUrl}`);
                    }
                    setTimeout(() => setContactToast(''), 5000);
                  }}
                  className="w-full px-4 py-3 text-left text-xs font-bold text-[#145f96] hover:bg-[#145f96]/10 flex items-center gap-2.5 cursor-pointer"
                >
                  <Link2 className="w-4 h-4 shrink-0" />
                  <span>Copiar Enlace Portal Clientes</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {contactToast && (
        <div className="rounded-xl bg-[#a1d63e]/20 border border-[#a1d63e]/60 px-4 py-2.5 text-xs font-bold text-slate-900">
          {contactToast}
        </div>
      )}

      {/* Clean internal view: NO extra boxes or salmon strip when empty */}
      {activeClients.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-xs text-slate-400">
            Sin clientes registrados. Usa el menú (⋮) para agregar.
          </p>
        </div>
      ) : filteredClients.length === 0 ? (
        <div className="py-8 text-center text-sm text-slate-500">
          No se encontraron clientes que coincidan con "{searchQuery}".
        </div>
      ) : (
        <div className="rounded-2xl bg-white border border-slate-200 divide-y divide-slate-200/70 shadow-sm overflow-hidden akrobit-zebra-rows">
          {filteredClients.map((client) => {
            const bal = clientBalances.get(client.id) || { nio: 0, usd: 0 };
            return (
              <button
                key={client.id}
                type="button"
                onClick={() => setSelectedClientId(client.id)}
                className="w-full min-h-[64px] px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-[#69b8e9]/20 active:bg-[#69b8e9]/25 transition-colors cursor-pointer"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-slate-900 truncate">{client.name}</p>
                  <p className="text-xs text-slate-500 font-mono">{client.phone}</p>
                </div>

                <div className="text-right shrink-0 font-mono text-xs tabular-nums">
                  {bal.nio > 0 && (
                    <p className="font-bold text-[#145f96]">{formatCurrency(bal.nio, 'NIO')}</p>
                  )}
                  {bal.usd > 0 && (
                    <p className="font-bold text-[#df7729]">{formatCurrency(bal.usd, 'USD')}</p>
                  )}
                  {bal.nio === 0 && bal.usd === 0 && (
                    <p className="text-slate-400 font-sans">Sin saldo</p>
                  )}
                </div>

                <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
              </button>
            );
          })}
        </div>
      )}

      {/* MODAL: AGREGAR CLIENTES */}
      {modalMode === 'add' && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/60 backdrop-blur-sm p-0 sm:p-4">
          <div className="w-full sm:max-w-md max-h-[92dvh] flex flex-col rounded-t-3xl sm:rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="bg-[#145f96] px-5 py-4 flex items-center justify-between text-white shrink-0">
              <h3 className="text-base font-bold">Agregar Cliente</h3>
              <button
                type="button"
                onClick={() => setModalMode('none')}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl hover:bg-white/15 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-3.5 overflow-y-auto">
              <button
                type="button"
                onClick={handleOpenContactsImporter}
                className="w-full min-h-[48px] rounded-xl bg-[#145f96] hover:bg-[#0e4670] text-white font-bold text-sm flex items-center justify-center gap-2 shadow-sm cursor-pointer"
              >
                <Contact className="w-5 h-5 shrink-0 text-[#a1d63e]" />
                <span>
                  {hasNativeApkContactsBridge()
                    ? 'Seleccionar de Contactos del Teléfono'
                    : 'Buscar en Google Contactos'}
                </span>
              </button>

              <form onSubmit={handleSaveNewClient} className="space-y-3.5">

              {contactHint && (
                <div className="text-xs text-[#145f96] bg-[#145f96]/5 border border-[#145f96]/15 rounded-xl px-3 py-2.5">
                  <p>{contactHint}</p>
                </div>
              )}

              {formError && (
                <p className="text-xs font-semibold text-[#d12925] bg-[#d12925]/10 border border-[#d12925]/25 rounded-xl px-3 py-2">
                  {formError}
                </p>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Nombre completo
                </label>
                <input
                  ref={nameInputRef}
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Ej. María Fernanda López"
                  className="w-full min-h-[46px] rounded-xl border border-slate-300 px-3.5 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Teléfono WhatsApp (código de país obligatorio)
                </label>
                <input
                  ref={phoneInputRef}
                  type="tel"
                  inputMode="tel"
                  value={formPhone}
                  onChange={(e) => setFormPhone(e.target.value)}
                  placeholder="Ej. +50576881122 o +13055551234"
                  className="w-full min-h-[46px] rounded-xl border border-slate-300 px-3.5 text-sm font-mono"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  Incluye el código de país con <strong>+</strong> (ej. +505, +1, +506).
                </p>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Nota breve (opcional)
                </label>
                <input
                  type="text"
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  placeholder="Referencia o dirección"
                  className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3.5 text-sm"
                />
              </div>

              <button
                type="submit"
                disabled={saving}
                className="w-full min-h-[48px] rounded-xl bg-[#a1d63e] hover:bg-[#8ec22f] disabled:opacity-60 text-slate-950 font-bold text-sm cursor-pointer"
              >
                {saving ? 'Guardando...' : 'Agregar'}
              </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: PICK CLIENT TO EDIT OR DELETE */}
      {(modalMode === 'edit_pick' || modalMode === 'delete_pick') && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/60 backdrop-blur-sm p-0 sm:p-4">
          <div className="w-full sm:max-w-md max-h-[82dvh] flex flex-col rounded-t-3xl sm:rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="bg-[#145f96] px-5 py-4 flex items-center justify-between text-white shrink-0">
              <h3 className="text-base font-bold">
                {modalMode === 'edit_pick' ? 'Editar Clientes' : 'Eliminar Clientes'}
              </h3>
              <button
                type="button"
                onClick={() => setModalMode('none')}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl hover:bg-white/15 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto divide-y divide-slate-200/70 akrobit-zebra-rows">
              {activeClients.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-8">
                  No hay clientes registrados aún.
                </p>
              ) : (
                activeClients.map((client) => (
                  <button
                    key={client.id}
                    type="button"
                    onClick={() => {
                      setTargetClient(client);
                      setFormError('');
                      if (modalMode === 'edit_pick') {
                        setFormName(client.name);
                        setFormPhone(client.phone);
                        setFormNotes(client.notes || '');
                        setModalMode('edit_form');
                      } else {
                        setModalMode('delete_confirm');
                      }
                    }}
                    className="w-full py-3.5 px-4 flex items-center justify-between text-left hover:bg-[#69b8e9]/20 transition-colors cursor-pointer"
                  >
                    <div>
                      <p className="text-sm font-bold text-slate-900">{client.name}</p>
                      <p className="text-xs text-slate-500 font-mono">{client.phone}</p>
                    </div>
                    {modalMode === 'edit_pick' ? (
                      <Pencil className="w-4 h-4 text-[#145f96]" />
                    ) : (
                      <Trash2 className="w-4 h-4 text-[#d12925]" />
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODAL: EDIT FORM */}
      {modalMode === 'edit_form' && targetClient && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/60 backdrop-blur-sm p-0 sm:p-4">
          <div className="w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="bg-[#145f96] px-5 py-4 flex items-center justify-between text-white">
              <h3 className="text-base font-bold">Editar Cliente</h3>
              <button
                type="button"
                onClick={() => setModalMode('none')}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl hover:bg-white/15 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveEditedClient} className="p-5 space-y-4">
              {formError && (
                <p className="text-xs font-semibold text-[#d12925] bg-[#d12925]/10 rounded-xl px-3 py-2">
                  {formError}
                </p>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Nombre</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="w-full min-h-[46px] rounded-xl border border-slate-300 px-3.5 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Teléfono WhatsApp (código de país obligatorio)
                </label>
                <input
                  type="tel"
                  inputMode="tel"
                  value={formPhone}
                  onChange={(e) => setFormPhone(e.target.value)}
                  placeholder="Ej. +50576881122"
                  className="w-full min-h-[46px] rounded-xl border border-slate-300 px-3.5 text-sm font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Nota</label>
                <input
                  type="text"
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3.5 text-sm"
                />
              </div>

              <button
                type="submit"
                disabled={saving}
                className="w-full min-h-[48px] rounded-xl bg-[#145f96] text-white font-bold text-sm cursor-pointer"
              >
                {saving ? 'Guardando...' : 'Guardar Cambios'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: DELETE CONFIRM */}
      {modalMode === 'delete_confirm' && targetClient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl border border-slate-200 p-5 space-y-4">
            <h3 className="text-base font-bold text-[#d12925]">¿Eliminar cliente?</h3>
            <p className="text-sm text-slate-600">
              Se quitará a <strong>{targetClient.name}</strong> de la lista activa de Credit Cash.
            </p>
            {formError && (
              <p className="text-xs font-semibold text-[#d12925] bg-[#d12925]/10 rounded-xl px-3 py-2">
                {formError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setModalMode('none')}
                className="flex-1 min-h-[44px] rounded-xl bg-slate-100 text-slate-800 text-sm font-semibold cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleDeleteClient}
                className="flex-1 min-h-[44px] rounded-xl bg-[#d12925] text-white text-sm font-bold cursor-pointer"
              >
                {saving ? 'Eliminando...' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
      <ContactImportModal
        mode={importModalMode}
        currentUserId={currentUserId}
        initialCandidates={importCandidates}
        onClose={() => setImportModalMode('closed')}
        onSelectContact={processPickedContact}
      />
    </div>
  );
};
