import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  BadgeDollarSign,
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
  X,
} from 'lucide-react';
import { doc, serverTimestamp, writeBatch, type WriteBatch } from 'firebase/firestore';
import { ORG_ID, db } from '../lib/firebase';
import {
  INTEREST_RATE_OPTIONS,
  calculateInitialCreditTotal,
  calculateInterestCeil,
  calculatePaymentOnBalance,
  formatCurrency,
  generateDocId,
  round2,
} from '../lib/finance';
import {
  attachPortalSnapshotToBatch,
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
} from '../types';

type ActiveAction = 'menu' | 'add_credit' | 'register_payment' | 'modify_records';

function getTimestampMillis(ts: unknown): number {
  if (ts && typeof ts === 'object' && 'toMillis' in ts) {
    return (ts as { toMillis: () => number }).toMillis();
  }
  return 0;
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

  // 2. Registrar Pago state (active credits ordered chronologically oldest -> newest for N°1, N°2...)
  const activeCredits = useMemo(
    () =>
      credits
        .filter((c) => c.status === 'active' && c.currentBalance > 0)
        .sort((a, b) => getTimestampMillis(a.createdAt) - getTimestampMillis(b.createdAt)),
    [credits]
  );

  const creditLabelById = useMemo(() => {
    const map = new Map<string, string>();
    activeCredits.forEach((cr, idx) => {
      map.set(cr.id, `Credit Cash N°${idx + 1}`);
    });
    return map;
  }, [activeCredits]);

  const [selectedCreditId, setSelectedCreditId] = useState<string>('');
  const [paymentInput, setPaymentInput] = useState('');
  const [whatsappPickOpen, setWhatsappPickOpen] = useState(false);

  // 3. Modificar Registros state
  const [modifyTargetType, setModifyTargetType] = useState<'credit' | 'transaction'>('credit');
  const [modifyCreditId, setModifyCreditId] = useState<string>(() => credits[0]?.id || '');
  const [modifyTxId, setModifyTxId] = useState<string>('');
  const [modifyNewValue, setModifyNewValue] = useState('');
  const [modifyNewRate, setModifyNewRate] = useState<number>(10);
  const [modifyReason, setModifyReason] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [regeneratingCode, setRegeneratingCode] = useState(false);
  const [portalCopied, setPortalCopied] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  useBackHandler(action !== 'menu', () => {
    setErrorMessage('');
    setStatusMessage('');
    setAction('menu');
  });
  useBackHandler(whatsappPickOpen, () => setWhatsappPickOpen(false));

  const totalsByCurrency = useMemo(() => {
    let nio = 0;
    let usd = 0;
    for (const c of activeCredits) {
      if (c.currency === 'NIO') nio = round2(nio + c.currentBalance);
      else usd = round2(usd + c.currentBalance);
    }
    return { nio, usd };
  }, [activeCredits]);

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

  const parsedPayment = Number(paymentInput) || 0;
  const paymentPreview = useMemo(() => {
    if (!activePaymentCredit) return null;
    return calculatePaymentOnBalance(
      activePaymentCredit.currentBalance,
      parsedPayment,
      activePaymentCredit.interestRate
    );
  }, [activePaymentCredit, parsedPayment]);

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

      const newCreditData: Credit = {
        id: creditId,
        clientId: client.id,
        clientName: client.name,
        currency,
        principal: round2(parsedPrincipal),
        interestRate,
        initialTotal: computedCreditTotal,
        currentBalance: computedCreditTotal,
        status: 'active',
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
        type: 'credit',
        currency,
        amount: round2(parsedPrincipal),
        interestRate,
        previousBalance: 0,
        newBalance: computedCreditTotal,
        note: `Crédito inicial ${interestRate}%`,
        orgId: ORG_ID,
        createdBy: currentUserId,
        createdByName: currentUserName,
        createdAt: serverTimestamp(),
      };

      batch.set(doc(db, 'credits', creditId), newCreditData);
      batch.set(doc(db, 'transactions', txId), newTxData);

      attachPortalSnapshotToBatch(
        batch,
        portalKey,
        client.id,
        client.name,
        [...credits, newCreditData],
        [newTxData, ...transactions]
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
        amount: round2(parsedPrincipal),
        interestRate,
        previousBalance: 0,
        newBalance: computedCreditTotal,
        creditLabel:
          activeCredits.length >= 1 ? `Credit Cash N°${activeCredits.length + 1}` : undefined,
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

    if (!activePaymentCredit || !paymentPreview) {
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
    if (parsedPayment > activePaymentCredit.currentBalance) {
      setErrorMessage('El pago no puede superar el saldo pendiente actual.');
      return;
    }

    setSubmitting(true);
    try {
      const txId = generateDocId('tx');
      const batch = writeBatch(db);
      const { portalCode, portalKey } = await resolveClientPortalCredentials(batch);
      const creditRef = doc(db, 'credits', activePaymentCredit.id);
      const nextStatus: 'active' | 'settled' = paymentPreview.settled ? 'settled' : 'active';

      batch.update(creditRef, {
        currentBalance: paymentPreview.newBalance,
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });

      const newTxData: CreditTransaction = {
        id: txId,
        creditId: activePaymentCredit.id,
        clientId: client.id,
        type: 'payment',
        currency: activePaymentCredit.currency,
        amount: round2(parsedPayment),
        interestRate: activePaymentCredit.interestRate,
        previousBalance: activePaymentCredit.currentBalance,
        newBalance: paymentPreview.newBalance,
        note: paymentPreview.settled
          ? 'Abono final — Crédito liquidado'
          : `Abono sobre saldo (+${activePaymentCredit.interestRate}% s/restante)`,
        orgId: ORG_ID,
        createdBy: currentUserId,
        createdByName: currentUserName,
        createdAt: serverTimestamp(),
      };

      batch.set(doc(db, 'transactions', txId), newTxData);

      const updatedCredits = credits.map((cr) =>
        cr.id === activePaymentCredit.id
          ? { ...cr, currentBalance: paymentPreview.newBalance, status: nextStatus }
          : cr
      );
      attachPortalSnapshotToBatch(
        batch,
        portalKey,
        client.id,
        client.name,
        updatedCredits,
        [newTxData, ...transactions]
      );

      await Promise.race([
        batch.commit(),
        new Promise<void>((resolve) => setTimeout(resolve, 1200)),
      ]);

      const invoice: InvoicePayload = {
        kind: 'payment',
        clientName: client.name,
        clientPhone: client.phone,
        currency: activePaymentCredit.currency,
        amount: round2(parsedPayment),
        interestRate: activePaymentCredit.interestRate,
        previousBalance: activePaymentCredit.currentBalance,
        remainingBeforeInterest: paymentPreview.remainingBeforeInterest,
        interestAdded: paymentPreview.interestAdded,
        newBalance: paymentPreview.newBalance,
        creditLabel:
          activeCredits.length > 1 ? creditLabelById.get(activePaymentCredit.id) : undefined,
        portalUrl: getPublicPortalUrl(),
        portalCode,
        attendedBy: currentUserName,
        dateLabel: new Date().toLocaleString('es-NI', { dateStyle: 'short', timeStyle: 'short' }),
        referenceId: txId,
      };

      setPaymentInput('');
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
          const delta = round2(newInitialTotal - targetCredit.initialTotal);
          newBalance = round2(Math.max(0, targetCredit.currentBalance + delta));
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
          [adjTx, ...updatedTxs]
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
    const multiLabel =
      activeCredits.length > 1 ? `Credit Cash N°${index + 1}` : undefined;

    if (latestTx && latestTx.type === 'payment') {
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
        newBalance: credit.currentBalance,
        creditLabel: multiLabel,
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
      newBalance: credit.currentBalance,
      creditLabel: multiLabel,
      portalUrl: getPublicPortalUrl(),
      portalCode: client.portalCode,
      attendedBy: credit.createdByName || currentUserName,
      dateLabel: formatDateTime(credit.createdAt),
      referenceId: credit.id,
    };
  };

  const buildConsolidatedInvoicePayload = (): InvoicePayload => {
    const consolidatedItems: ConsolidatedCreditItem[] = activeCredits.map((cr, idx) => ({
      label: `Credit Cash N°${idx + 1}`,
      currency: cr.currency,
      principal: cr.principal,
      interestRate: cr.interestRate,
      currentBalance: cr.currentBalance,
      dateLabel: formatDateTime(cr.createdAt),
    }));

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

  const handleCopyPortalAccess = async () => {
    if (!client.portalCode) return;
    const text = `Consulta tu historial Akrobit:\n${getPublicPortalUrl()}\nTeléfono: ${client.phone}\nCódigo secreto: ${client.portalCode}`;
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
            <h2 className="text-lg font-bold truncate">{client.name}</h2>
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
            <span className="text-[11px] text-white/75 block">Saldo en Córdobas</span>
            <span className="text-base font-bold font-mono tabular-nums text-[#a1d63e]">
              {formatCurrency(totalsByCurrency.nio, 'NIO')}
            </span>
          </div>
          <div className="rounded-xl bg-white/10 px-3.5 py-2.5 border border-white/15">
            <span className="text-[11px] text-white/75 block">Saldo en Dólares</span>
            <span className="text-base font-bold font-mono tabular-nums text-[#69b8e9]">
              {formatCurrency(totalsByCurrency.usd, 'USD')}
            </span>
          </div>
        </div>

        {/* Client Portal 6-digit Secret Code Strip */}
        <div className="mt-2.5 rounded-xl bg-white/10 px-3.5 py-2 border border-white/15 flex items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <KeyRound className="w-3.5 h-3.5 text-[#a1d63e] shrink-0" />
            <span className="text-white/80 truncate">Código portal:</span>
            <span className="font-mono font-bold tracking-wider text-[#a1d63e]">
              {client.portalCode || 'Generando...'}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {client.portalCode && (
              <button
                type="button"
                onClick={handleCopyPortalAccess}
                className="min-h-[32px] px-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white font-semibold flex items-center gap-1 cursor-pointer"
                title="Copiar enlace y código del cliente"
              >
                {portalCopied ? (
                  <Check className="w-3.5 h-3.5 text-[#a1d63e]" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                <span>{portalCopied ? 'Copiado' : 'Copiar'}</span>
              </button>
            )}
            <button
              type="button"
              disabled={regeneratingCode}
              onClick={handleRegenerateCode}
              title="Generar nuevo código secreto (anula el anterior)"
              className="min-h-[32px] px-2.5 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-50 text-white font-semibold flex items-center gap-1 cursor-pointer"
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
                Total
              </span>
              <div className="min-h-[46px] rounded-xl bg-slate-100 border border-slate-200 px-2.5 flex items-center justify-end font-mono text-xs sm:text-sm font-bold text-[#145f96] tabular-nums">
                {formatCurrency(computedCreditTotal, currency)}
              </div>
            </div>
          </div>

          {parsedPrincipal > 0 && interestRate !== '' && (
            <div className="flex items-center justify-between rounded-xl bg-slate-50 border border-slate-200 px-3.5 py-2 text-xs">
              <span className="text-slate-600">Interés ({interestRate}%):</span>
              <span className="font-mono font-bold text-[#df7729] tabular-nums">
                {formatCurrency(calculateInterestCeil(parsedPrincipal, interestRate), currency)}
              </span>
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
                    {activeCredits.map((c, idx) => (
                      <option key={c.id} value={c.id}>
                        Credit Cash N°{idx + 1} · {formatCurrency(c.currentBalance, c.currency)} ({c.interestRate}% · Cap:{' '}
                        {formatCurrency(c.principal, c.currency)})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Horizontal Cantidad & Saldo columns */}
              {activePaymentCredit && (
                <>
                  <div className="grid grid-cols-2 gap-3 items-end">
                    <div>
                      <label
                        htmlFor="payment-amount"
                        className="block text-xs font-bold text-slate-700 mb-1"
                      >
                        Cantidad (Abono)
                      </label>
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
                        Saldo Actual
                      </span>
                      <div className="min-h-[46px] rounded-xl bg-slate-100 border border-slate-200 px-3 flex items-center justify-end font-mono text-sm font-bold text-[#145f96] tabular-nums">
                        {formatCurrency(activePaymentCredit.currentBalance, activePaymentCredit.currency)}
                      </div>
                    </div>
                  </div>

                  {/* Live calculation preview of credit-on-remaining-balance */}
                  {paymentPreview && parsedPayment > 0 && (
                    <div className="rounded-xl bg-slate-50 border border-slate-200 p-3.5 text-xs space-y-1.5">
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
                  {credits.map((c) => (
                    <option key={c.id} value={c.id}>
                      {formatCurrency(c.principal, c.currency)} ({c.interestRate}%) · Saldo:{' '}
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
            {transactions.map((tx) => (
              <div key={tx.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <p className="font-bold text-slate-900">
                    {tx.type === 'credit'
                      ? `Crédito otorgado (${tx.interestRate}%)`
                      : tx.type === 'payment'
                        ? 'Pago recibido'
                        : 'Ajuste de registro'}
                  </p>
                  <p className="text-slate-500 truncate">
                    {formatDateTime(tx.createdAt)} · {tx.createdByName}
                    {tx.hasPendingWrites ? ' · Pendiente sync' : ''}
                  </p>
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
                {activeCredits.map((credit, idx) => (
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
                      <p className="text-sm font-bold text-[#145f96]">Credit Cash N°{idx + 1}</p>
                      <p className="text-xs text-slate-500 truncate">
                        {formatDateTime(credit.createdAt)} · Cap:{' '}
                        {formatCurrency(credit.principal, credit.currency)} ({credit.interestRate}%)
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-mono font-bold text-slate-900 tabular-nums">
                        {formatCurrency(credit.currentBalance, credit.currency)}
                      </p>
                      <span className="text-[11px] font-bold text-[#15803d]">Enviar</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
