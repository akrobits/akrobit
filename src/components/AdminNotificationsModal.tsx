import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Check,
  ChevronRight,
  Edit3,
  ShieldCheck,
  UserCheck,
  UserX,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import { doc, getDoc, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore';
import { OperationType, ORG_ID, db, handleFirestoreError } from '../lib/firebase';
import {
  INTEREST_RATE_OPTIONS,
  calculateInitialCreditTotal,
  formatCurrency,
  generateDocId,
  round2,
  toTimestampMillis,
  type OverdueClientAlert,
} from '../lib/finance';
import { syncClientPortalFromServer } from '../lib/clientPortal';
import { useBackHandler } from '../lib/backNavigation';
import { ClientDetailModal } from './ClientDetailModal';
import type {
  Client,
  Credit,
  CreditTransaction,
  InvoicePayload,
  ModificationRequest,
  UserProfile,
} from '../types';

const ONLINE_STALE_MS = 180_000;

function isMemberOnline(member: UserProfile, nowMs: number): boolean {
  if (member.isOnline !== true) return false;
  const seenMs = toTimestampMillis(member.lastSeenAt);
  if (seenMs <= 0) return false;
  return nowMs - seenMs <= ONLINE_STALE_MS;
}

function formatLastSeen(ts: unknown): string {
  const ms = toTimestampMillis(ts);
  if (ms <= 0) return 'Sin registro de conexión';
  return new Date(ms).toLocaleString('es-NI', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

interface AdminNotificationsModalProps {
  open: boolean;
  onClose: () => void;
  requests: ModificationRequest[];
  teamUsers?: UserProfile[];
  overdueAlerts?: OverdueClientAlert[];
  clients?: Client[];
  credits?: Credit[];
  transactions?: CreditTransaction[];
  adminUid: string;
  adminName: string;
  onTriggerInvoice?: (invoice: InvoicePayload) => void;
}

export const AdminNotificationsModal: React.FC<AdminNotificationsModalProps> = ({
  open,
  onClose,
  requests,
  teamUsers = [],
  overdueAlerts = [],
  clients = [],
  credits = [],
  transactions = [],
  adminUid,
  adminName,
  onTriggerInvoice,
}) => {
  const [activeTab, setActiveTab] = useState<'requests' | 'team' | 'alerts'>('requests');
  const [selectedAlertTarget, setSelectedAlertTarget] = useState<{
    key: string;
    moduleLabel: string;
    clientId: string;
  } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [overrideAmount, setOverrideAmount] = useState('');
  const [overrideRate, setOverrideRate] = useState<number>(5);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');

  useBackHandler(Boolean(open && selectedAlertTarget), () => setSelectedAlertTarget(null));

  const nowMs = Date.now();

  const sortedTeamUsers = useMemo(() => {
    return [...teamUsers].sort((a, b) => {
      const aOnline = a.uid === adminUid || isMemberOnline(a, nowMs);
      const bOnline = b.uid === adminUid || isMemberOnline(b, nowMs);
      if (aOnline !== bOnline) return aOnline ? -1 : 1;
      if (a.uid === adminUid) return -1;
      if (b.uid === adminUid) return 1;
      return a.displayName.localeCompare(b.displayName, 'es');
    });
  }, [teamUsers, adminUid, nowMs]);

  const onlineUsersCount = useMemo(
    () =>
      sortedTeamUsers.filter(
        (member) => member.uid === adminUid || isMemberOnline(member, nowMs)
      ).length,
    [sortedTeamUsers, adminUid, nowMs]
  );

  const selectedLiveAlertData = useMemo(() => {
    if (!selectedAlertTarget) return null;
    const liveClient =
      clients.find((c) => c.id === selectedAlertTarget.clientId && c.active !== false) ||
      overdueAlerts.find((a) => a.client.id === selectedAlertTarget.clientId)?.client ||
      null;
    if (!liveClient) return null;

    const liveCredits =
      credits.length > 0
        ? credits.filter((cr) => cr.clientId === liveClient.id)
        : overdueAlerts.find((a) => a.client.id === liveClient.id)?.credits || [];
    const liveTxs =
      transactions.length > 0
        ? transactions.filter((tx) => tx.clientId === liveClient.id)
        : overdueAlerts.find((a) => a.client.id === liveClient.id)?.transactions || [];

    return {
      client: liveClient,
      credits: liveCredits,
      transactions: liveTxs,
      moduleLabel: selectedAlertTarget.moduleLabel,
    };
  }, [selectedAlertTarget, clients, credits, transactions, overdueAlerts]);

  if (!open) return null;

  const pendingRequests = requests.filter((r) => r.status === 'pending');

  const toggleMemberAccess = async (member: UserProfile, nextActive: boolean) => {
    setBusyId(member.uid);
    setFeedback('');
    try {
      await updateDoc(doc(db, 'users', member.uid), {
        active: nextActive,
        updatedAt: serverTimestamp(),
      });
      setFeedback(
        nextActive
          ? `Acceso autorizado para ${member.displayName}.`
          : `Acceso bloqueado para ${member.displayName}.`
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${member.uid}`);
    } finally {
      setBusyId(null);
    }
  };

  const applyModification = async (
    req: ModificationRequest,
    finalValue: number,
    finalRate: number,
    finalStatus: 'approved' | 'corrected'
  ) => {
    setBusyId(req.id);
    setFeedback('');
    try {
      const creditRef = doc(db, 'credits', req.creditId);
      const creditSnap = await getDoc(creditRef);
      if (!creditSnap.exists()) {
        setFeedback('El crédito referenciado ya no existe.');
        setBusyId(null);
        return;
      }
      const credit = creditSnap.data() as Credit;

      const batch = writeBatch(db);
      const reqRef = doc(db, 'modificationRequests', req.id);

      const prevBalance = credit.currentBalance;
      let nextBalance = credit.currentBalance;

      if (req.targetType === 'credit') {
        const newInitialTotal = calculateInitialCreditTotal(finalValue, finalRate);
        if (credit.interestMode === 'prorated_daily') {
          const deltaPrincipal = round2(finalValue - credit.principal);
          nextBalance = round2(Math.max(0, credit.currentBalance + deltaPrincipal));
        } else {
          const delta = round2(newInitialTotal - credit.initialTotal);
          nextBalance = round2(Math.max(0, credit.currentBalance + delta));
        }

        batch.update(creditRef, {
          principal: round2(finalValue),
          interestRate: finalRate,
          initialTotal: newInitialTotal,
          currentBalance: nextBalance,
          status: nextBalance <= 0 ? 'settled' : 'active',
          updatedAt: serverTimestamp(),
        });
      } else if (req.transactionId) {
        const txRef = doc(db, 'transactions', req.transactionId);
        const txSnap = await getDoc(txRef);
        if (txSnap.exists()) {
          const tx = txSnap.data() as CreditTransaction;
          const paymentDiff = round2(finalValue - tx.amount);
          const adjustedRemaining = round2(Math.max(0, credit.currentBalance - paymentDiff));
          nextBalance = adjustedRemaining;

          batch.update(txRef, {
            amount: round2(finalValue),
            interestRate: finalRate,
            newBalance: nextBalance,
            note: `Corregido por Admin (${adminName})`,
          });

          batch.update(creditRef, {
            interestRate: finalRate,
            currentBalance: nextBalance,
            status: nextBalance <= 0 ? 'settled' : 'active',
            updatedAt: serverTimestamp(),
          });
        }
      }

      const adjTxId = generateDocId('tx');
      batch.set(doc(db, 'transactions', adjIdWithFallback(adjTxId)), {
        id: adjTxId,
        creditId: req.creditId,
        clientId: req.clientId,
        type: 'adjustment',
        currency: req.currency,
        amount: round2(finalValue),
        interestRate: finalRate,
        previousBalance: prevBalance,
        newBalance: nextBalance,
        note: `${finalStatus === 'approved' ? 'Aprobado' : 'Corregido'} por ${adminName}: ${req.reason}`,
        orgId: ORG_ID,
        createdBy: adminUid,
        createdByName: adminName,
        createdAt: serverTimestamp(),
      });

      batch.update(reqRef, {
        status: finalStatus,
        newValue: round2(finalValue),
        newInterestRate: finalRate,
        reviewedBy: adminUid,
        reviewedByName: adminName,
        updatedAt: serverTimestamp(),
      });

      await batch.commit();
      void syncClientPortalFromServer(req.clientId);
      setEditingId(null);
      setFeedback(
        finalStatus === 'approved'
          ? 'Solicitud aprobada y registro actualizado.'
          : 'Corrección aplicada directamente por el administrador.'
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `modificationRequests/${req.id}`);
    } finally {
      setBusyId(null);
    }
  };

  const rejectRequest = async (req: ModificationRequest) => {
    setBusyId(req.id);
    setFeedback('');
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'modificationRequests', req.id), {
        status: 'rejected',
        reviewedBy: adminUid,
        reviewedByName: adminName,
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
      setFeedback('Solicitud rechazada. No se modificó el registro.');
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `modificationRequests/${req.id}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleCloseModal = () => {
    setSelectedAlertTarget(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/65 backdrop-blur-sm p-0 sm:p-4">
      <div className="w-full sm:max-w-2xl max-h-[92dvh] flex flex-col rounded-t-3xl sm:rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
        {/* Top corporate header */}
        <div className="bg-[#145f96] px-5 py-4 flex items-center justify-between text-white shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <Bell className="w-5 h-5 text-[#df7729] shrink-0" />
            <div className="min-w-0">
              <h3 className="text-base font-bold truncate">
                {selectedLiveAlertData
                  ? `Alerta · ${selectedLiveAlertData.moduleLabel}`
                  : 'Centro de Alertas y Aprobaciones'}
              </h3>
              <p className="text-xs text-white/80 truncate">
                {selectedLiveAlertData
                  ? `${selectedLiveAlertData.client.name} · Gestión directa`
                  : `${pendingRequests.length} solicitud(es) · ${onlineUsersCount} conectado(s) · ${overdueAlerts.length} vencido(s)`}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleCloseModal}
            aria-label="Cerrar notificaciones"
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl hover:bg-white/15 cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* If a client from Alerta is selected, open full ClientDetailModal directly inside */}
        {selectedLiveAlertData ? (
          <div className="p-3 sm:p-5 overflow-y-auto flex-1 bg-slate-50">
            <ClientDetailModal
              client={selectedLiveAlertData.client}
              credits={selectedLiveAlertData.credits}
              transactions={selectedLiveAlertData.transactions}
              currentUserId={adminUid}
              currentUserName={adminName}
              isAdmin={true}
              onBack={() => setSelectedAlertTarget(null)}
              onTriggerInvoice={(inv) => {
                if (onTriggerInvoice) {
                  onTriggerInvoice(inv);
                }
              }}
            />
          </div>
        ) : (
          <>
            {/* 3-Column Corporate Tab Bar: Solicitudes (Orange) | Acceso (Green) | Alerta (Red) */}
            <div className="grid grid-cols-3 border-b border-slate-200 bg-slate-50 shrink-0">
              <button
                type="button"
                onClick={() => setActiveTab('requests')}
                className={`min-h-[48px] px-2 text-xs font-bold flex items-center justify-center gap-1.5 border-b-[3px] transition-colors cursor-pointer whitespace-nowrap ${
                  activeTab === 'requests'
                    ? 'border-[#df7729] text-[#df7729] bg-white'
                    : 'border-transparent text-slate-500 hover:text-[#df7729]'
                }`}
              >
                <span className="w-2 h-2 rounded-full bg-[#df7729] shrink-0" />
                <span>Solicitudes ({pendingRequests.length})</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('team')}
                className={`min-h-[48px] px-2 text-xs font-bold flex items-center justify-center gap-1.5 border-b-[3px] transition-colors cursor-pointer whitespace-nowrap ${
                  activeTab === 'team'
                    ? 'border-[#a1d63e] text-[#4d7c0f] bg-white'
                    : 'border-transparent text-slate-500 hover:text-[#4d7c0f]'
                }`}
              >
                <span className="w-2 h-2 rounded-full bg-[#a1d63e] shrink-0" />
                <span>Acceso ({onlineUsersCount})</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('alerts')}
                className={`min-h-[48px] px-2 text-xs font-bold flex items-center justify-center gap-1.5 border-b-[3px] transition-colors cursor-pointer whitespace-nowrap ${
                  activeTab === 'alerts'
                    ? 'border-[#d12925] text-[#d12925] bg-white'
                    : 'border-transparent text-slate-500 hover:text-[#d12925]'
                }`}
              >
                <span className="w-2 h-2 rounded-full bg-[#d12925] shrink-0" />
                <span>Alerta ({overdueAlerts.length})</span>
              </button>
            </div>

            <div className="p-4 sm:p-5 overflow-y-auto space-y-3 flex-1">
              {feedback && (
                <div className="rounded-xl bg-[#a1d63e]/15 border border-[#a1d63e]/40 px-3.5 py-2.5 text-xs font-semibold text-slate-800">
                  {feedback}
                </div>
              )}

              {/* TAB 1: SOLICITUDES (Orange #df7729) */}
              {activeTab === 'requests' && (
                <>
                  {pendingRequests.length === 0 ? (
                    <div className="py-10 text-center space-y-1.5">
                      <Bell className="w-8 h-8 text-[#df7729]/60 mx-auto" />
                      <p className="text-sm font-semibold text-slate-700">
                        Sin solicitudes pendientes
                      </p>
                      <p className="text-xs text-slate-500">
                        Aquí aparecen las modificaciones o cambios que envíen tus empleados para tu aprobación.
                      </p>
                    </div>
                  ) : (
                    pendingRequests.map((req) => {
                      const isEditing = editingId === req.id;
                      const isBusy = busyId === req.id;

                      return (
                        <div
                          key={req.id}
                          className="rounded-2xl border border-[#df7729]/30 bg-slate-50 p-4 space-y-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="text-sm font-bold text-[#145f96]">{req.clientName}</p>
                              <p className="text-xs text-slate-500">
                                Solicitado por <strong>{req.requestedByName}</strong> ·{' '}
                                {req.targetType === 'credit'
                                  ? 'Edición de Crédito'
                                  : 'Edición de Pago'}
                              </p>
                            </div>
                            <span className="text-xs font-bold text-[#df7729] whitespace-nowrap">
                              Pendiente
                            </span>
                          </div>

                          <div className="grid grid-cols-2 gap-2 text-xs bg-white rounded-xl p-3 border border-slate-200">
                            <div>
                              <span className="text-slate-500 block">Valor anterior</span>
                              <span className="font-mono font-semibold text-slate-800 tabular-nums">
                                {formatCurrency(req.oldValue, req.currency)} ({req.oldInterestRate}%)
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-500 block">Nuevo valor propuesto</span>
                              <span className="font-mono font-bold text-[#145f96] tabular-nums">
                                {formatCurrency(req.newValue, req.currency)} ({req.newInterestRate}%)
                              </span>
                            </div>
                          </div>

                          <p className="text-xs text-slate-700 bg-white rounded-lg px-3 py-2 border border-slate-100">
                            <strong>Motivo:</strong> {req.reason}
                          </p>

                          {isEditing ? (
                            <div className="space-y-2.5 bg-white p-3 rounded-xl border border-[#69b8e9]/40">
                              <p className="text-xs font-bold text-[#145f96]">
                                Corregir monto y porcentaje final:
                              </p>
                              <div className="grid grid-cols-2 gap-2">
                                <input
                                  type="number"
                                  step="0.01"
                                  value={overrideAmount}
                                  onChange={(e) => setOverrideAmount(e.target.value)}
                                  placeholder="Monto final"
                                  className="min-h-[42px] rounded-xl border border-slate-300 px-3 text-sm font-mono tabular-nums"
                                />
                                <select
                                  value={overrideRate}
                                  onChange={(e) => setOverrideRate(Number(e.target.value))}
                                  className="min-h-[42px] rounded-xl border border-slate-300 px-3 text-sm font-mono bg-white"
                                >
                                  {INTEREST_RATE_OPTIONS.map((rate) => (
                                    <option key={rate} value={rate}>
                                      {rate}%
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() =>
                                    applyModification(
                                      req,
                                      Number(overrideAmount) || req.newValue,
                                      overrideRate,
                                      'corrected'
                                    )
                                  }
                                  className="flex-1 min-h-[42px] rounded-xl bg-[#145f96] text-white text-xs font-bold cursor-pointer"
                                >
                                  Aplicar corrección
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingId(null)}
                                  className="px-3 min-h-[42px] rounded-xl bg-slate-100 text-slate-700 text-xs font-semibold cursor-pointer"
                                >
                                  Cancelar
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="grid grid-cols-3 gap-2">
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() =>
                                  applyModification(
                                    req,
                                    req.newValue,
                                    req.newInterestRate,
                                    'approved'
                                  )
                                }
                                className="min-h-[42px] rounded-xl bg-[#a1d63e] hover:bg-[#8ec22f] text-slate-950 text-xs font-bold flex items-center justify-center gap-1 cursor-pointer"
                              >
                                <Check className="w-3.5 h-3.5" />
                                <span>Aprobar</span>
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => {
                                  setEditingId(req.id);
                                  setOverrideAmount(String(req.newValue));
                                  setOverrideRate(req.newInterestRate);
                                }}
                                className="min-h-[42px] rounded-xl bg-[#69b8e9]/15 hover:bg-[#69b8e9]/25 text-[#145f96] text-xs font-bold flex items-center justify-center gap-1 cursor-pointer"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                                <span>Corregir</span>
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => rejectRequest(req)}
                                className="min-h-[42px] rounded-xl bg-[#d12925]/10 hover:bg-[#d12925]/20 text-[#d12925] text-xs font-bold flex items-center justify-center gap-1 cursor-pointer"
                              >
                                <XCircle className="w-3.5 h-3.5" />
                                <span>Rechazar</span>
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </>
              )}

              {/* TAB 2: ACCESO / USUARIOS CONECTADOS (Green #a1d63e) */}
              {activeTab === 'team' && (
                <>
                  <div className="rounded-xl bg-[#a1d63e]/15 border border-[#a1d63e]/40 px-3.5 py-2.5 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 font-bold text-[#4d7c0f]">
                      <Users className="w-4 h-4 shrink-0" />
                      <span>Usuarios conectados en este momento</span>
                    </div>
                    <span className="font-mono font-bold text-[#4d7c0f] tabular-nums">
                      {onlineUsersCount} / {sortedTeamUsers.length}
                    </span>
                  </div>

                  {sortedTeamUsers.length === 0 ? (
                    <div className="py-10 text-center space-y-2">
                      <ShieldCheck className="w-8 h-8 text-[#a1d63e] mx-auto" />
                      <p className="text-sm font-semibold text-slate-700">
                        Solo tú estás conectado actualmente.
                      </p>
                      <p className="text-xs text-slate-500">
                        Los colaboradores autorizados aparecerán aquí en tiempo real al conectarse.
                      </p>
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-slate-200 divide-y divide-slate-200/70 overflow-hidden akrobit-zebra-rows">
                      {sortedTeamUsers.map((member) => {
                        const isSelf = member.uid === adminUid;
                        const online = isSelf || isMemberOnline(member, nowMs);
                        const isBusy = busyId === member.uid;

                        return (
                          <div
                            key={member.uid}
                            className="px-4 py-3 flex items-center justify-between gap-3"
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <span
                                className={`w-3 h-3 rounded-full shrink-0 ${
                                  online ? 'bg-[#a1d63e] ring-2 ring-[#a1d63e]/35' : 'bg-slate-300'
                                }`}
                              />
                              <div className="min-w-0">
                                <p className="text-sm font-bold text-[#145f96] truncate">
                                  {member.displayName}
                                  {isSelf && (
                                    <span className="text-xs font-semibold text-[#4d7c0f]">
                                      {' '}
                                      (Tú · Admin)
                                    </span>
                                  )}
                                </p>
                                <p className="text-xs truncate">
                                  {online ? (
                                    <span className="font-bold text-[#4d7c0f]">Conectado ahora</span>
                                  ) : member.active ? (
                                    <span className="text-slate-500">
                                      Desconectado · Últ. vez {formatLastSeen(member.lastSeenAt)}
                                    </span>
                                  ) : (
                                    <span className="font-semibold text-[#d12925]">
                                      Sin autorización de acceso
                                    </span>
                                  )}
                                </p>
                              </div>
                            </div>

                            {!isSelf && (
                              <div className="shrink-0">
                                {member.active ? (
                                  <button
                                    type="button"
                                    disabled={isBusy}
                                    onClick={() => void toggleMemberAccess(member, false)}
                                    className="min-h-[38px] px-3 rounded-xl bg-[#d12925]/10 hover:bg-[#d12925]/20 text-[#d12925] text-xs font-bold flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                                  >
                                    <UserX className="w-3.5 h-3.5" />
                                    <span>Bloquear</span>
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={isBusy}
                                    onClick={() => void toggleMemberAccess(member, true)}
                                    className="min-h-[38px] px-3 rounded-xl bg-[#a1d63e] hover:bg-[#8ec22f] text-slate-950 text-xs font-bold flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                                  >
                                    <UserCheck className="w-3.5 h-3.5" />
                                    <span>Autorizar</span>
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}

              {/* TAB 3: ALERTA 30+ DÍAS SIN ABONO (Red #d12925) */}
              {activeTab === 'alerts' && (
                <>
                  <div className="rounded-xl bg-[#d12925]/10 border border-[#d12925]/30 px-3.5 py-2.5 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 font-bold text-[#d12925]">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      <span>Créditos con 30 o más días sin abono</span>
                    </div>
                    <span className="font-mono font-bold text-[#d12925] tabular-nums">
                      {overdueAlerts.length}
                    </span>
                  </div>

                  {overdueAlerts.length === 0 ? (
                    <div className="py-10 text-center space-y-2">
                      <ShieldCheck className="w-8 h-8 text-[#a1d63e] mx-auto" />
                      <p className="text-sm font-semibold text-slate-700">
                        Sin clientes vencidos de 30+ días
                      </p>
                      <p className="text-xs text-slate-500">
                        Cuando algún cliente de cualquier módulo cumpla 30 días sin realizar un abono, aparecerá aquí para gestión inmediata.
                      </p>
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-[#d12925]/30 divide-y divide-slate-200/70 overflow-hidden akrobit-zebra-rows">
                      {overdueAlerts.map((alert) => (
                        <button
                          key={alert.key}
                          type="button"
                          onClick={() =>
                            setSelectedAlertTarget({
                              key: alert.key,
                              moduleLabel: alert.moduleLabel,
                              clientId: alert.client.id,
                            })
                          }
                          className="w-full min-h-[68px] px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-[#d12925]/10 transition-colors cursor-pointer shadow-[inset_0_-3px_0_0_#d12925]"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-bold text-slate-900 truncate underline decoration-[#d12925] decoration-2 underline-offset-4">
                              {alert.client.name}
                            </p>
                            <p className="text-xs text-slate-500 truncate mt-0.5">
                              <span className="font-semibold text-[#145f96]">
                                {alert.moduleLabel}
                              </span>{' '}
                              ·{' '}
                              <span className="font-bold text-[#d12925]">
                                {alert.maxDaysWithoutPayment} días sin abono
                              </span>
                            </p>
                          </div>

                          <div className="text-right shrink-0 font-mono text-xs tabular-nums">
                            {alert.totalNio > 0 && (
                              <p className="font-bold text-[#145f96]">
                                {formatCurrency(alert.totalNio, 'NIO')}
                              </p>
                            )}
                            {alert.totalUsd > 0 && (
                              <p className="font-bold text-[#df7729]">
                                {formatCurrency(alert.totalUsd, 'USD')}
                              </p>
                            )}
                          </div>

                          <ChevronRight className="w-4 h-4 text-[#d12925] shrink-0" />
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

function adjIdWithFallback(id: string): string {
  return id || generateDocId('tx');
}
