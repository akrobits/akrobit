import React, { useMemo, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  BadgeDollarSign,
  Banknote,
  Building2,
  Check,
  CheckCircle2,
  Copy,
  CreditCard,
  FileEdit,
  History,
  KeyRound,
  Layers,
  MessageCircle,
  RefreshCw,
  ShieldAlert,
  Snowflake,
  X,
} from 'lucide-react';
import { doc, serverTimestamp, writeBatch, type WriteBatch } from 'firebase/firestore';
import { ORG_ID, db } from '../lib/firebase';
import {
  INTEREST_RATE_OPTIONS,
  buildWhatsAppBusinessLink,
  calculateInitialCreditTotal,
  calculateInterestCeil,
  calculateLiveCreditStatus,
  calculatePaymentOnBalance,
  calculateProratedPayment,
  formatActorName,
  formatCurrency,
  formatPaymentMethodLabel,
  generateDocId,
  getPortalAgingTier,
  isAndroidDevice,
  round2,
  type LiveCreditStatus,
} from '../lib/finance';
import {
  attachPortalSnapshotToBatch,
  buildClientPortalAccessMessage,
  computePortalKey,
  generatePortalCode,
  getPublicPortalUrl,
  regenerateClientPortalCredentials,
} from '../lib/clientPortal';
import { useBackHandler } from '../lib/backNavigation';
import type {
  Client,
  ConsolidatedCreditItem,
  Credit,
  CreditTransaction,
  CurrencyCode,
  InvoicePayload,
  PaymentMethod,
} from '../types';

type ActiveAction = 'menu' | 'add_credit' | 'register_payment' | 'modify_records';

function getTimestampMillis(ts: unknown): number {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return ts;
  }
  if (ts && typeof ts === 'object' && 'toMillis' in ts) {
    return (ts as { toMillis: () => number }).toMillis();
  }
  return Date.now();
}

interface ClientDetailModalProps {
  client: Client;
  credits: Credit[];
  transactions: CreditTransaction[];
  currentUserId: string;
  currentUserName: string;
  isAdmin: boolean;
  onBack: () => void;
  onTriggerInvoice: (invoice: InvoicePayload) => void;
}

