import React, { useState } from 'react';
import { Bell, Check, Edit3, ShieldCheck, UserCheck, UserX, Users, X, XCircle } from 'lucide-react';
import { doc, getDoc, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore';
import { OperationType, ORG_ID, db, handleFirestoreError } from '../lib/firebase';
import {
  INTEREST_RATE_OPTIONS,
  calculateInitialCreditTotal,
  formatCurrency,
  round2,
} from '../lib/finance';
import { generateDocId } from '../lib/finance';
import { syncClientPortalFromServer } from '../lib/clientPortal';
import type { Credit, CreditTransaction, ModificationRequest, UserProfile } from '../types';

interface AdminNotificationsModalProps {
  open: boolean;
  onClose: () => void;
  requests: ModificationRequest[];
  teamUsers?: UserProfile[];
  adminUid: string;
  adminName: string;
}

export const AdminNotificationsModal: React.FC<AdminNotificationsModalProps> = ({
  open,
  onClose,
  requests,
  teamUsers = [],
  adminUid,
  adminName,
}) => {
  const [activeTab, setActiveTab] = useState<'requests' | 'team'>('requests');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [overrideAmount, setOverrideAmount] = useState('');
  const [overrideRate, setOverrideRate] = useState<number>(5);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');

  if (!open) return null;

  const pendingRequests = requests.filter((r) => r.status === 'pending');
  const managedMembers = teamUsers.filter((member) => member.uid !== adminUid);
  const pendingMembersCount = managedMembers.filter((member) => !member.active).length;

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

      let prevBalance = credit.currentBalance;
      let nextBalance = credit.currentBalance;

      if (req.targetType === 'credit') {
        const newInitialTotal = calculateInitialCreditTotal(finalValue, finalRate);
        const delta = round2(newInitialTotal - credit.initialTotal);
        nextBalance = round2(Math.max(0, credit.currentBalance + delta));

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
      batch.set(doc(db, 'transactions', adjTxId), {
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

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/65 backdrop-blur-sm p-0 sm:p-4">
      <div className="w-full sm:max-w-lg max-h-[88dvh] flex flex-col rounded-t-3xl sm:rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
        <div className="bg-[#145f96] px-5 py-4 flex items-center justify-between text-white shrink-0">
          <div className="flex items-center gap-2.5">
            <Bell className="w-5 h-5 text-[#df7729]" />
            <div>
              <h3 className="text-base font-bold">Aprobaciones de Administrador</h3>
              <p className="text-xs text-white/80">
                {pendingRequests.length} solicitud(es) · {pendingMembersCount} acceso(s) pendiente(s)
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar notificaciones"
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl hover:bg-white/15 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 border-b border-slate-200 bg-slate-50 shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab('requests')}
            className={`min-h-[44px] px-3 text-xs font-bold flex items-center justify-center gap-1.5 border-b-2 transition-colors cursor-pointer ${
              activeTab === 'requests'
                ? 'border-[#145f96] text-[#145f96] bg-white'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Bell className="w-3.5 h-3.5" />
            <span>Solicitudes ({pendingRequests.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('team')}
            className={`min-h-[44px] px-3 text-xs font-bold flex items-center justify-center gap-1.5 border-b-2 transition-colors cursor-pointer ${
              activeTab === 'team'
                ? 'border-[#145f96] text-[#145f96] bg-white'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>Accesos ({pendingMembersCount})</span>
          </button>
        </div>

        <div className="p-4 sm:p-5 overflow-y-auto space-y-3 flex-1">
          {feedback && (
            <div className="rounded-xl bg-[#a1d63e]/15 border border-[#a1d63e]/40 px-3.5 py-2.5 text-xs font-semibold text-slate-800">
              {feedback}
            </div>
          )}

          {activeTab === 'team' ? (
            managedMembers.length === 0 ? (
              <div className="py-10 text-center space-y-2">
                <ShieldCheck className="w-8 h-8 text-[#a1d63e] mx-auto" />
                <p className="text-sm font-semibold text-slate-700">
                  Solo tú tienes acceso registrado en este momento.
                </p>
                <p className="text-xs text-slate-500">
                  Si alguien crea una cuenta de colaborador, quedará bloqueada aquí hasta que tú la autorices.
                </p>
              </div>
            ) : (
              managedMembers.map((member) => {
                const isBusy = busyId === member.uid;
                return (
                  <div
                    key={member.uid}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-[#145f96] truncate">
                        {member.displayName}
                      </p>
                      <p className="text-xs text-slate-500">
                        {member.active ? 'Acceso autorizado' : 'Bloqueado / Pendiente de autorización'}
                      </p>
                    </div>
                    {member.active ? (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void toggleMemberAccess(member, false)}
                        className="min-h-[40px] px-3 rounded-xl bg-[#d12925]/10 hover:bg-[#d12925]/20 text-[#d12925] text-xs font-bold flex items-center gap-1.5 cursor-pointer shrink-0"
                      >
                        <UserX className="w-3.5 h-3.5" />
                        <span>Bloquear</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void toggleMemberAccess(member, true)}
                        className="min-h-[40px] px-3 rounded-xl bg-[#a1d63e] hover:bg-[#8ec22f] text-slate-950 text-xs font-bold flex items-center gap-1.5 cursor-pointer shrink-0"
                      >
                        <UserCheck className="w-3.5 h-3.5" />
                        <span>Autorizar</span>
                      </button>
                    )}
                  </div>
                );
              })
            )
          ) : pendingRequests.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500">
              No hay solicitudes de modificación pendientes en este momento.
            </div>
          ) : (
            pendingRequests.map((req) => {
              const isEditing = editingId === req.id;
              const isBusy = busyId === req.id;

              return (
                <div
                  key={req.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-bold text-[#145f96]">{req.clientName}</p>
                      <p className="text-xs text-slate-500">
                        Solicitado por <strong>{req.requestedByName}</strong> ·{' '}
                        {req.targetType === 'credit' ? 'Edición de Crédito' : 'Edición de Pago'}
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
                          applyModification(req, req.newValue, req.newInterestRate, 'approved')
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
        </div>
      </div>
    </div>
  );
};
