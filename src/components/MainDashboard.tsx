import React, { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Bell,
  ChevronRight,
  CreditCard,
  GraduationCap,
  Layers,
  LogOut,
  Package,
} from 'lucide-react';
import {
  collection,
  doc,
  getDocFromServer,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { ORG_ID, db } from '../lib/firebase';
import {
  buildOverdueClientAlerts,
  calculateLiveCreditStatus,
  formatActorName,
  formatCurrency,
  round2,
} from '../lib/finance';
import { AdminNotificationsModal } from './AdminNotificationsModal';
import { ClosedCreditModule } from './ClosedCreditModule';
import { CreditCashModule } from './CreditCashModule';
import { InventoryModule } from './InventoryModule';
import { OfflineIndicator, PWAInstallButton } from './PWAControls';
import { WhatsAppInvoiceModal } from './WhatsAppInvoiceModal';
import { type ContactCandidate } from '../lib/contactsAdapter';
import { consumePendingSharedContacts } from '../lib/sharedContactInbox';
import { useBackHandler } from '../lib/backNavigation';
import type {
  Client,
  Credit,
  CreditTransaction,
  InvoicePayload,
  ModificationRequest,
  Product,
  UserProfile,
} from '../types';

type ActiveSection = 'home' | 'credit_cash' | 'maestros' | 'inventario' | 'cartera_castigada';

const UPCOMING_MODULES = [
  { id: 'mod_3', label: 'Módulo 4' },
  { id: 'mod_4', label: 'Módulo 5' },
] as const;

function getTimestampMillis(ts: unknown): number {
  if (ts && typeof ts === 'object' && 'toMillis' in ts) {
    return (ts as { toMillis: () => number }).toMillis();
  }
  return Date.now();
}

export const MainDashboard: React.FC = () => {
  const { user, profile, isAdmin, logout } = useAuth();

  const [section, setSectionState] = useState<ActiveSection>(() => {
    try {
      const saved = sessionStorage.getItem('akrobit_section');
      if (
        saved === 'credit_cash' ||
        saved === 'maestros' ||
        saved === 'inventario' ||
        saved === 'cartera_castigada'
      ) {
        return saved;
      }
      return 'home';
    } catch {
      return 'home';
    }
  });

  const setSection = (next: ActiveSection) => {
    try {
      sessionStorage.setItem('akrobit_section', next);
    } catch {
      // Ignore storage errors
    }
    setSectionState(next);
  };

  const handleLogout = async () => {
    try {
      sessionStorage.removeItem('akrobit_section');
      sessionStorage.removeItem('akrobit_entered_splash');
      sessionStorage.removeItem('akrobit_cc_modal');
    } catch {
      // Ignore storage errors
    }
    await logout();
  };

  const [clients, setClients] = useState<Client[]>([]);
  const [credits, setCredits] = useState<Credit[]>([]);
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [modRequests, setModRequests] = useState<ModificationRequest[]>([]);
  const [teamUsers, setTeamUsers] = useState<UserProfile[]>([]);
  const [clientsServerSynced, setClientsServerSynced] = useState(false);
  const [pendingWritesCount, setPendingWritesCount] = useState(0);
  const [syncError, setSyncError] = useState('');

  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [activeInvoice, setActiveInvoice] = useState<InvoicePayload | null>(null);
  const [incomingSharedContacts, setIncomingSharedContacts] = useState<ContactCandidate[]>([]);

  useBackHandler(section !== 'home', () => setSection('home'));
  useBackHandler(notificationsOpen, () => setNotificationsOpen(false));

  useEffect(() => {
    let active = true;
    void consumePendingSharedContacts().then((shared) => {
      if (!active || shared.length === 0) return;
      setIncomingSharedContacts(shared);
      setSection('credit_cash');
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!user || !user.emailVerified || (!isAdmin && profile?.active !== true)) return;

    const userDocRef = doc(db, 'users', user.uid);
    const sendHeartbeat = () => {
      void updateDoc(userDocRef, {
        isOnline: true,
        lastSeenAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }).catch(() => {
        // Ignore transient offline heartbeat errors
      });
    };

    sendHeartbeat();
    const interval = window.setInterval(sendHeartbeat, 60_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        sendHeartbeat();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [user, isAdmin, profile?.active]);

  useEffect(() => {
    if (!user || !user.emailVerified || (!isAdmin && profile?.active !== true)) return;
    setSyncError('');

    const clientsQ = query(collection(db, 'clients'), where('orgId', '==', ORG_ID));
    const creditsQ = query(collection(db, 'credits'), where('orgId', '==', ORG_ID));
    const txQ = query(collection(db, 'transactions'), where('orgId', '==', ORG_ID));
    const productsQ = query(collection(db, 'products'), where('orgId', '==', ORG_ID));

    const modQ = isAdmin
      ? query(collection(db, 'modificationRequests'), where('orgId', '==', ORG_ID))
      : query(collection(db, 'modificationRequests'), where('requestedBy', '==', user.uid));

    const unsubClients = onSnapshot(
      clientsQ,
      { includeMetadataChanges: true },
      (snap) => {
        setClients(snap.docs.map((d) => d.data() as Client));
        if (!snap.metadata.fromCache) {
          setClientsServerSynced(true);
        }
      },
      (error) => {
        console.error('Clients snapshot error:', error);
        setSyncError('No se pudieron sincronizar los clientes. Verifica tus permisos.');
      }
    );

    const unsubCredits = onSnapshot(
      creditsQ,
      { includeMetadataChanges: true },
      (snap) => {
        const list = snap.docs
          .map((d) => ({
            ...(d.data() as Credit),
            hasPendingWrites: d.metadata.hasPendingWrites,
          }))
          .sort((a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt));
        setCredits(list);
        setPendingWritesCount(list.filter((item) => item.hasPendingWrites).length);
      },
      (error) => {
        console.error('Credits snapshot error:', error);
      }
    );

    const unsubTx = onSnapshot(
      txQ,
      { includeMetadataChanges: true },
      (snap) => {
        const list = snap.docs
          .map((d) => ({
            ...(d.data() as CreditTransaction),
            hasPendingWrites: d.metadata.hasPendingWrites,
          }))
          .sort((a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt));
        setTransactions(list);
      },
      (error) => {
        console.error('Transactions snapshot error:', error);
      }
    );

    const unsubProducts = onSnapshot(
      productsQ,
      (snap) => {
        setProducts(snap.docs.map((d) => d.data() as Product));
      },
      (error) => {
        console.error('Products snapshot error:', error);
      }
    );

    const unsubMods = onSnapshot(
      modQ,
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as ModificationRequest)
          .sort((a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt));
        setModRequests(list);
      },
      (error) => {
        console.error('ModificationRequests snapshot error:', error);
      }
    );

    const unsubUsers = isAdmin
      ? onSnapshot(
          collection(db, 'users'),
          (snap) => {
            const list = snap.docs
              .map((d) => d.data() as UserProfile)
              .sort((a, b) => Number(a.active) - Number(b.active));
            setTeamUsers(list);
          },
          (error) => {
            console.error('Users snapshot error:', error);
          }
        )
      : () => {};

    return () => {
      unsubClients();
      unsubCredits();
      unsubTx();
      unsubProducts();
      unsubMods();
      unsubUsers();
    };
  }, [user, isAdmin, profile?.active]);

  // Safely purge orphan credits/transactions/requests left behind by already-deleted clients
  useEffect(() => {
    if (!isAdmin || !clientsServerSynced) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    const existingClientIds = new Set(clients.map((c) => c.id));
    const orphanClientIds = new Set<string>();

    for (const cr of credits) {
      if (cr.clientId && !existingClientIds.has(cr.clientId)) {
        orphanClientIds.add(cr.clientId);
      }
    }
    for (const tx of transactions) {
      if (tx.clientId && !existingClientIds.has(tx.clientId)) {
        orphanClientIds.add(tx.clientId);
      }
    }
    for (const req of modRequests) {
      if (req.clientId && !existingClientIds.has(req.clientId)) {
        orphanClientIds.add(req.clientId);
      }
    }

    if (orphanClientIds.size === 0) return;

    let cancelled = false;
    void (async () => {
      for (const orphanClientId of orphanClientIds) {
        if (cancelled) return;
        try {
          const serverSnap = await getDocFromServer(doc(db, 'clients', orphanClientId));
          if (serverSnap.exists()) continue;

          const refs = [
            ...credits
              .filter((cr) => cr.clientId === orphanClientId)
              .map((cr) => doc(db, 'credits', cr.id)),
            ...transactions
              .filter((tx) => tx.clientId === orphanClientId)
              .map((tx) => doc(db, 'transactions', tx.id)),
            ...modRequests
              .filter((req) => req.clientId === orphanClientId)
              .map((req) => doc(db, 'modificationRequests', req.id)),
          ];

          for (let i = 0; i < refs.length; i += 400) {
            if (cancelled) return;
            const batch = writeBatch(db);
            for (const ref of refs.slice(i, i + 400)) {
              batch.delete(ref);
            }
            await batch.commit();
          }
        } catch {
          // Ignore transient offline/network errors during background orphan cleanup
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAdmin, clientsServerSynced, clients, credits, transactions, modRequests]);

  const pendingRequests = useMemo(
    () => modRequests.filter((r) => r.status === 'pending'),
    [modRequests]
  );

  // Bell alerts combine 30+ day overdue clients from Credit Cash and Maestros (excluding Cartera Castigada)
  const overdueAlerts = useMemo(() => {
    const ccAlerts = buildOverdueClientAlerts({
      moduleId: 'credit_cash',
      moduleLabel: 'Credit Cash',
      clients,
      credits,
      transactions,
    });
    const maestrosAlerts = buildOverdueClientAlerts({
      moduleId: 'maestros',
      moduleLabel: 'Maestros',
      clients,
      credits,
      transactions,
    });
    return [...ccAlerts, ...maestrosAlerts].sort(
      (a, b) => b.maxDaysWithoutPayment - a.maxDaysWithoutPayment
    );
  }, [clients, credits, transactions]);

  const pendingTeamCount = useMemo(
    () => (isAdmin ? teamUsers.filter((member) => !member.active).length : 0),
    [isAdmin, teamUsers]
  );

  const totalPendingAlerts =
    pendingRequests.length + overdueAlerts.length + pendingTeamCount;

  const summary = useMemo(() => {
    const ccClients = clients.filter(
      (c) =>
        (c.moduleId || 'credit_cash') === 'credit_cash' &&
        c.active !== false &&
        c.portfolioStatus !== 'castigada'
    );
    const maestrosClients = clients.filter(
      (c) =>
        c.moduleId === 'maestros' &&
        c.active !== false &&
        c.portfolioStatus !== 'castigada'
    );
    const castigadaClients = clients.filter(
      (c) => c.active !== false && c.portfolioStatus === 'castigada'
    );

    const ccIds = new Set(ccClients.map((c) => c.id));
    const maestrosIds = new Set(maestrosClients.map((c) => c.id));
    const castigadaIds = new Set(castigadaClients.map((c) => c.id));

    const txsByClient = new Map<string, CreditTransaction[]>();
    for (const tx of transactions) {
      if (!ccIds.has(tx.clientId) && !maestrosIds.has(tx.clientId) && !castigadaIds.has(tx.clientId)) {
        continue;
      }
      const list = txsByClient.get(tx.clientId) || [];
      list.push(tx);
      txsByClient.set(tx.clientId, list);
    }

    let ccNio = 0;
    let ccUsd = 0;
    let maestrosNio = 0;
    let maestrosUsd = 0;
    let castigadaNio = 0;
    let castigadaUsd = 0;

    for (const c of credits) {
      if (c.status !== 'active' || c.currentBalance <= 0) continue;
      if (ccIds.has(c.clientId)) {
        const live = calculateLiveCreditStatus(c, txsByClient.get(c.clientId) || []);
        if (c.currency === 'NIO') ccNio = round2(ccNio + live.totalDueToday);
        else ccUsd = round2(ccUsd + live.totalDueToday);
      } else if (maestrosIds.has(c.clientId)) {
        const live = calculateLiveCreditStatus(c, txsByClient.get(c.clientId) || []);
        if (c.currency === 'NIO') maestrosNio = round2(maestrosNio + live.totalDueToday);
        else maestrosUsd = round2(maestrosUsd + live.totalDueToday);
      } else if (castigadaIds.has(c.clientId)) {
        const live = calculateLiveCreditStatus(c, txsByClient.get(c.clientId) || []);
        if (c.currency === 'NIO') castigadaNio = round2(castigadaNio + live.totalDueToday);
        else castigadaUsd = round2(castigadaUsd + live.totalDueToday);
      }
    }

    const activeProductsCount = products.filter((p) => p.active !== false).length;

    return {
      ccClientCount: ccClients.length,
      ccNio,
      ccUsd,
      maestrosClientCount: maestrosClients.length,
      maestrosNio,
      maestrosUsd,
      activeProductsCount,
      castigadaClientCount: castigadaClients.length,
      castigadaNio,
      castigadaUsd,
    };
  }, [clients, credits, transactions, products]);

  useEffect(() => {
    if (!isAdmin || transactions.length === 0) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    const toFix = transactions.filter(
      (tx) => tx.createdByName && tx.createdByName.trim().toLowerCase() === 'akrobits'
    );
    if (toFix.length === 0) return;

    const batch = writeBatch(db);
    for (const tx of toFix.slice(0, 400)) {
      batch.update(doc(db, 'transactions', tx.id), {
        createdByName: 'Akrobit',
      });
    }
    void batch.commit().catch(() => {
      // Ignore transient errors while normalizing historical transaction labels
    });
  }, [isAdmin, transactions]);

  const displayName = formatActorName(
    profile?.displayName || user?.displayName || user?.email?.split('@')[0] || 'Akrobit'
  );

  return (
    <div className="min-h-[100dvh] bg-slate-50 flex flex-col">
      {/* Compact Top Header with Official Akrobit Logo */}
      <header className="sticky top-0 z-30 bg-[#145f96] text-white shadow-sm">
        <div className="mx-auto max-w-6xl px-3 sm:px-6 h-14 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setSection('home')}
            className="flex items-center cursor-pointer shrink-0 py-1"
            aria-label="Inicio Akrobit"
          >
            <img
              src="/akrobit-logo-tight.png"
              alt="Akrobit"
              className="h-7 sm:h-8 w-auto object-contain"
            />
          </button>

          <div className="flex items-center gap-2 min-w-0">
            <div className="hidden sm:block text-right mr-1 truncate max-w-[200px]">
              <p className="text-xs font-bold leading-tight truncate">{displayName}</p>
              <p className="text-[11px] text-[#a1d63e] font-medium">
                {isAdmin ? 'Administrador' : 'Empleado'}
              </p>
            </div>

            <PWAInstallButton variant="dark" />

            {isAdmin && (
              <button
                type="button"
                onClick={() => setNotificationsOpen(true)}
                aria-label="Centro de alertas y aprobaciones"
                className="relative min-h-[42px] min-w-[42px] flex items-center justify-center rounded-xl bg-white/10 hover:bg-white/20 transition-colors cursor-pointer"
              >
                <Bell className="w-5 h-5" />
                {totalPendingAlerts > 0 && (
                  <span
                    className={`absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full text-white text-[11px] font-bold flex items-center justify-center shadow ${
                      overdueAlerts.length > 0 ? 'bg-[#d12925]' : 'bg-[#df7729]'
                    }`}
                  >
                    {totalPendingAlerts}
                  </span>
                )}
              </button>
            )}

            <button
              type="button"
              onClick={handleLogout}
              aria-label="Cerrar sesión"
              className="min-h-[42px] min-w-[42px] flex items-center justify-center rounded-xl bg-white/10 hover:bg-[#d12925] transition-colors cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 pb-10">
        {syncError && (
          <div className="mx-auto max-w-5xl px-3 sm:px-6 pt-3">
            <div className="rounded-xl bg-[#d12925]/10 border border-[#d12925]/30 px-4 py-2.5 text-xs font-semibold text-[#b91c1c]">
              {syncError}
            </div>
          </div>
        )}

        {section === 'home' ? (
          <div className="mx-auto max-w-5xl">
            {/* 1. Portadita superior */}
            <div className="w-full overflow-hidden bg-slate-900 shadow-sm">
              <img
                src="/assets/aistudio/1769379309264_0618832d.png"
                alt="Akrobit Escritorio Corporativo"
                className="w-full h-44 sm:h-64 lg:h-72 object-cover object-center"
              />
            </div>

            {/* 2. Pequeño hilo blanco */}
            <div className="w-full h-1.5 bg-white" />

            {/* 3. Franja horizontal angosta todo el ancho: Credit Cash */}
            <div className="px-0 sm:px-6">
              <button
                type="button"
                onClick={() => setSection('credit_cash')}
                className="w-full min-h-[64px] bg-[#145f96] hover:bg-[#0e4670] active:scale-[0.995] text-white sm:rounded-b-xl px-4 sm:px-6 py-3 flex items-center justify-between gap-4 shadow-md transition-all cursor-pointer border-b-2 sm:border-x-2 border-[#df7729]"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-[#df7729] flex items-center justify-center shrink-0 shadow-sm">
                    <CreditCard className="w-5 h-5 text-white" />
                  </div>
                  <div className="text-left min-w-0">
                    <h2 className="text-base sm:text-lg font-bold tracking-tight truncate">
                      Credit Cash
                    </h2>
                    <p className="text-xs text-white/80 truncate">
                      {summary.ccClientCount} cliente(s) ·{' '}
                      <span className="font-mono text-[#a1d63e]">
                        {formatCurrency(summary.ccNio, 'NIO')}
                      </span>{' '}
                      ·{' '}
                      <span className="font-mono text-[#69b8e9]">
                        {formatCurrency(summary.ccUsd, 'USD')}
                      </span>
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="hidden sm:inline text-xs font-bold text-[#a1d63e]">
                    Abrir módulo
                  </span>
                  <ChevronRight className="w-5 h-5 text-[#df7729]" />
                </div>
              </button>
            </div>

            {/* 4. Cuadrícula 2 en 2: Maestros | Inventario | Módulo 4 | Módulo 5 */}
            <div className="px-3 sm:px-6 pt-5 space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:gap-4">
                {/* Tile 1: Maestros */}
                <button
                  type="button"
                  onClick={() => setSection('maestros')}
                  className="aspect-square sm:aspect-[4/3] rounded-2xl border-2 border-[#145f96]/20 hover:border-[#69b8e9] bg-white shadow-sm hover:shadow-md active:scale-[0.98] flex flex-col items-center justify-center p-3.5 text-center transition-all cursor-pointer"
                >
                  <div className="w-12 h-12 rounded-2xl bg-[#145f96] text-white flex items-center justify-center mb-2.5 shadow-sm ring-4 ring-[#69b8e9]/20">
                    <GraduationCap className="w-6 h-6 text-[#a1d63e]" />
                  </div>
                  <span className="text-sm sm:text-base font-bold text-[#145f96]">Maestros</span>
                  <span className="text-[11px] text-slate-500 mt-0.5">
                    {summary.maestrosClientCount} cliente(s)
                  </span>
                  {(summary.maestrosNio > 0 || summary.maestrosUsd > 0) && (
                    <span className="text-[11px] font-mono font-bold text-[#4d7c0f] mt-1 tabular-nums truncate max-w-full">
                      {summary.maestrosNio > 0
                        ? formatCurrency(summary.maestrosNio, 'NIO')
                        : formatCurrency(summary.maestrosUsd, 'USD')}
                    </span>
                  )}
                </button>

                {/* Tile 2: Inventario */}
                <button
                  type="button"
                  onClick={() => setSection('inventario')}
                  className="aspect-square sm:aspect-[4/3] rounded-2xl border-2 border-[#145f96]/20 hover:border-[#a1d63e] bg-white shadow-sm hover:shadow-md active:scale-[0.98] flex flex-col items-center justify-center p-3.5 text-center transition-all cursor-pointer"
                >
                  <div className="w-12 h-12 rounded-2xl bg-[#a1d63e] text-slate-950 flex items-center justify-center mb-2.5 shadow-sm ring-4 ring-[#a1d63e]/25">
                    <Package className="w-6 h-6" />
                  </div>
                  <span className="text-sm sm:text-base font-bold text-[#145f96]">Inventario</span>
                  <span className="text-[11px] text-slate-500 mt-0.5">
                    {summary.activeProductsCount} producto(s)
                  </span>
                  <span className="text-[11px] font-semibold text-[#df7729] mt-1">
                    Claro 🔴 · Tigo 🔵
                  </span>
                </button>

                {/* Remaining Upcoming Modules */}
                {UPCOMING_MODULES.map((mod) => (
                  <div
                    key={mod.id}
                    aria-disabled="true"
                    className="aspect-square sm:aspect-[4/3] rounded-2xl border border-dashed border-slate-300 bg-white/70 flex flex-col items-center justify-center p-4 text-center select-none"
                  >
                    <div className="w-10 h-10 rounded-xl bg-slate-100 text-slate-400 flex items-center justify-center mb-2">
                      <Layers className="w-5 h-5" />
                    </div>
                    <span className="text-xs sm:text-sm font-bold text-slate-400">{mod.label}</span>
                    <span className="text-[11px] text-slate-400 mt-0.5">Próximamente</span>
                  </div>
                ))}
              </div>

              {/* 5. Módulo Cartera Castigada (Cuentas congeladas 90+ días) */}
              <button
                type="button"
                onClick={() => setSection('cartera_castigada')}
                className="w-full min-h-[64px] bg-[#1e293b] hover:bg-[#0f172a] active:scale-[0.995] text-white rounded-2xl px-4 sm:px-6 py-3 flex items-center justify-between gap-4 shadow-md transition-all cursor-pointer border-b-2 border-[#d12925]"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-[#d12925] flex items-center justify-center shrink-0 shadow-sm">
                    <Archive className="w-5 h-5 text-white" />
                  </div>
                  <div className="text-left min-w-0">
                    <h2 className="text-base font-bold tracking-tight truncate">
                      Cartera Castigada
                    </h2>
                    <p className="text-xs text-slate-300 truncate">
                      {summary.castigadaClientCount} cliente(s) ·{' '}
                      <span className="font-mono text-[#a1d63e]">
                        {formatCurrency(summary.castigadaNio, 'NIO')}
                      </span>{' '}
                      ·{' '}
                      <span className="font-mono text-[#69b8e9]">
                        {formatCurrency(summary.castigadaUsd, 'USD')}
                      </span>
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="hidden sm:inline text-xs font-bold text-[#fca5a5]">
                    Números congelados
                  </span>
                  <ChevronRight className="w-5 h-5 text-[#d12925]" />
                </div>
              </button>
            </div>
          </div>
        ) : section === 'inventario' ? (
          <InventoryModule
            products={products}
            currentUserId={user?.uid || ''}
            currentUserName={displayName}
            isAdmin={isAdmin}
            onBackToDashboard={() => setSection('home')}
          />
        ) : section === 'maestros' ? (
          <ClosedCreditModule
            moduleId="maestros"
            moduleLabel="Maestros"
            moduleSubtitle="Créditos cerrados · Recargas y ventas de inventario"
            clients={clients}
            credits={credits}
            transactions={transactions}
            products={products}
            currentUserId={user?.uid || ''}
            currentUserName={displayName}
            isAdmin={isAdmin}
            onBackToDashboard={() => setSection('home')}
            onTriggerInvoice={(inv) => setActiveInvoice(inv)}
          />
        ) : (
          <CreditCashModule
            clients={clients}
            credits={credits}
            transactions={transactions}
            products={products}
            currentUserId={user?.uid || ''}
            currentUserName={displayName}
            isAdmin={isAdmin}
            portfolioMode={section === 'cartera_castigada' ? 'castigada' : 'active'}
            incomingSharedContacts={incomingSharedContacts}
            onConsumeSharedContacts={() => setIncomingSharedContacts([])}
            onBackToDashboard={() => setSection('home')}
            onTriggerInvoice={(inv) => setActiveInvoice(inv)}
          />
        )}
      </main>

      <OfflineIndicator pendingCount={pendingWritesCount} />

      <AdminNotificationsModal
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
        requests={modRequests}
        teamUsers={teamUsers}
        overdueAlerts={overdueAlerts}
        clients={clients}
        credits={credits}
        transactions={transactions}
        products={products}
        adminUid={user?.uid || ''}
        adminName={displayName}
        onTriggerInvoice={(inv) => setActiveInvoice(inv)}
      />

      <WhatsAppInvoiceModal
        invoice={activeInvoice}
        onClose={() => setActiveInvoice(null)}
      />
    </div>
  );
};