export const ClientDetailModal: React.FC<ClientDetailModalProps> = ({
  client,
  credits,
  transactions,
  currentUserId,
  currentUserName,
  isAdmin,
  onBack,
  onTriggerInvoice,
}) => {
  const [action, setAction] = useState<ActiveAction>('menu');

  // 1. Registrar Crédito state
  const [currency, setCurrency] = useState<CurrencyCode>('NIO');
  const [principalInput, setPrincipalInput] = useState('');
  const [interestRate, setInterestRate] = useState<number | ''>('');

  // All client credits ordered chronologically oldest -> newest so Credit Cash N°1, N°2, N°3... never renumber
  const allCreditsSorted = useMemo(
    () =>
      [...credits].sort(
        (a, b) => getTimestampMillis(a.createdAt) - getTimestampMillis(b.createdAt)
      ),
    [credits]
  );

  const activeCredits = useMemo(
    () =>
      allCreditsSorted.filter((c) => c.status === 'active' && c.currentBalance > 0),
    [allCreditsSorted]
  );

  const creditLabelById = useMemo(() => {
    const map = new Map<string, string>();
    allCreditsSorted.forEach((cr, idx) => {
      map.set(cr.id, `Credit Cash N°${idx + 1}`);
    });
    return map;
  }, [allCreditsSorted]);

  const [selectedCreditId, setSelectedCreditId] = useState<string>('');
  const [paymentInput, setPaymentInput] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | ''>('');
  const [whatsappPickOpen, setWhatsappPickOpen] = useState(false);

  // 3. Modificar Registros state
  const [modifyTargetType, setModifyTargetType] = useState<'credit' | 'transaction'>('credit');
  const [modifyCreditId, setModifyCreditId] = useState<string>(() => credits[0]?.id || '');
  const [modifyTxId, setModifyTxId] = useState<string>('');
  const [modifyNewValue, setModifyNewValue] = useState('');
  const [modifyNewRate, setModifyNewRate] = useState<number>(10);
  const [modifyReason, setModifyReason] = useState('');

  const isCastigada = client.portfolioStatus === 'castigada';

  const [submitting, setSubmitting] = useState(false);
  const [regeneratingCode, setRegeneratingCode] = useState(false);
  const [portalCopied, setPortalCopied] = useState(false);
  const [castigadaConfirmOpen, setCastigadaConfirmOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  useBackHandler(action !== 'menu', () => {
    setErrorMessage('');
    setStatusMessage('');
    setAction('menu');
  });
  useBackHandler(whatsappPickOpen, () => setWhatsappPickOpen(false));
  useBackHandler(castigadaConfirmOpen, () => setCastigadaConfirmOpen(false));

  const liveStatusByCreditId = useMemo(() => {
    const map = new Map<string, LiveCreditStatus>();
    for (const cr of activeCredits) {
      map.set(cr.id, calculateLiveCreditStatus(cr, transactions));
    }
    return map;
  }, [activeCredits, transactions]);

  const maxDaysWithoutPayment = useMemo(() => {
    let maxDays = 0;
    for (const st of liveStatusByCreditId.values()) {
      if (st.daysElapsed > maxDays) maxDays = st.daysElapsed;
    }
    return maxDays;
  }, [liveStatusByCreditId]);

  const totalsByCurrency = useMemo(() => {
    let nio = 0;
    let usd = 0;
    for (const c of activeCredits) {
      const live = liveStatusByCreditId.get(c.id);
      const due = live ? live.totalDueToday : c.currentBalance;
      if (c.currency === 'NIO') nio = round2(nio + due);
      else usd = round2(usd + due);
    }
    return { nio, usd };
  }, [activeCredits, liveStatusByCreditId]);

  const parsedPrincipal = Number(principalInput) || 0;
  const computedCreditTotal = useMemo(
    () =>
      interestRate === ''
        ? 0
        : calculateInitialCreditTotal(parsedPrincipal, interestRate),
    [parsedPrincipal, interestRate]
  );

  const activePaymentCredit = useMemo(() => {
    if (activeCredits.length === 1) return activeCredits[0];
    return activeCredits.find((c) => c.id === selectedCreditId) || null;
  }, [activeCredits, selectedCreditId]);

  const activePaymentLiveStatus = useMemo(
    () => (activePaymentCredit ? liveStatusByCreditId.get(activePaymentCredit.id) || null : null),
    [activePaymentCredit, liveStatusByCreditId]
  );

  const parsedPayment = Number(paymentInput) || 0;
  const paymentPreview = useMemo(() => {
    if (!activePaymentCredit || !activePaymentLiveStatus) return null;
    if (activePaymentLiveStatus.isFrozen) {
      const totalDueToday = activePaymentLiveStatus.totalDueToday;
      const safePayment = round2(Math.max(0, parsedPayment));
      const newBalance = round2(Math.max(0, totalDueToday - safePayment));
      return {
        mode: activePaymentLiveStatus.isProratedDaily
          ? ('prorated_daily' as const)
          : ('pre_added' as const),
        baseBalance: activePaymentLiveStatus.baseBalance,
        daysElapsed: activePaymentLiveStatus.daysElapsed,
        accruedInterest: activePaymentLiveStatus.accruedInterest,
        totalDueToday,
        remainingBeforeInterest: newBalance,
        interestAdded: 0,
        newBalance,
        settled: newBalance <= 0,
      };
    }

    if (activePaymentLiveStatus.isProratedDaily) {
      const res = calculateProratedPayment(
        activePaymentLiveStatus.baseBalance,
        activePaymentCredit.interestRate,
        activePaymentLiveStatus.daysElapsed,
        parsedPayment
      );
      return {
        mode: 'prorated_daily' as const,
        ...res,
      };
    }

    const effectiveStart = activePaymentLiveStatus.totalDueToday;
    const legacy = calculatePaymentOnBalance(
      effectiveStart,
      parsedPayment,
      activePaymentCredit.interestRate
    );
    return {
      mode: 'pre_added' as const,
      ...legacy,
      totalDueToday: effectiveStart,
      daysElapsed: activePaymentLiveStatus.daysElapsed,
      accruedInterest: activePaymentLiveStatus.accruedInterest,
    };
  }, [activePaymentCredit, activePaymentLiveStatus, parsedPayment]);

  const formatDateTime = (ts: unknown): string => {
    if (ts && typeof ts === 'object' && 'toDate' in ts) {
      return (ts as { toDate: () => Date }).toDate().toLocaleString('es-NI', {
        dateStyle: 'short',
        timeStyle: 'short',
      });
    }
    return new Date().toLocaleString('es-NI', { dateStyle: 'short', timeStyle: 'short' });
  };

  const resolveClientPortalCredentials = async (
    batch: WriteBatch
  ): Promise<{ portalCode: string; portalKey: string }> => {
    const portalCode = client.portalCode || generatePortalCode();
    const portalKey =
      client.portalKey || (await computePortalKey(client.phone, portalCode));
    if (client.portalCode !== portalCode || client.portalKey !== portalKey) {
      batch.update(doc(db, 'clients', client.id), {
        portalCode,
        portalKey,
        updatedAt: serverTimestamp(),
      });
    }
    return { portalCode, portalKey };
  };

  const handleCreateCredit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');
    setStatusMessage('');

    if (parsedPrincipal <= 0) {
      setErrorMessage('Ingresa una cantidad válida mayor que 0.');
      return;
    }
    if (interestRate === '' || !Number.isFinite(interestRate) || interestRate <= 0) {
      setErrorMessage('Selecciona el porcentaje (%) antes de guardar el crédito.');
      return;
    }

    setSubmitting(true);
    try {
      const creditId = generateDocId('cr');
      const txId = generateDocId('tx');
      const batch = writeBatch(db);
      const { portalCode, portalKey } = await resolveClientPortalCredentials(batch);

      const safePrincipal = round2(parsedPrincipal);
      const projectedInterest30 = calculateInterestCeil(safePrincipal, interestRate);

      const newCreditData: Credit = {
        id: creditId,
        clientId: client.id,
        clientName: client.name,
        moduleId: 'credit_cash',
        currency,
        principal: safePrincipal,
        interestRate,
        initialTotal: computedCreditTotal,
        currentBalance: safePrincipal,
        status: 'active',
        interestMode: 'prorated_daily',
        lastPaymentAt: serverTimestamp(),
        orgId: ORG_ID,
        createdBy: currentUserId,
        createdByName: currentUserName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      const newTxData: CreditTransaction = {
        id: txId,
        creditId,
        clientId: client.id,
        moduleId: 'credit_cash',
        type: 'credit',
        currency,
        amount: safePrincipal,
        interestRate,
        previousBalance: 0,
        newBalance: safePrincipal,
        note: `Ref. 30 días (${interestRate}%): ${formatCurrency(computedCreditTotal, currency)}`,
        orgId: ORG_ID,
        createdBy: currentUserId,
        createdByName: currentUserName,
        createdAt: serverTimestamp(),
      };

      batch.set(doc(db, 'credits', creditId), newCreditData);
      batch.set(doc(db, 'transactions', txId), newTxData);

      const nextCreditNumber = allCreditsSorted.length + 1;
      const nextCreditLabel = `Credit Cash N°${nextCreditNumber}`;

      attachPortalSnapshotToBatch(
        batch,
        portalKey,
        client.id,
        client.name,
        [...credits, { ...newCreditData, createdAt: Date.now() }],
        [{ ...newTxData, createdAt: Date.now() }, ...transactions],
        client.portfolioStatus || 'active'
      );

      await Promise.race([
        batch.commit(),
        new Promise<void>((resolve) => setTimeout(resolve, 1200)),
      ]);

      const invoice: InvoicePayload = {
        kind: 'credit',
        clientName: client.name,
        clientPhone: client.phone,
        currency,
        amount: safePrincipal,
        interestRate,
        previousBalance: 0,
        newBalance: safePrincipal,
        interestMode: 'prorated_daily',
        projected30DayInterest: projectedInterest30,
        projected30DayTotal: computedCreditTotal,
        creditLabel: nextCreditLabel,
        portalUrl: getPublicPortalUrl(),
        portalCode,
        attendedBy: currentUserName,
        dateLabel: new Date().toLocaleString('es-NI', { dateStyle: 'short', timeStyle: 'short' }),
        referenceId: creditId,
      };

      setPrincipalInput('');
      setInterestRate('');
      setAction('menu');
      onTriggerInvoice(invoice);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setErrorMessage(`No se pudo guardar el crédito: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegisterPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');
    setStatusMessage('');

    if (!activePaymentCredit || !paymentPreview || !activePaymentLiveStatus) {
      setErrorMessage(
        activeCredits.length > 1
          ? 'Selecciona obligatoriamente el crédito al que deseas aplicar el abono.'
          : 'Este cliente no tiene créditos activos pendientes.'
      );
      return;
    }
    if (parsedPayment <= 0) {
      setErrorMessage('Ingresa un monto de pago mayor que 0.');
      return;
    }
    if (!paymentMethod) {
      setErrorMessage('Selecciona obligatoriamente si el pago fue en Cash o Bank.');
      return;
    }
    const maxPayableToday = activePaymentLiveStatus.totalDueToday;
    if (parsedPayment > maxPayableToday) {
      setErrorMessage(
        `El pago no puede superar el total exigible hoy (${formatCurrency(maxPayableToday, activePaymentCredit.currency)}).`
      );
      return;
    }

    setSubmitting(true);
    try {
      const txId = generateDocId('tx');
      const batch = writeBatch(db);
      const { portalCode, portalKey } = await resolveClientPortalCredentials(batch);
      const creditRef = doc(db, 'credits', activePaymentCredit.id);
      const nextStatus: 'active' | 'settled' = paymentPreview.settled ? 'settled' : 'active';
      const nowServer = serverTimestamp();

      batch.update(creditRef, {
        currentBalance: paymentPreview.newBalance,
        status: nextStatus,
        ...(activePaymentLiveStatus.isFrozen ? { frozenAccruedInterest: 0 } : {}),
        lastPaymentAt: nowServer,
        updatedAt: nowServer,
      });

      const isProrated = paymentPreview.mode === 'prorated_daily';
      const newTxData: CreditTransaction = {
        id: txId,
        creditId: activePaymentCredit.id,
        clientId: client.id,
        moduleId: 'credit_cash',
        type: 'payment',
        currency: activePaymentCredit.currency,
        amount: round2(parsedPayment),
        interestRate: activePaymentCredit.interestRate,
        previousBalance: activePaymentCredit.currentBalance,
        newBalance: paymentPreview.newBalance,
        paymentMethod,
        note: paymentPreview.settled
          ? activePaymentLiveStatus.isFrozen
            ? 'Liquidación total en Cartera Castigada'
            : isProrated
              ? `Liquidación total al día ${paymentPreview.daysElapsed} (+${formatCurrency(paymentPreview.accruedInterest, activePaymentCredit.currency)} int.)`
              : 'Abono final — Crédito liquidado'
          : activePaymentLiveStatus.isFrozen
            ? 'Abono sobre saldo congelado (Cartera Castigada)'
            : isProrated
              ? `Abono día ${paymentPreview.daysElapsed} (+${formatCurrency(paymentPreview.accruedInterest, activePaymentCredit.currency)} int.)`
              : `Abono sobre saldo (+${activePaymentCredit.interestRate}% s/restante)`,
        orgId: ORG_ID,
        createdBy: currentUserId,
        createdByName: currentUserName,
        createdAt: nowServer,
      };

      batch.set(doc(db, 'transactions', txId), newTxData);

      const nowLocalMs = Date.now();
      const updatedCredits = credits.map((cr) =>
        cr.id === activePaymentCredit.id
          ? {
              ...cr,
              currentBalance: paymentPreview.newBalance,
              status: nextStatus,
              ...(activePaymentLiveStatus.isFrozen ? { frozenAccruedInterest: 0 } : {}),
              lastPaymentAt: nowLocalMs,
            }
          : cr
      );
      attachPortalSnapshotToBatch(
        batch,
        portalKey,
        client.id,
        client.name,
        updatedCredits,
        [{ ...newTxData, createdAt: nowLocalMs }, ...transactions],
        client.portfolioStatus || 'active'
      );

      await Promise.race([
        batch.commit(),
        new Promise<void>((resolve) => setTimeout(resolve, 1200)),
      ]);

      const invoice: InvoicePayload = {
        kind: 'payment',
        moduleLabel: 'Credit Cash',
        clientName: client.name,
        clientPhone: client.phone,
        currency: activePaymentCredit.currency,
        amount: round2(parsedPayment),
        interestRate: activePaymentCredit.interestRate,
        previousBalance: activePaymentCredit.currentBalance,
        remainingBeforeInterest:
          paymentPreview.mode === 'pre_added' ? paymentPreview.remainingBeforeInterest : undefined,
        interestAdded:
          paymentPreview.mode === 'pre_added' ? paymentPreview.interestAdded : undefined,
        daysElapsed: paymentPreview.daysElapsed,
        accruedInterest: paymentPreview.accruedInterest,
        totalDueToday: paymentPreview.totalDueToday,
        interestMode: activePaymentCredit.interestMode || 'pre_added',
        newBalance: paymentPreview.newBalance,
        creditLabel: creditLabelById.get(activePaymentCredit.id),
        paymentMethod,
        portalUrl: getPublicPortalUrl(),
        portalCode,
        attendedBy: currentUserName,
        dateLabel: new Date().toLocaleString('es-NI', { dateStyle: 'short', timeStyle: 'short' }),
        referenceId: txId,
      };

      setPaymentInput('');
      setPaymentMethod('');
      setSelectedCreditId('');
      setAction('menu');
      onTriggerInvoice(invoice);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setErrorMessage(`No se pudo registrar el pago: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleModifyRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');
    setStatusMessage('');

    const targetCredit = credits.find((c) => c.id === modifyCreditId) || credits[0];
    if (!targetCredit) {
      setErrorMessage('Selecciona un crédito válido para modificar.');
      return;
    }

    const newVal = Number(modifyNewValue);
    if (!Number.isFinite(newVal) || newVal < 0) {
      setErrorMessage('Ingresa una cantidad válida.');
      return;
    }
    if (!isAdmin && !modifyReason.trim()) {
      setErrorMessage('Describe brevemente el motivo de la corrección para el administrador.');
      return;
    }

    const selectedTx = transactions.find((t) => t.id === modifyTxId);
    const oldVal =
      modifyTargetType === 'transaction' && selectedTx ? selectedTx.amount : targetCredit.principal;

    setSubmitting(true);
    try {
      const batch = writeBatch(db);

      if (isAdmin) {
        // Admin applies correction directly
        const creditRef = doc(db, 'credits', targetCredit.id);
        let newBalance = targetCredit.currentBalance;
        let updatedCredits = [...credits];
        let updatedTxs = [...transactions];
        const { portalKey } = await resolveClientPortalCredentials(batch);

        if (modifyTargetType === 'credit') {
          const newInitialTotal = calculateInitialCreditTotal(newVal, modifyNewRate);
          if (targetCredit.interestMode === 'prorated_daily') {
            const deltaPrincipal = round2(newVal - targetCredit.principal);
            newBalance = round2(Math.max(0, targetCredit.currentBalance + deltaPrincipal));
          } else {
            const delta = round2(newInitialTotal - targetCredit.initialTotal);
            newBalance = round2(Math.max(0, targetCredit.currentBalance + delta));
          }
          const nextStatus: 'active' | 'settled' = newBalance <= 0 ? 'settled' : 'active';

          batch.update(creditRef, {
            principal: round2(newVal),
            interestRate: modifyNewRate,
            initialTotal: newInitialTotal,
            currentBalance: newBalance,
            status: nextStatus,
            updatedAt: serverTimestamp(),
          });

          updatedCredits = updatedCredits.map((c) =>
            c.id === targetCredit.id
              ? {
                  ...c,
                  principal: round2(newVal),
                  interestRate: modifyNewRate,
                  initialTotal: newInitialTotal,
                  currentBalance: newBalance,
                  status: nextStatus,
                }
              : c
          );
        } else if (selectedTx) {
          const diff = round2(newVal - selectedTx.amount);
          newBalance = round2(Math.max(0, targetCredit.currentBalance - diff));
          const nextStatus: 'active' | 'settled' = newBalance <= 0 ? 'settled' : 'active';
          const updatedNote = modifyReason.trim() || `Editado por Admin (${currentUserName})`;

          batch.update(doc(db, 'transactions', selectedTx.id), {
            amount: round2(newVal),
            interestRate: modifyNewRate,
            newBalance,
            note: updatedNote,
          });

          batch.update(creditRef, {
            interestRate: modifyNewRate,
            currentBalance: newBalance,
            status: nextStatus,
            updatedAt: serverTimestamp(),
          });

          updatedTxs = updatedTxs.map((t) =>
            t.id === selectedTx.id
              ? { ...t, amount: round2(newVal), interestRate: modifyNewRate, newBalance, note: updatedNote }
              : t
          );
          updatedCredits = updatedCredits.map((c) =>
            c.id === targetCredit.id
              ? { ...c, interestRate: modifyNewRate, currentBalance: newBalance, status: nextStatus }
              : c
          );
        }

        const adjId = generateDocId('tx');
        const adjTx: CreditTransaction = {
          id: adjId,
          creditId: targetCredit.id,
          clientId: client.id,
          type: 'adjustment',
          currency: targetCredit.currency,
          amount: round2(newVal),
          interestRate: modifyNewRate,
          previousBalance: targetCredit.currentBalance,
          newBalance,
          note: modifyReason.trim() || `Ajuste directo por Admin (${currentUserName})`,
          orgId: ORG_ID,
          createdBy: currentUserId,
          createdByName: currentUserName,
          createdAt: serverTimestamp(),
        };
        batch.set(doc(db, 'transactions', adjId), adjTx);

        attachPortalSnapshotToBatch(
          batch,
          portalKey,
          client.id,
          client.name,
          updatedCredits,
          [adjTx, ...updatedTxs],
          client.portfolioStatus || 'active'
        );

        await Promise.race([
          batch.commit(),
          new Promise<void>((resolve) => setTimeout(resolve, 1200)),
        ]);
        setStatusMessage('Registro corregido directamente por Administrador.');
      } else {
        // Employee sends approval request to Admin in real time
        const reqId = generateDocId('req');
        batch.set(doc(db, 'modificationRequests', reqId), {
          id: reqId,
          targetType: modifyTargetType,
          creditId: targetCredit.id,
          transactionId: modifyTargetType === 'transaction' ? selectedTx?.id || '' : '',
          clientId: client.id,
          clientName: client.name,
          currency: targetCredit.currency,
          oldValue: round2(oldVal),
          newValue: round2(newVal),
          oldInterestRate: targetCredit.interestRate,
          newInterestRate: modifyNewRate,
          reason: modifyReason.trim().slice(0, 240),
          status: 'pending',
          orgId: ORG_ID,
          requestedBy: currentUserId,
          requestedByName: currentUserName,
          reviewedBy: '',
          reviewedByName: '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        await Promise.race([
          batch.commit(),
          new Promise<void>((resolve) => setTimeout(resolve, 1200)),
        ]);
        setStatusMessage(
          'Solicitud enviada al Administrador. Recibirás actualización en cuanto la apruebe o corrija.'
        );
      }

      setModifyNewValue('');
      setModifyReason('');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setErrorMessage(`No se pudo procesar la modificación: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  const buildCreditInvoicePayload = (credit: Credit, index: number): InvoicePayload => {
    const creditTxs = transactions
      .filter((t) => t.creditId === credit.id)
      .sort((a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt));

    const latestTx = creditTxs[0];
    const creditLabel =
      creditLabelById.get(credit.id) || `Credit Cash N°${index + 1}`;
    const live = liveStatusByCreditId.get(credit.id) || calculateLiveCreditStatus(credit, transactions);

    if (latestTx && latestTx.type === 'payment') {
      if (credit.interestMode === 'prorated_daily') {
        const impliedTotalDay = round2(latestTx.previousBalance);
        return {
          kind: 'payment',
          clientName: client.name,
          clientPhone: client.phone,
          currency: credit.currency,
          amount: latestTx.amount,
          interestRate: latestTx.interestRate,
          previousBalance: latestTx.previousBalance,
          daysElapsed: 0,
          accruedInterest: 0,
          totalDueToday: impliedTotalDay,
          interestMode: 'prorated_daily',
          newBalance: credit.currentBalance,
          creditLabel,
          portalUrl: getPublicPortalUrl(),
          portalCode: client.portalCode,
          attendedBy: latestTx.createdByName || currentUserName,
          dateLabel: formatDateTime(latestTx.createdAt),
          referenceId: latestTx.id,
        };
      }

      const breakdown = calculatePaymentOnBalance(
        latestTx.previousBalance,
        latestTx.amount,
        latestTx.interestRate
      );
      return {
        kind: 'payment',
        clientName: client.name,
        clientPhone: client.phone,
        currency: credit.currency,
        amount: latestTx.amount,
        interestRate: latestTx.interestRate,
        previousBalance: latestTx.previousBalance,
        remainingBeforeInterest: breakdown.remainingBeforeInterest,
        interestAdded: breakdown.interestAdded,
        interestMode: credit.interestMode || 'pre_added',
        newBalance: credit.currentBalance,
        creditLabel,
        portalUrl: getPublicPortalUrl(),
        portalCode: client.portalCode,
        attendedBy: latestTx.createdByName || currentUserName,
        dateLabel: formatDateTime(latestTx.createdAt),
        referenceId: latestTx.id,
      };
    }

    return {
      kind: 'credit',
      clientName: client.name,
      clientPhone: client.phone,
      currency: credit.currency,
      amount: credit.principal,
      interestRate: credit.interestRate,
      previousBalance: 0,
      newBalance: live.totalDueToday,
      interestMode: credit.interestMode || 'pre_added',
      projected30DayInterest: live.projected30DayInterest,
      projected30DayTotal: live.projected30DayTotal,
      creditLabel,
      portalUrl: getPublicPortalUrl(),
      portalCode: client.portalCode,
      attendedBy: credit.createdByName || currentUserName,
      dateLabel: formatDateTime(credit.createdAt),
      referenceId: credit.id,
    };
  };

  const buildConsolidatedInvoicePayload = (): InvoicePayload => {
    const consolidatedItems: ConsolidatedCreditItem[] = activeCredits.map((cr, idx) => {
      const live = liveStatusByCreditId.get(cr.id) || calculateLiveCreditStatus(cr, transactions);
      return {
        label: creditLabelById.get(cr.id) || `Credit Cash N°${idx + 1}`,
        currency: cr.currency,
        principal: cr.principal,
        interestRate: cr.interestRate,
        currentBalance: live.totalDueToday,
        daysElapsed: live.daysElapsed,
        accruedInterest: live.accruedInterest,
        dateLabel: formatDateTime(cr.createdAt),
      };
    });

    return {
      kind: 'consolidated',
      clientName: client.name,
      clientPhone: client.phone,
      currency: totalsByCurrency.nio > 0 ? 'NIO' : 'USD',
      amount: 0,
      interestRate: 0,
      previousBalance: 0,
      newBalance: 0,
      consolidatedItems,
      totalNio: totalsByCurrency.nio,
      totalUsd: totalsByCurrency.usd,
      portalUrl: getPublicPortalUrl(),
      portalCode: client.portalCode,
      attendedBy: currentUserName,
      dateLabel: new Date().toLocaleString('es-NI', { dateStyle: 'short', timeStyle: 'short' }),
      referenceId: activeCredits[0]?.id || client.id,
    };
  };

  const isAndroid = isAndroidDevice();
  const inIframe = typeof window !== 'undefined' && window.top !== window.self;
  const openInBlankTab = !isAndroid || inIframe;

  const portalPinWaLink = client.portalCode
    ? buildWhatsAppBusinessLink(
        client.phone,
        buildClientPortalAccessMessage(client.name, client.phone, client.portalCode)
      )
    : '';

  const handleCopyPortalAccess = async () => {
    if (!client.portalCode) return;
    const text = buildClientPortalAccessMessage(client.name, client.phone, client.portalCode);
    try {
      await navigator.clipboard.writeText(text);
      setPortalCopied(true);
      setTimeout(() => setPortalCopied(false), 2000);
    } catch {
      // Ignore clipboard failure
    }
  };

  const handleRegenerateCode = async () => {
    setErrorMessage('');
    setStatusMessage('');
    setRegeneratingCode(true);
    try {
      const { portalCode: nextCode } = await regenerateClientPortalCredentials(
        client,
        credits,
        transactions
      );
      setStatusMessage(`Nuevo código de portal generado (${nextCode}). El código anterior fue anulado.`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setErrorMessage(`No se pudo renovar el código del portal: ${msg}`);
    } finally {
      setRegeneratingCode(false);
    }
  };

  const handleQuickWhatsAppClick = () => {
    setErrorMessage('');
    setStatusMessage('');

    if (activeCredits.length === 0) {
      setErrorMessage('Este cliente no tiene créditos activos pendientes para enviar factura.');
      return;
    }

    if (activeCredits.length === 1) {
      onTriggerInvoice(buildCreditInvoicePayload(activeCredits[0], 0));
      return;
    }

    setWhatsappPickOpen(true);
  };

  const canMoveToCastigada =
    isAdmin && !isCastigada && activeCredits.length > 0 && maxDaysWithoutPayment >= 90;

  const handleMoveToCarteraCastigada = async () => {
    if (!canMoveToCastigada) return;
    setErrorMessage('');
    setStatusMessage('');
    setSubmitting(true);
    try {
      const batch = writeBatch(db);
      const { portalKey } = await resolveClientPortalCredentials(batch);
      const nowServer = serverTimestamp();

      batch.update(doc(db, 'clients', client.id), {
        portfolioStatus: 'castigada',
        sourceModule: client.sourceModule || 'credit_cash',
        castigadaAt: nowServer,
        castigadaBy: currentUserId,
        castigadaByName: currentUserName,
        updatedAt: nowServer,
      });

      const updatedCredits = credits.map((cr) => {
        if (cr.status !== 'active' || cr.currentBalance <= 0) return cr;
        const live = liveStatusByCreditId.get(cr.id) || calculateLiveCreditStatus(cr, transactions);
        batch.update(doc(db, 'credits', cr.id), {
          frozenDays: live.daysElapsed,
          frozenAccruedInterest: live.accruedInterest,
          frozenAt: nowServer,
          updatedAt: nowServer,
        });
        return {
          ...cr,
          frozenDays: live.daysElapsed,
          frozenAccruedInterest: live.accruedInterest,
          frozenAt: Date.now(),
        };
      });

      const primaryActive = activeCredits[0];
      const primaryLive = primaryActive ? liveStatusByCreditId.get(primaryActive.id) : undefined;
      const moveTxId = generateDocId('tx');
      const moveTxData: CreditTransaction = {
        id: moveTxId,
        creditId: primaryActive.id,
        clientId: client.id,
        type: 'adjustment',
        currency: primaryActive.currency,
        amount: 0,
        interestRate: primaryActive.interestRate,
        previousBalance: primaryLive?.baseBalance ?? primaryActive.currentBalance,
        newBalance: primaryLive?.totalDueToday ?? primaryActive.currentBalance,
        note: `Traslado a Cartera Castigada por ${currentUserName} (${maxDaysWithoutPayment} días sin abono · números congelados)`,
        orgId: ORG_ID,
        createdBy: currentUserId,
        createdByName: currentUserName,
        createdAt: nowServer,
      };
      batch.set(doc(db, 'transactions', moveTxId), moveTxData);

      attachPortalSnapshotToBatch(
        batch,
        portalKey,
        client.id,
        client.name,
        updatedCredits,
        [{ ...moveTxData, createdAt: Date.now() }, ...transactions],
        'castigada'
      );

      if (typeof navigator === 'undefined' || navigator.onLine !== false) {
        await batch.commit();
      } else {
        await Promise.race([
          batch.commit(),
          new Promise<void>((resolve) => setTimeout(resolve, 1200)),
        ]);
      }

      setCastigadaConfirmOpen(false);
      onBack();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setErrorMessage(`No se pudo mover a Cartera Castigada: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Client Header */}
      <div className="rounded-2xl bg-[#145f96] text-white p-4 sm:p-5 shadow-md">
        <div className="flex items-center gap-3 mb-3">
          <button
            type="button"
            onClick={onBack}
            className="min-h-[42px] min-w-[42px] flex items-center justify-center rounded-xl bg-white/10 hover:bg-white/20 cursor-pointer shrink-0"
            aria-label="Volver a clientes"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold truncate">{client.name}</h2>
              {isCastigada && (
                <span className="inline-flex items-center gap-1 rounded-md bg-[#d12925] px-2 py-0.5 text-[10px] font-bold text-white uppercase tracking-wide shrink-0">
                  <Snowflake className="w-3 h-3" />
                  Cartera Castigada
                </span>
              )}
            </div>
            <p className="text-xs text-white/80 font-mono">{client.phone}</p>
          </div>
          <button
            type="button"
            onClick={handleQuickWhatsAppClick}
            aria-label="Enviar factura por WhatsApp"
            title="Enviar factura por WhatsApp"
            className="min-h-[42px] min-w-[42px] flex items-center justify-center rounded-xl bg-[#25D366] hover:bg-[#1fb857] text-slate-950 shadow-sm transition-colors cursor-pointer shrink-0"
          >
            <MessageCircle className="w-5 h-5" />
          </button>
        </div>

        {/* Separated Balances in NIO (C$) and USD */}
        <div className="grid grid-cols-2 gap-2.5">
          <div className="rounded-xl bg-white/10 px-3.5 py-2.5 border border-white/15">
            <span className="text-[11px] text-white/75 block">
              {isCastigada ? 'Saldo congelado (C$)' : 'Total exigible (C$)'}
            </span>
            <span className="text-base font-bold font-mono tabular-nums text-[#a1d63e]">
              {formatCurrency(totalsByCurrency.nio, 'NIO')}
            </span>
          </div>
          <div className="rounded-xl bg-white/10 px-3.5 py-2.5 border border-white/15">
            <span className="text-[11px] text-white/75 block">
              {isCastigada ? 'Saldo congelado (USD)' : 'Total exigible (USD)'}
            </span>
            <span className="text-base font-bold font-mono tabular-nums text-[#69b8e9]">
              {formatCurrency(totalsByCurrency.usd, 'USD')}
            </span>
          </div>
        </div>

        {/* Aging indicator when client has active debt */}
        {activeCredits.length > 0 && (() => {
          const headerTier = getPortalAgingTier(maxDaysWithoutPayment);
          const dotColor = isCastigada
            ? 'bg-[#69b8e9]'
            : headerTier === 'red'
              ? 'bg-[#d12925]'
              : headerTier === 'orange'
                ? 'bg-[#df7729]'
                : 'bg-[#a1d63e]';
          const textColor = isCastigada
            ? 'text-[#69b8e9]'
            : headerTier === 'red'
              ? 'text-[#fca5a5]'
              : headerTier === 'orange'
                ? 'text-[#fdba74]'
                : 'text-[#a1d63e]';
          const label = isCastigada
            ? `Números congelados (${maxDaysWithoutPayment} días sin abono · no corre interés)`
            : maxDaysWithoutPayment >= 30
              ? `Alerta: ${maxDaysWithoutPayment} días sin abono o pago`
              : maxDaysWithoutPayment >= 20
                ? `Atención: ${maxDaysWithoutPayment} días sin abono`
                : `Al día: ${maxDaysWithoutPayment} día${maxDaysWithoutPayment === 1 ? '' : 's'} desde último movimiento`;

          return (
            <div className="mt-2.5 rounded-xl bg-white/10 px-3.5 py-2 border border-white/15 flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotColor}`} />
                <span className={`font-bold truncate ${textColor}`}>{label}</span>
              </div>
              <span className="text-[11px] text-white/75 shrink-0 font-mono tabular-nums">
                {activeCredits.length} crédito(s)
              </span>
            </div>
          );
        })()}

        {/* Client Portal 6-digit Secret Code Strip */}
        <div className="mt-2.5 rounded-xl bg-white/10 px-3.5 py-2.5 border border-white/15 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <KeyRound className="w-3.5 h-3.5 text-[#a1d63e] shrink-0" />
            <span className="text-white/80 whitespace-nowrap">PIN portal:</span>
            <span className="font-mono font-bold tracking-wider text-[#a1d63e] tabular-nums">
              {client.portalCode || 'Generando...'}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {client.portalCode && (
              <>
                <a
                  href={portalPinWaLink}
                  target={openInBlankTab ? '_blank' : undefined}
                  rel={openInBlankTab ? 'noopener noreferrer' : undefined}
                  title="Enviar PIN de acceso por WhatsApp Business"
                  className="min-h-[36px] px-2.5 rounded-lg bg-[#25D366] hover:bg-[#1fb857] text-slate-950 font-bold flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 shadow-sm"
                >
                  <MessageCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>Enviar PIN</span>
                </a>
                <button
                  type="button"
                  onClick={handleCopyPortalAccess}
                  className="min-h-[36px] px-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white font-semibold flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
                  title="Copiar enlace y PIN del cliente"
                >
                  {portalCopied ? (
                    <Check className="w-3.5 h-3.5 text-[#a1d63e]" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  <span>{portalCopied ? 'Copiado' : 'Copiar'}</span>
                </button>
              </>
            )}
            <button
              type="button"
              disabled={regeneratingCode}
              onClick={handleRegenerateCode}
              title="Generar nuevo PIN secreto (anula el anterior)"
              className="min-h-[36px] px-2.5 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-50 text-white font-semibold flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${regeneratingCode ? 'animate-spin' : ''}`} />
              <span>Cambiar</span>
            </button>
          </div>
        </div>
      </div>

      {statusMessage && (
        <div className="rounded-xl bg-[#a1d63e]/15 border border-[#a1d63e]/50 px-4 py-3 text-xs font-semibold text-slate-900 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-[#4d7c0f] shrink-0" />
          <span>{statusMessage}</span>
        </div>
      )}

      {errorMessage && (
        <div className="rounded-xl bg-[#d12925]/10 border border-[#d12925]/30 px-4 py-3 text-xs font-semibold text-[#b91c1c]">
          {errorMessage}
        </div>
      )}

      {/* Admin-only 90+ days button: Move to Cartera Castigada */}
      {canMoveToCastigada && (
        <button
          type="button"
          onClick={() => {
            setErrorMessage('');
            setStatusMessage('');
            setCastigadaConfirmOpen(true);
          }}
          className="w-full rounded-2xl bg-[#d12925]/10 hover:bg-[#d12925]/15 border-2 border-[#d12925]/40 px-4 py-3 flex items-center justify-between gap-3 text-left transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-[#d12925] text-white flex items-center justify-center shrink-0 shadow-sm">
              <Archive className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-[#d12925]">
                Mover a Cartera Castigada ({maxDaysWithoutPayment} días sin abono)
              </p>
              <p className="text-[11px] text-slate-600">
                Solo Administrador · Congela los saldos actuales y retira de Credit Cash activo
              </p>
            </div>
          </div>
          <Snowflake className="w-4 h-4 text-[#d12925] shrink-0" />
        </button>
      )}

      {/* 3-Option Menu when tapping a client */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        <button
          type="button"
          onClick={() => {
            setErrorMessage('');
            setStatusMessage('');
            setInterestRate('');
            setAction('add_credit');
          }}
          className={`min-h-[54px] rounded-xl px-4 py-3 text-left flex items-center gap-3 border-2 transition-all cursor-pointer ${
            action === 'add_credit'
              ? 'bg-[#145f96] text-white border-[#145f96] shadow-md'
              : 'bg-white text-slate-900 border-slate-200 hover:border-[#a1d63e]'
          }`}
        >
          <CreditCard
            className={`w-5 h-5 shrink-0 ${
              action === 'add_credit' ? 'text-[#a1d63e]' : 'text-[#145f96]'
            }`}
          />
          <span className="text-sm font-bold">Registrar Crédito</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setErrorMessage('');
            setStatusMessage('');
            setPaymentMethod('');
            setSelectedCreditId(activeCredits.length === 1 ? activeCredits[0].id : '');
            setAction('register_payment');
          }}
          className={`min-h-[54px] rounded-xl px-4 py-3 text-left flex items-center gap-3 border-2 transition-all cursor-pointer ${
            action === 'register_payment'
              ? 'bg-[#df7729] text-white border-[#df7729] shadow-md'
              : 'bg-white text-slate-900 border-slate-200 hover:border-[#df7729]'
          }`}
        >
          <BadgeDollarSign
            className={`w-5 h-5 shrink-0 ${
              action === 'register_payment' ? 'text-white' : 'text-[#df7729]'
            }`}
          />
          <span className="text-sm font-bold">Registrar Pago</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setErrorMessage('');
            setStatusMessage('');
            if (credits.length > 0 && !modifyCreditId) {
              setModifyCreditId(credits[0].id);
            }
            setAction('modify_records');
          }}
          className={`min-h-[54px] rounded-xl px-4 py-3 text-left flex items-center gap-3 border-2 transition-all cursor-pointer ${
            action === 'modify_records'
              ? 'bg-[#69b8e9] text-slate-950 border-[#69b8e9] shadow-md'
              : 'bg-white text-slate-900 border-slate-200 hover:border-[#69b8e9]'
          }`}
        >
          <FileEdit
            className={`w-5 h-5 shrink-0 ${
              action === 'modify_records' ? 'text-slate-950' : 'text-[#69b8e9]'
            }`}
          />
          <span className="text-sm font-bold">Modificar Registros</span>
        </button>
      </div>

      {/* PANEL 1: REGISTRAR CRÉDITO (Moneda + 3 columnas horizontales: Cantidad | % | Total) */}
      {action === 'add_credit' && (
        <form
          onSubmit={handleCreateCredit}
          className="rounded-2xl bg-white border border-slate-200 shadow-sm p-4 sm:p-5 space-y-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-[#145f96]">Agregar Crédito</h3>
            {/* Moneda selector: Córdobas C$ o Dollars USD */}
            <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100">
              <button
                type="button"
                onClick={() => setCurrency('NIO')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                  currency === 'NIO'
                    ? 'bg-[#145f96] text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Córdobas (C$)
              </button>
              <button
                type="button"
                onClick={() => setCurrency('USD')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                  currency === 'USD'
                    ? 'bg-[#145f96] text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Dólares (USD)
              </button>
            </div>
          </div>

          {/* 3 horizontal columns: Cantidad | % | Total */}
          <div className="grid grid-cols-3 gap-2 sm:gap-3 items-end">
            <div>
              <label
                htmlFor="credit-amount"
                className="block text-xs font-bold text-slate-700 mb-1"
              >
                Cantidad
              </label>
              <input
                id="credit-amount"
                type="number"
                step="0.01"
                min="1"
                inputMode="decimal"
                value={principalInput}
                onChange={(e) => setPrincipalInput(e.target.value)}
                placeholder="0.00"
                className="w-full min-h-[46px] rounded-xl border-2 border-[#145f96]/25 px-2.5 sm:px-3 text-sm font-mono font-bold text-slate-900 tabular-nums focus:border-[#69b8e9] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="credit-rate"
                className="block text-xs font-bold text-slate-700 mb-1 text-center"
              >
                %
              </label>
              <select
                id="credit-rate"
                value={interestRate}
                onChange={(e) => {
                  setErrorMessage('');
                  setInterestRate(e.target.value === '' ? '' : Number(e.target.value));
                }}
                className="w-full min-h-[46px] rounded-xl border-2 border-[#145f96]/25 bg-white px-2 text-sm font-mono font-bold text-[#145f96] text-center focus:border-[#df7729] focus:outline-none cursor-pointer"
              >
                <option value="" disabled>
                  Elige %
                </option>
                {INTEREST_RATE_OPTIONS.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate}%
                  </option>
                ))}
              </select>
            </div>

            <div>
              <span className="block text-xs font-bold text-slate-700 mb-1 text-right">
                Ref. 30 días
              </span>
              <div className="min-h-[46px] rounded-xl bg-slate-100 border border-slate-200 px-2.5 flex items-center justify-end font-mono text-xs sm:text-sm font-bold text-[#145f96] tabular-nums">
                {formatCurrency(computedCreditTotal, currency)}
              </div>
            </div>
          </div>

          {parsedPrincipal > 0 && interestRate !== '' && (
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-3.5 py-2.5 text-xs space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Capital inicial hoy (Día 0):</span>
                <span className="font-mono font-bold text-[#145f96] tabular-nums">
                  {formatCurrency(parsedPrincipal, currency)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Interés ref. 30 días ({interestRate}%):</span>
                <span className="font-mono font-bold text-[#df7729] tabular-nums">
                  + {formatCurrency(calculateInterestCeil(parsedPrincipal, interestRate), currency)}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 pt-1 border-t border-slate-200/80">
                Cobro 100% sobre saldo del capital proporcional al día exacto de pago (base 30 días, redondeo al superior).
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full min-h-[48px] rounded-xl bg-[#a1d63e] hover:bg-[#8ec22f] disabled:opacity-60 text-slate-950 font-bold text-sm shadow-sm transition-colors cursor-pointer"
          >
            {submitting ? 'Guardando crédito...' : 'Guardar Crédito y Enviar Factura'}
          </button>
        </form>
      )}

      {/* PANEL 2: REGISTRAR PAGO (Columnas Cantidad y Saldo + Crédito sobre saldo) */}
      {action === 'register_payment' && (
        <form
          onSubmit={handleRegisterPayment}
          className="rounded-2xl bg-white border border-slate-200 shadow-sm p-4 sm:p-5 space-y-4"
        >
          <h3 className="text-sm font-bold text-[#145f96]">Registrar Pago (Sobre Saldo)</h3>

          {activeCredits.length === 0 ? (
            <p className="text-sm text-slate-500 py-4">
              Este cliente no tiene créditos activos pendientes por pagar.
            </p>
          ) : (
            <>
              {activeCredits.length > 1 && (
                <div>
                  <label
                    htmlFor="select-active-credit"
                    className="block text-xs font-bold text-slate-600 mb-1"
                  >
                    Selecciona el crédito a abonar
                  </label>
                  <select
                    id="select-active-credit"
                    value={selectedCreditId}
                    onChange={(e) => {
                      setErrorMessage('');
                      setSelectedCreditId(e.target.value);
                    }}
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-900"
                  >
                    <option value="" disabled>
                      Selecciona el crédito a abonar...
                    </option>
                    {activeCredits.map((c, idx) => {
                      const live = liveStatusByCreditId.get(c.id);
                      const dueToday = live ? live.totalDueToday : c.currentBalance;
                      const days = live ? live.daysElapsed : 0;
                      const label = creditLabelById.get(c.id) || `Credit Cash N°${idx + 1}`;
                      return (
                        <option key={c.id} value={c.id}>
                          {label} · Hoy: {formatCurrency(dueToday, c.currency)} (Cap:{' '}
                          {formatCurrency(c.currentBalance, c.currency)} · {days}d · {c.interestRate}%)
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}

              {/* Horizontal Cantidad & Total Exigible Hoy + Live Prorated Breakdown */}
              {activePaymentCredit && activePaymentLiveStatus && (
                <>
                  <div className="rounded-xl bg-slate-50 border border-slate-200 p-3.5 text-xs space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Capital pendiente:</span>
                      <span className="font-mono font-semibold text-slate-800 tabular-nums">
                        {formatCurrency(activePaymentLiveStatus.baseBalance, activePaymentCredit.currency)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Días transcurridos sin abono:</span>
                      <span
                        className={`font-mono font-bold tabular-nums ${
                          activePaymentLiveStatus.daysElapsed >= 30
                            ? 'text-[#d12925]'
                            : activePaymentLiveStatus.daysElapsed >= 20
                              ? 'text-[#df7729]'
                              : 'text-[#4d7c0f]'
                        }`}
                      >
                        {activePaymentLiveStatus.daysElapsed} día
                        {activePaymentLiveStatus.daysElapsed === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">
                        Interés proporcional ({activePaymentCredit.interestRate}%):
                      </span>
                      <span className="font-mono font-bold text-[#df7729] tabular-nums">
                        + {formatCurrency(activePaymentLiveStatus.accruedInterest, activePaymentCredit.currency)}
                      </span>
                    </div>
                    <div className="border-t border-slate-200 pt-1.5 flex items-center justify-between text-sm font-bold text-[#145f96]">
                      <span>Total exigible hoy:</span>
                      <span className="font-mono tabular-nums">
                        {formatCurrency(activePaymentLiveStatus.totalDueToday, activePaymentCredit.currency)}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 items-end">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label
                          htmlFor="payment-amount"
                          className="block text-xs font-bold text-slate-700"
                        >
                          Cantidad (Abono)
                        </label>
                        <button
                          type="button"
                          onClick={() => setPaymentInput(String(activePaymentLiveStatus.totalDueToday))}
                          className="text-[11px] font-bold text-[#145f96] hover:text-[#df7729] underline cursor-pointer whitespace-nowrap"
                        >
                          Liquidar hoy
                        </button>
                      </div>
                      <input
                        id="payment-amount"
                        type="number"
                        step="0.01"
                        min="0.01"
                        inputMode="decimal"
                        value={paymentInput}
                        onChange={(e) => setPaymentInput(e.target.value)}
                        placeholder="0.00"
                        className="w-full min-h-[46px] rounded-xl border-2 border-[#df7729]/40 px-3 text-sm font-mono font-bold text-slate-900 tabular-nums focus:border-[#df7729] focus:outline-none"
                      />
                    </div>

                    <div>
                      <span className="block text-xs font-bold text-slate-700 mb-1 text-right">
                        Total Exigible Hoy
                      </span>
                      <div className="min-h-[46px] rounded-xl bg-slate-100 border border-slate-200 px-3 flex items-center justify-end font-mono text-sm font-bold text-[#145f96] tabular-nums">
                        {formatCurrency(activePaymentLiveStatus.totalDueToday, activePaymentCredit.currency)}
                      </div>
                    </div>
                  </div>

                  {/* Mandatory Cash / Bank selector for accounting & Caja */}
                  <div>
                    <span className="block text-xs font-bold text-slate-700 mb-1.5">
                      Método de recepción (Obligatorio)
                    </span>
                    <div className="grid grid-cols-2 gap-2.5">
                      <button
                        type="button"
                        onClick={() => {
                          setErrorMessage('');
                          setPaymentMethod('cash');
                        }}
                        className={`min-h-[46px] rounded-xl border-2 px-3 py-2 flex items-center justify-center gap-2 text-sm font-bold transition-all cursor-pointer ${
                          paymentMethod === 'cash'
                            ? 'bg-[#a1d63e] border-[#4d7c0f] text-slate-950 shadow-sm'
                            : 'bg-white border-slate-200 text-slate-700 hover:border-[#a1d63e]'
                        }`}
                      >
                        <Banknote className="w-4 h-4 shrink-0" />
                        <span>Cash</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setErrorMessage('');
                          setPaymentMethod('bank');
                        }}
                        className={`min-h-[46px] rounded-xl border-2 px-3 py-2 flex items-center justify-center gap-2 text-sm font-bold transition-all cursor-pointer ${
                          paymentMethod === 'bank'
                            ? 'bg-[#145f96] border-[#145f96] text-white shadow-sm'
                            : 'bg-white border-slate-200 text-slate-700 hover:border-[#69b8e9]'
                        }`}
                      >
                        <Building2 className="w-4 h-4 shrink-0" />
                        <span>Bank</span>
                      </button>
                    </div>
                  </div>

                  {/* Live calculation preview */}
                  {paymentPreview && parsedPayment > 0 && (
                    <div className="rounded-xl bg-slate-50 border border-slate-200 p-3.5 text-xs space-y-1.5">
                      {paymentPreview.mode === 'prorated_daily' ? (
                        <>
                          <div className="flex justify-between">
                            <span className="text-slate-500">
                              Total exigible al día {paymentPreview.daysElapsed}:
                            </span>
                            <span className="font-mono font-semibold tabular-nums">
                              {formatCurrency(paymentPreview.totalDueToday, activePaymentCredit.currency)}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-500">Abono aplicado hoy:</span>
                            <span className="font-mono font-bold text-[#4d7c0f] tabular-nums">
                              - {formatCurrency(parsedPayment, activePaymentCredit.currency)}
                            </span>
                          </div>
                          <div className="border-t border-slate-200 pt-1.5 flex justify-between text-sm font-bold text-[#145f96]">
                            <span>Nuevo saldo capital:</span>
                            <span className="font-mono tabular-nums">
                              {formatCurrency(paymentPreview.newBalance, activePaymentCredit.currency)}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-500">
                            {paymentPreview.settled
                              ? 'Crédito liquidado al 100% hoy.'
                              : activePaymentLiveStatus.isFrozen
                                ? 'Al guardar, el saldo restante continúa congelado sin generar nuevos intereses.'
                                : 'Al guardar, el contador de días vuelve a 0 desde hoy.'}
                          </p>
                        </>
                      ) : (
                        <>
                          <div className="flex justify-between">
                            <span className="text-slate-500">Restante tras abono:</span>
                            <span className="font-mono font-semibold tabular-nums">
                              {formatCurrency(
                                paymentPreview.remainingBeforeInterest,
                                activePaymentCredit.currency
                              )}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-500">
                              Porcentaje automático ({activePaymentCredit.interestRate}%):
                            </span>
                            <span className="font-mono font-semibold text-[#df7729] tabular-nums">
                              +{' '}
                              {formatCurrency(
                                paymentPreview.interestAdded,
                                activePaymentCredit.currency
                              )}
                            </span>
                          </div>
                          <div className="border-t border-slate-200 pt-1.5 flex justify-between text-sm font-bold text-[#145f96]">
                            <span>Nuevo saldo resultante:</span>
                            <span className="font-mono tabular-nums">
                              {formatCurrency(
                                paymentPreview.newBalance,
                                activePaymentCredit.currency
                              )}
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full min-h-[48px] rounded-xl bg-[#df7729] hover:bg-[#c8641a] disabled:opacity-60 text-white font-bold text-sm shadow-sm transition-colors cursor-pointer"
                  >
                    {submitting ? 'Registrando pago...' : 'Registrar Pago y Enviar Factura'}
                  </button>
                </>
              )}
            </>
          )}
        </form>
      )}

      {/* PANEL 3: MODIFICAR REGISTROS (Restringido con aprobación del Administrador para Empleados) */}
      {action === 'modify_records' && (
        <form
          onSubmit={handleModifyRecord}
          className="rounded-2xl bg-white border border-slate-200 shadow-sm p-4 sm:p-5 space-y-4"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-[#145f96]">Modificar Registros</h3>
              <p className="text-xs text-slate-500">
                {isAdmin
                  ? 'Modo Administrador: los cambios se aplican directamente.'
                  : 'Modo Empleado: requiere aprobación del Administrador.'}
              </p>
            </div>
            {!isAdmin && <ShieldAlert className="w-5 h-5 text-[#df7729] shrink-0" />}
          </div>

          {credits.length === 0 ? (
            <p className="text-sm text-slate-500 py-4">
              Aún no hay créditos ni pagos registrados para este cliente.
            </p>
          ) : (
            <>
              <div className="flex gap-1 p-1 rounded-xl bg-slate-100">
                <button
                  type="button"
                  onClick={() => setModifyTargetType('credit')}
                  className={`flex-1 py-2 rounded-lg text-xs font-bold cursor-pointer ${
                    modifyTargetType === 'credit'
                      ? 'bg-white text-[#145f96] shadow-sm'
                      : 'text-slate-600'
                  }`}
                >
                  Editar Crédito
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setModifyTargetType('transaction');
                    const paymentsOnly = transactions.filter((t) => t.type === 'payment');
                    if (paymentsOnly.length > 0) setModifyTxId(paymentsOnly[0].id);
                  }}
                  className={`flex-1 py-2 rounded-lg text-xs font-bold cursor-pointer ${
                    modifyTargetType === 'transaction'
                      ? 'bg-white text-[#145f96] shadow-sm'
                      : 'text-slate-600'
                  }`}
                >
                  Editar Pago
                </button>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Crédito relacionado
                </label>
                <select
                  value={modifyCreditId}
                  onChange={(e) => setModifyCreditId(e.target.value)}
                  className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm"
                >
                  {allCreditsSorted.map((c) => (
                    <option key={c.id} value={c.id}>
                      {creditLabelById.get(c.id) || 'Credit Cash'} · {formatCurrency(c.principal, c.currency)} ({c.interestRate}%) · Saldo:{' '}
                      {formatCurrency(c.currentBalance, c.currency)}
                    </option>
                  ))}
                </select>
              </div>

              {modifyTargetType === 'transaction' && (
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Pago a corregir
                  </label>
                  <select
                    value={modifyTxId}
                    onChange={(e) => setModifyTxId(e.target.value)}
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm"
                  >
                    {transactions
                      .filter((t) => t.type === 'payment' && t.creditId === modifyCreditId)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          Abono {formatCurrency(t.amount, t.currency)} · {formatDateTime(t.createdAt)}
                        </option>
                      ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Nueva Cantidad
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={modifyNewValue}
                    onChange={(e) => setModifyNewValue(e.target.value)}
                    placeholder="0.00"
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 text-sm font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Nuevo %</label>
                  <select
                    value={modifyNewRate}
                    onChange={(e) => setModifyNewRate(Number(e.target.value))}
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm font-mono"
                  >
                    {INTEREST_RATE_OPTIONS.map((rate) => (
                      <option key={rate} value={rate}>
                        {rate}%
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Motivo de la corrección
                </label>
                <input
                  type="text"
                  value={modifyReason}
                  onChange={(e) => setModifyReason(e.target.value)}
                  placeholder="Ej. Error de digitación en cantidad recibida"
                  className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 text-sm"
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full min-h-[48px] rounded-xl bg-[#145f96] hover:bg-[#0e4670] disabled:opacity-60 text-white font-bold text-sm transition-colors cursor-pointer"
              >
                {submitting
                  ? 'Procesando...'
                  : isAdmin
                    ? 'Guardar Corrección (Admin)'
                    : 'Solicitar Aprobación al Administrador'}
              </button>
            </>
          )}
        </form>
      )}

      {/* Active Credits Live Breakdown (prorated interest up to today + days without payment) */}
      {activeCredits.length > 0 && (
        <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden shadow-sm">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-bold text-[#145f96]">
              <CreditCard className="w-4 h-4" />
              <span>Créditos Activos</span>
            </div>
            <span className="text-xs font-semibold text-slate-500">
              {activeCredits.length} activo(s)
            </span>
          </div>

          <div className="divide-y divide-slate-200/70 akrobit-zebra-rows">
            {activeCredits.map((credit, idx) => {
              const live = liveStatusByCreditId.get(credit.id);
              const days = live ? live.daysElapsed : 0;
              const tier = getPortalAgingTier(days);
              const dayColor =
                tier === 'red'
                  ? 'text-[#d12925]'
                  : tier === 'orange'
                    ? 'text-[#df7729]'
                    : 'text-[#4d7c0f]';
              const underlineCls =
                days >= 30
                  ? 'shadow-[inset_0_-2px_0_0_#d12925]'
                  : days >= 25
                    ? 'shadow-[inset_0_-2px_0_0_#df7729]'
                    : '';

              return (
                <div
                  key={credit.id}
                  className={`px-3.5 py-3 space-y-1.5 ${underlineCls}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm font-bold text-[#145f96] whitespace-nowrap">
                      {creditLabelById.get(credit.id) || `Credit Cash N°${idx + 1}`}{' '}
                      <span className={`text-xs font-bold ${dayColor}`}>
                        {live?.isFrozen
                          ? `· Congelado (${days}d)`
                          : `· ${days} ${days === 1 ? 'día' : 'días'}`}
                      </span>
                    </p>
                    <p className="text-right font-mono text-sm font-bold text-slate-900 tabular-nums whitespace-nowrap shrink-0">
                      <span className="font-sans text-[11px] font-normal text-slate-500 mr-1">
                        {live?.isFrozen ? 'Fijo:' : 'Hoy:'}
                      </span>
                      {formatCurrency(live?.totalDueToday ?? credit.currentBalance, credit.currency)}
                    </p>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-slate-500 leading-snug">
                      Cap: {formatCurrency(live?.baseBalance ?? credit.currentBalance, credit.currency)} ({credit.interestRate}%)
                      {(live?.accruedInterest ?? 0) > 0 &&
                        ` · Int: +${formatCurrency(live!.accruedInterest, credit.currency)}`}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setErrorMessage('');
                        setStatusMessage('');
                        setPaymentMethod('');
                        setSelectedCreditId(credit.id);
                        setAction('register_payment');
                      }}
                      className="min-h-[34px] px-3 rounded-lg bg-[#df7729]/15 hover:bg-[#df7729]/25 text-[#df7729] text-xs font-bold cursor-pointer whitespace-nowrap shrink-0"
                    >
                      Abonar
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Client History Ledger */}
      <div className="rounded-2xl bg-white border border-slate-200 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-bold text-[#145f96]">
            <History className="w-4 h-4" />
            <span>Movimientos del Cliente</span>
          </div>
          <span className="text-xs text-slate-500">{transactions.length} registro(s)</span>
        </div>

        {transactions.length === 0 ? (
          <p className="text-xs text-slate-500 py-3">Sin movimientos registrados todavía.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {transactions.map((tx) => {
              const txCreditLabel = creditLabelById.get(tx.creditId);
              const shortCreditNum = txCreditLabel ? txCreditLabel.replace('Credit Cash ', '') : '';
              return (
              <div key={tx.id} className="py-2.5 space-y-0.5 text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="font-bold text-slate-900">
                    {tx.type === 'credit'
                      ? `Crédito otorgado${shortCreditNum ? ` ${shortCreditNum}` : ''} (${tx.interestRate}%)`
                      : tx.type === 'payment'
                        ? `Pago recibido${shortCreditNum ? ` · ${shortCreditNum}` : ''}${
                            tx.paymentMethod ? ` · ${formatPaymentMethodLabel(tx.paymentMethod)}` : ''
                          }`
                        : `Ajuste${shortCreditNum ? ` · ${shortCreditNum}` : ''}`}
                  </p>
                  <p
                    className={`font-mono font-bold tabular-nums whitespace-nowrap shrink-0 ${
                      tx.type === 'payment' ? 'text-[#4d7c0f]' : 'text-[#145f96]'
                    }`}
                  >
                    {tx.type === 'payment' ? '-' : ''}
                    {formatCurrency(tx.amount, tx.currency)}
                  </p>
                </div>

                <div className="flex items-baseline justify-between gap-2 text-slate-500">
                  <p className="min-w-0 truncate">
                    {formatDateTime(tx.createdAt)} · {formatActorName(tx.createdByName)}
                    {tx.hasPendingWrites ? ' · Pendiente sync' : ''}
                  </p>
                  <p className="text-[11px] font-mono tabular-nums whitespace-nowrap shrink-0">
                    Saldo: {formatCurrency(tx.newBalance, tx.currency)}
                  </p>
                </div>

                {tx.note && (
                  <p className="text-[11px] text-slate-500 leading-snug break-words">
                    {tx.note}
                  </p>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* MODAL: CHOOSE WHICH CREDIT OR CONSOLIDATED TO SEND VIA WHATSAPP */}
      {whatsappPickOpen && activeCredits.length > 1 && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/60 backdrop-blur-sm p-0 sm:p-4">
          <div className="w-full sm:max-w-md max-h-[85dvh] flex flex-col rounded-t-3xl sm:rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="bg-[#145f96] px-5 py-4 flex items-center justify-between text-white shrink-0">
              <div className="flex items-center gap-2">
                <MessageCircle className="w-5 h-5 text-[#25D366]" />
                <h3 className="text-base font-bold">Enviar Factura por WhatsApp</h3>
              </div>
              <button
                type="button"
                onClick={() => setWhatsappPickOpen(false)}
                aria-label="Cerrar selector de WhatsApp"
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl hover:bg-white/15 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-3 overflow-y-auto">
              <p className="text-xs font-semibold text-slate-600">
                Este cliente tiene {activeCredits.length} créditos activos. Selecciona cuál deseas
                enviar o manda el consolidado completo:
              </p>

              <button
                type="button"
                onClick={() => {
                  setWhatsappPickOpen(false);
                  onTriggerInvoice(buildConsolidatedInvoicePayload());
                }}
                className="w-full min-h-[52px] rounded-xl bg-[#25D366] hover:bg-[#1fb857] text-slate-950 px-4 py-3 flex items-center justify-between gap-3 font-bold text-sm shadow-sm transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2.5 min-w-0 text-left">
                  <Layers className="w-5 h-5 shrink-0" />
                  <div className="min-w-0">
                    <p className="leading-tight">Enviar Consolidado (Todos)</p>
                    <p className="text-[11px] font-semibold text-slate-900/80">
                      {activeCredits.length} créditos en un solo mensaje
                    </p>
                  </div>
                </div>
                <MessageCircle className="w-5 h-5 shrink-0" />
              </button>

              <div className="rounded-xl border border-slate-200 divide-y divide-slate-200/70 overflow-hidden akrobit-zebra-rows">
                {activeCredits.map((credit, idx) => {
                  const live = liveStatusByCreditId.get(credit.id);
                  const dueToday = live ? live.totalDueToday : credit.currentBalance;
                  const days = live ? live.daysElapsed : 0;
                  const label = creditLabelById.get(credit.id) || `Credit Cash N°${idx + 1}`;
                  return (
                    <button
                      key={credit.id}
                      type="button"
                      onClick={() => {
                        setWhatsappPickOpen(false);
                        onTriggerInvoice(buildCreditInvoicePayload(credit, idx));
                      }}
                      className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-[#69b8e9]/20 transition-colors cursor-pointer"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-[#145f96]">
                          {label} · {days}d
                        </p>
                        <p className="text-xs text-slate-500 truncate">
                          {formatDateTime(credit.createdAt)} · Cap:{' '}
                          {formatCurrency(credit.currentBalance, credit.currency)} ({credit.interestRate}%)
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-mono font-bold text-slate-900 tabular-nums">
                          {formatCurrency(dueToday, credit.currency)}
                        </p>
                        <span className="text-[11px] font-bold text-[#15803d]">Enviar</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: CONFIRM MOVE TO CARTERA CASTIGADA (ADMIN ONLY, 90+ DAYS) */}
      {castigadaConfirmOpen && canMoveToCastigada && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl border border-slate-200 p-5 space-y-4">
            <div className="flex items-center gap-2.5 text-[#d12925]">
              <Archive className="w-5 h-5 shrink-0" />
              <h3 className="text-base font-bold">¿Mover a Cartera Castigada?</h3>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">
              Se congelarán los números de <strong>{client.name}</strong> al día de hoy (
              <strong>{maxDaysWithoutPayment} días</strong> sin abono). Dejará de generar
              intereses diarios y saldrá de Credit Cash activo y de las alertas.
            </p>
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-3.5 py-2.5 text-xs space-y-1">
              <span className="font-bold text-slate-700 block">Totales que quedarán congelados:</span>
              {totalsByCurrency.nio > 0 && (
                <div className="flex items-center justify-between font-mono font-bold text-[#145f96]">
                  <span>Córdobas:</span>
                  <span>{formatCurrency(totalsByCurrency.nio, 'NIO')}</span>
                </div>
              )}
              {totalsByCurrency.usd > 0 && (
                <div className="flex items-center justify-between font-mono font-bold text-[#df7729]">
                  <span>Dólares:</span>
                  <span>{formatCurrency(totalsByCurrency.usd, 'USD')}</span>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setCastigadaConfirmOpen(false)}
                className="flex-1 min-h-[44px] rounded-xl bg-slate-100 text-slate-800 text-sm font-semibold cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={handleMoveToCarteraCastigada}
                className="flex-1 min-h-[44px] rounded-xl bg-[#d12925] hover:bg-[#b91c1c] text-white text-sm font-bold cursor-pointer"
              >
                {submitting ? 'Congelando...' : 'Congelar y Mover'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
