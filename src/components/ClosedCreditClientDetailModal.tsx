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
  FileEdit,
  History,
  KeyRound,
  MessageCircle,
  Package,
  RefreshCw,
  Search,
  ShieldAlert,
  ShoppingBag,
  Snowflake,
  X,
} from 'lucide-react';
import { doc, serverTimestamp, writeBatch, type WriteBatch } from 'firebase/firestore';
import { ORG_ID, db } from '../lib/firebase';
import {
  buildWhatsAppBusinessLink,
  calculateLiveCreditStatus,
  calculateProductPricing,
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
  InvoicePayload,
  PaymentMethod,
  Product,
  ProfitType,
} from '../types';

type ActiveAction = 'menu' | 'sell_product' | 'register_payment' | 'modify_records';

const QUICK_RECHARGE_AMOUNTS = [20, 50, 100, 200, 300, 500] as const;

function getTimestampMillis(ts: unknown): number {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return ts;
  }
  if (ts && typeof ts === 'object' && 'toMillis' in ts) {
    return (ts as { toMillis: () => number }).toMillis();
  }
  return Date.now();
}

interface ClosedCreditClientDetailModalProps {
  moduleId: string;
  moduleLabel: string;
  client: Client;
  credits: Credit[];
  transactions: CreditTransaction[];
  products: Product[];
  currentUserId: string;
  currentUserName: string;
  isAdmin: boolean;
  onBack: () => void;
  onTriggerInvoice: (invoice: InvoicePayload) => void;
}

export const ClosedCreditClientDetailModal: React.FC<ClosedCreditClientDetailModalProps> = ({
  moduleId,
  moduleLabel,
  client,
  credits,
  transactions,
  products,
  currentUserId,
  currentUserName,
  isAdmin,
  onBack,
  onTriggerInvoice,
}) => {
  const [action, setAction] = useState<ActiveAction>('menu');

  // 1. Vender Producto state
  const [productSearch, setProductSearch] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [rechargeCostInput, setRechargeCostInput] = useState('');
  const [unitsInput, setUnitsInput] = useState('1');
  const [customCostInput, setCustomCostInput] = useState('');
  const [customProfitType, setCustomProfitType] = useState<ProfitType>('amount');
  const [customProfitValue, setCustomProfitValue] = useState('');
  const [customCommission, setCustomCommission] = useState('0');

  // 2. Registrar Pago state
  const [selectedCreditId, setSelectedCreditId] = useState('');
  const [paymentInput, setPaymentInput] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | ''>('');

  // 3. Modificar Registros state
  const [modifyTxId, setModifyTxId] = useState('');
  const [modifyNewValue, setModifyNewValue] = useState('');
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
  useBackHandler(castigadaConfirmOpen, () => setCastigadaConfirmOpen(false));

  const allCreditsSorted = useMemo(
    () =>
      [...credits].sort(
        (a, b) => getTimestampMillis(a.createdAt) - getTimestampMillis(b.createdAt)
      ),
    [credits]
  );

  const activeCredits = useMemo(
    () => allCreditsSorted.filter((c) => c.status === 'active' && c.currentBalance > 0),
    [allCreditsSorted]
  );

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

  const availableProducts = useMemo(() => {
    return [...products]
      .filter((p) => p.active !== false)
      .sort((a, b) => {
        const aRank = a.carrier === 'claro' ? 0 : a.carrier === 'tigo' ? 1 : 2;
        const bRank = b.carrier === 'claro' ? 0 : b.carrier === 'tigo' ? 1 : 2;
        if (aRank !== bRank) return aRank - bRank;
        return a.name.localeCompare(b.name, 'es');
      });
  }, [products]);

  const rechargeProducts = useMemo(
    () => availableProducts.filter((p) => p.category === 'recharge'),
    [availableProducts]
  );

  const generalProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    return availableProducts.filter((p) => {
      if (p.category === 'recharge') return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) || (p.barcode || '').toLowerCase().includes(q)
      );
    });
  }, [availableProducts, productSearch]);

  const selectedProduct = useMemo(
    () => availableProducts.find((p) => p.id === selectedProductId) || null,
    [availableProducts, selectedProductId]
  );

  const handleSelectProduct = (product: Product) => {
    setErrorMessage('');
    setSelectedProductId(product.id);
    if (product.category === 'recharge') {
      setRechargeCostInput('');
      setCustomCommission(String(product.salesCommission ?? 0));
    } else {
      setUnitsInput('1');
      setCustomCostInput(String(product.costPrice));
      setCustomProfitType(product.profitType || 'amount');
      setCustomProfitValue(String(product.profitValue ?? 0));
      setCustomCommission(String(product.salesCommission ?? 0));
    }
  };

  const salePreview = useMemo(() => {
    if (!selectedProduct) return null;
    if (selectedProduct.category === 'recharge') {
      const cost = round2(Math.max(0, Number(rechargeCostInput) || 0));
      const commission = round2(Math.max(0, Number(customCommission) || 0));
      const breakdown = calculateProductPricing({
        costAmount: cost,
        profitType: 'percent',
        profitValue: 10,
        commissionAmount: commission,
      });
      return {
        isRecharge: true,
        stockToDeduct: cost,
        quantitySold: 1,
        profitType: 'percent' as ProfitType,
        profitValue: 10,
        ...breakdown,
      };
    }

    const units = Math.max(0, Number(unitsInput) || 0);
    const unitCost = Math.max(0, Number(customCostInput) || 0);
    const totalCost = round2(unitCost * units);
    const unitCommission = Math.max(0, Number(customCommission) || 0);
    const totalCommission = round2(unitCommission * units);
    const rawProfitVal = Math.max(0, Number(customProfitValue) || 0);
    const effectiveProfitVal =
      customProfitType === 'percent' ? rawProfitVal : round2(rawProfitVal * units);

    const breakdown = calculateProductPricing({
      costAmount: totalCost,
      profitType: customProfitType,
      profitValue: effectiveProfitVal,
      commissionAmount: totalCommission,
    });

    return {
      isRecharge: false,
      stockToDeduct: round2(units),
      quantitySold: round2(units),
      profitType: customProfitType,
      profitValue: rawProfitVal,
      ...breakdown,
    };
  }, [
    selectedProduct,
    rechargeCostInput,
    unitsInput,
    customCostInput,
    customProfitType,
    customProfitValue,
    customCommission,
  ]);

  const activePaymentCredit = useMemo(() => {
    if (activeCredits.length === 1) return activeCredits[0];
    return activeCredits.find((c) => c.id === selectedCreditId) || null;
  }, [activeCredits, selectedCreditId]);

  const activePaymentLiveStatus = useMemo(
    () => (activePaymentCredit ? liveStatusByCreditId.get(activePaymentCredit.id) || null : null),
    [activePaymentCredit, liveStatusByCreditId]
  );

  const parsedPayment = Number(paymentInput) || 0;

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

  const handleConfirmSale = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');
    setStatusMessage('');

    if (!selectedProduct || !salePreview) {
      setErrorMessage('Selecciona un producto del inventario.');
      return;
    }

    if (salePreview.isRecharge) {
      if (salePreview.costAmount <= 0) {
        setErrorMessage('Ingresa el costo en C$ de la recarga.');
        return;
      }
      if (salePreview.stockToDeduct > selectedProduct.quantity) {
        setErrorMessage(
          `Saldo insuficiente en inventario para ${selectedProduct.name} (disponible: ${formatCurrency(selectedProduct.quantity, selectedProduct.currency)}).`
        );
        return;
      }
    } else {
      if (salePreview.quantitySold <= 0) {
        setErrorMessage('Ingresa una cantidad válida mayor que 0.');
        return;
      }
      if (salePreview.saleTotal <= 0) {
        setErrorMessage('El total de venta debe ser mayor que 0.');
        return;
      }
      if (salePreview.stockToDeduct > selectedProduct.quantity) {
        setErrorMessage(
          `Stock insuficiente en inventario para ${selectedProduct.name} (disponible: ${selectedProduct.quantity} uds).`
        );
        return;
      }
    }

    setSubmitting(true);
    try {
      const batch = writeBatch(db);
      const { portalCode, portalKey } = await resolveClientPortalCredentials(batch);
      const nowServer = serverTimestamp();
      const nowLocalMs = Date.now();

      // Deduct stock from inventory atomically
      const nextProductQty = round2(
        Math.max(0, selectedProduct.quantity - salePreview.stockToDeduct)
      );
      batch.update(doc(db, 'products', selectedProduct.id), {
        quantity: nextProductQty,
        updatedAt: nowServer,
      });

      // Find or create running closed-credit account for this currency
      const existingCredit = activeCredits.find(
        (c) => c.interestMode === 'closed' && c.currency === selectedProduct.currency
      );

      const previousBalance = existingCredit ? round2(existingCredit.currentBalance) : 0;
      const newBalance = round2(previousBalance + salePreview.saleTotal);
      const creditId = existingCredit ? existingCredit.id : generateDocId('cr');

      let updatedCredits: Credit[];
      if (existingCredit) {
        const nextPrincipal = round2(existingCredit.principal + salePreview.saleTotal);
        batch.update(doc(db, 'credits', creditId), {
          principal: nextPrincipal,
          initialTotal: nextPrincipal,
          currentBalance: newBalance,
          status: 'active',
          updatedAt: nowServer,
        });
        updatedCredits = credits.map((c) =>
          c.id === creditId
            ? {
                ...c,
                principal: nextPrincipal,
                initialTotal: nextPrincipal,
                currentBalance: newBalance,
                status: 'active',
              }
            : c
        );
      } else {
        const newCreditData: Credit = {
          id: creditId,
          clientId: client.id,
          clientName: client.name,
          moduleId,
          currency: selectedProduct.currency,
          principal: salePreview.saleTotal,
          interestRate: 0,
          initialTotal: salePreview.saleTotal,
          currentBalance: newBalance,
          status: 'active',
          interestMode: 'closed',
          orgId: ORG_ID,
          createdBy: currentUserId,
          createdByName: currentUserName,
          createdAt: nowServer,
          updatedAt: nowServer,
        };
        batch.set(doc(db, 'credits', creditId), newCreditData);
        updatedCredits = [...credits, { ...newCreditData, createdAt: nowLocalMs }];
      }

      const displayProductName =
        selectedProduct.carrier === 'claro'
          ? `${selectedProduct.name} 🔴`
          : selectedProduct.carrier === 'tigo'
            ? `${selectedProduct.name} 🔵`
            : selectedProduct.name;

      const txId = generateDocId('tx');
      const newTxData: CreditTransaction = {
        id: txId,
        creditId,
        clientId: client.id,
        moduleId,
        type: 'sale',
        currency: selectedProduct.currency,
        amount: salePreview.saleTotal,
        interestRate: 0,
        previousBalance,
        newBalance,
        productId: selectedProduct.id,
        productName: displayProductName.slice(0, 120),
        quantitySold: salePreview.quantitySold,
        costAmount: salePreview.costAmount,
        profitType: salePreview.profitType,
        profitValue: salePreview.profitValue,
        profitAmount: salePreview.grossProfit,
        commissionAmount: salePreview.commissionAmount,
        netProfitAmount: salePreview.netProfit,
        note:
          !salePreview.isRecharge && salePreview.quantitySold > 1
            ? `${displayProductName} (x${salePreview.quantitySold})`
            : displayProductName,
        orgId: ORG_ID,
        createdBy: currentUserId,
        createdByName: currentUserName,
        createdAt: nowServer,
      };
      batch.set(doc(db, 'transactions', txId), newTxData);

      attachPortalSnapshotToBatch(
        batch,
        portalKey,
        client.id,
        client.name,
        updatedCredits,
        [{ ...newTxData, createdAt: nowLocalMs }, ...transactions],
        client.portfolioStatus || 'active',
        moduleId
      );

      await Promise.race([
        batch.commit(),
        new Promise<void>((resolve) => setTimeout(resolve, 1200)),
      ]);

      const invoice: InvoicePayload = {
        kind: 'sale',
        moduleLabel,
        clientName: client.name,
        clientPhone: client.phone,
        currency: selectedProduct.currency,
        amount: salePreview.saleTotal,
        interestRate: 0,
        previousBalance,
        newBalance,
        interestMode: 'closed',
        productName: displayProductName,
        quantitySold: salePreview.quantitySold,
        portalUrl: getPublicPortalUrl(),
        portalCode,
        attendedBy: currentUserName,
        dateLabel: new Date().toLocaleString('es-NI', { dateStyle: 'short', timeStyle: 'short' }),
        referenceId: txId,
      };

      setSelectedProductId('');
      setRechargeCostInput('');
      setUnitsInput('1');
      setAction('menu');
      onTriggerInvoice(invoice);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setErrorMessage(`No se pudo registrar la venta: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegisterPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');
    setStatusMessage('');

    if (!activePaymentCredit || !activePaymentLiveStatus) {
      setErrorMessage('Este cliente no tiene saldo pendiente por pagar.');
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
    if (parsedPayment > activePaymentLiveStatus.totalDueToday) {
      setErrorMessage(
        `El pago no puede superar el saldo pendiente (${formatCurrency(activePaymentLiveStatus.totalDueToday, activePaymentCredit.currency)}).`
      );
      return;
    }

    setSubmitting(true);
    try {
      const txId = generateDocId('tx');
      const batch = writeBatch(db);
      const { portalCode, portalKey } = await resolveClientPortalCredentials(batch);
      const nowServer = serverTimestamp();
      const nowLocalMs = Date.now();

      const newBalance = round2(Math.max(0, activePaymentLiveStatus.totalDueToday - parsedPayment));
      const settled = newBalance <= 0;
      const nextStatus: 'active' | 'settled' = settled ? 'settled' : 'active';

      batch.update(doc(db, 'credits', activePaymentCredit.id), {
        currentBalance: newBalance,
        status: nextStatus,
        lastPaymentAt: nowServer,
        updatedAt: nowServer,
      });

      const newTxData: CreditTransaction = {
        id: txId,
        creditId: activePaymentCredit.id,
        clientId: client.id,
        moduleId,
        type: 'payment',
        currency: activePaymentCredit.currency,
        amount: round2(parsedPayment),
        interestRate: 0,
        previousBalance: activePaymentCredit.currentBalance,
        newBalance,
        paymentMethod,
        note: settled
          ? `Cuenta liquidada (${formatPaymentMethodLabel(paymentMethod)})`
          : `Abono recibido (${formatPaymentMethodLabel(paymentMethod)})`,
        orgId: ORG_ID,
        createdBy: currentUserId,
        createdByName: currentUserName,
        createdAt: nowServer,
      };
      batch.set(doc(db, 'transactions', txId), newTxData);

      const updatedCredits = credits.map((cr) =>
        cr.id === activePaymentCredit.id
          ? {
              ...cr,
              currentBalance: newBalance,
              status: nextStatus,
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
        client.portfolioStatus || 'active',
        moduleId
      );

      await Promise.race([
        batch.commit(),
        new Promise<void>((resolve) => setTimeout(resolve, 1200)),
      ]);

      const invoice: InvoicePayload = {
        kind: 'payment',
        moduleLabel,
        clientName: client.name,
        clientPhone: client.phone,
        currency: activePaymentCredit.currency,
        amount: round2(parsedPayment),
        interestRate: 0,
        previousBalance: activePaymentCredit.currentBalance,
        newBalance,
        interestMode: 'closed',
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

  const editableTxs = useMemo(
    () => transactions.filter((t) => t.type === 'sale' || t.type === 'payment'),
    [transactions]
  );

  const handleModifyRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');
    setStatusMessage('');

    const selectedTx = editableTxs.find((t) => t.id === modifyTxId) || editableTxs[0];
    if (!selectedTx) {
      setErrorMessage('No hay movimientos para modificar.');
      return;
    }
    const targetCredit = credits.find((c) => c.id === selectedTx.creditId);
    if (!targetCredit) {
      setErrorMessage('No se encontró la cuenta relacionada.');
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

    setSubmitting(true);
    try {
      const batch = writeBatch(db);
      const nowServer = serverTimestamp();

      if (isAdmin) {
        const { portalKey } = await resolveClientPortalCredentials(batch);
        const diff = round2(newVal - selectedTx.amount);
        // For a sale, increasing amount increases debt; for a payment, increasing amount reduces debt
        const newBalance =
          selectedTx.type === 'sale'
            ? round2(Math.max(0, targetCredit.currentBalance + diff))
            : round2(Math.max(0, targetCredit.currentBalance - diff));
        const nextStatus: 'active' | 'settled' = newBalance <= 0 ? 'settled' : 'active';
        const updatedNote = modifyReason.trim() || `Corregido por Admin (${currentUserName})`;

        batch.update(doc(db, 'transactions', selectedTx.id), {
          amount: round2(newVal),
          newBalance,
          note: updatedNote,
        });
        batch.update(doc(db, 'credits', targetCredit.id), {
          currentBalance: newBalance,
          status: nextStatus,
          updatedAt: nowServer,
        });

        const adjId = generateDocId('tx');
        const adjTx: CreditTransaction = {
          id: adjId,
          creditId: targetCredit.id,
          clientId: client.id,
          moduleId,
          type: 'adjustment',
          currency: targetCredit.currency,
          amount: round2(newVal),
          interestRate: 0,
          previousBalance: targetCredit.currentBalance,
          newBalance,
          note: updatedNote,
          orgId: ORG_ID,
          createdBy: currentUserId,
          createdByName: currentUserName,
          createdAt: nowServer,
        };
        batch.set(doc(db, 'transactions', adjId), adjTx);

        const updatedCredits = credits.map((c) =>
          c.id === targetCredit.id ? { ...c, currentBalance: newBalance, status: nextStatus } : c
        );
        const updatedTxs = transactions.map((t) =>
          t.id === selectedTx.id
            ? { ...t, amount: round2(newVal), newBalance, note: updatedNote }
            : t
        );

        attachPortalSnapshotToBatch(
          batch,
          portalKey,
          client.id,
          client.name,
          updatedCredits,
          [{ ...adjTx, createdAt: Date.now() }, ...updatedTxs],
          client.portfolioStatus || 'active',
          moduleId
        );

        await Promise.race([
          batch.commit(),
          new Promise<void>((resolve) => setTimeout(resolve, 1200)),
        ]);
        setStatusMessage('Registro corregido directamente por Administrador.');
      } else {
        const reqId = generateDocId('req');
        batch.set(doc(db, 'modificationRequests', reqId), {
          id: reqId,
          targetType: 'transaction',
          creditId: targetCredit.id,
          transactionId: selectedTx.id,
          clientId: client.id,
          clientName: client.name,
          moduleId,
          currency: targetCredit.currency,
          oldValue: round2(selectedTx.amount),
          newValue: round2(newVal),
          oldInterestRate: 0,
          newInterestRate: 0,
          reason: modifyReason.trim().slice(0, 240),
          status: 'pending',
          orgId: ORG_ID,
          requestedBy: currentUserId,
          requestedByName: currentUserName,
          reviewedBy: '',
          reviewedByName: '',
          createdAt: nowServer,
          updatedAt: nowServer,
        });

        await Promise.race([
          batch.commit(),
          new Promise<void>((resolve) => setTimeout(resolve, 1200)),
        ]);
        setStatusMessage(
          'Solicitud enviada al Administrador. Recibirás actualización cuando la apruebe.'
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

  const canMoveToCastigada =
    isAdmin && !isCastigada && activeCredits.length > 0 && maxDaysWithoutPayment >= 90;

  const handleMoveToCarteraCastigada = async () => {
    if (!canMoveToCastigada) return;
    setErrorMessage('');
    setSubmitting(true);
    try {
      const batch = writeBatch(db);
      const { portalKey } = await resolveClientPortalCredentials(batch);
      const nowServer = serverTimestamp();

      batch.update(doc(db, 'clients', client.id), {
        portfolioStatus: 'castigada',
        sourceModule: moduleId,
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
          frozenAccruedInterest: 0,
          frozenAt: nowServer,
          updatedAt: nowServer,
        });
        return {
          ...cr,
          frozenDays: live.daysElapsed,
          frozenAccruedInterest: 0,
          frozenAt: Date.now(),
        };
      });

      const primaryActive = activeCredits[0];
      const moveTxId = generateDocId('tx');
      const moveTxData: CreditTransaction = {
        id: moveTxId,
        creditId: primaryActive.id,
        clientId: client.id,
        moduleId,
        type: 'adjustment',
        currency: primaryActive.currency,
        amount: 0,
        interestRate: 0,
        previousBalance: primaryActive.currentBalance,
        newBalance: primaryActive.currentBalance,
        note: `Traslado a Cartera Castigada por ${currentUserName} (${maxDaysWithoutPayment} días sin abono)`,
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
        'castigada',
        moduleId
      );

      await Promise.race([
        batch.commit(),
        new Promise<void>((resolve) => setTimeout(resolve, 1200)),
      ]);

      setCastigadaConfirmOpen(false);
      onBack();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setErrorMessage(`No se pudo mover a Cartera Castigada: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleQuickWhatsApp = () => {
    setErrorMessage('');
    if (activeCredits.length === 0) {
      setErrorMessage('Este cliente no tiene saldo pendiente para enviar estado de cuenta.');
      return;
    }

    const items: ConsolidatedCreditItem[] = activeCredits.map((cr, idx) => {
      const live = liveStatusByCreditId.get(cr.id) || calculateLiveCreditStatus(cr, transactions);
      return {
        label: `Cuenta ${moduleLabel}${activeCredits.length > 1 ? ` #${idx + 1}` : ''}`,
        currency: cr.currency,
        principal: cr.principal,
        interestRate: 0,
        currentBalance: live.totalDueToday,
        daysElapsed: live.daysElapsed,
        accruedInterest: 0,
        interestMode: 'closed',
        dateLabel: formatDateTime(cr.createdAt),
      };
    });

    onTriggerInvoice({
      kind: 'consolidated',
      moduleLabel,
      clientName: client.name,
      clientPhone: client.phone,
      currency: totalsByCurrency.nio > 0 ? 'NIO' : 'USD',
      amount: 0,
      interestRate: 0,
      previousBalance: 0,
      newBalance: 0,
      consolidatedItems: items,
      totalNio: totalsByCurrency.nio,
      totalUsd: totalsByCurrency.usd,
      portalUrl: getPublicPortalUrl(),
      portalCode: client.portalCode,
      attendedBy: currentUserName,
      dateLabel: new Date().toLocaleString('es-NI', { dateStyle: 'short', timeStyle: 'short' }),
      referenceId: activeCredits[0].id,
    });
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
            <p className="text-xs text-white/80 font-mono">
              {client.phone} · {moduleLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={handleQuickWhatsApp}
            aria-label="Enviar estado de cuenta por WhatsApp"
            title="Enviar estado de cuenta por WhatsApp"
            className="min-h-[42px] min-w-[42px] flex items-center justify-center rounded-xl bg-[#25D366] hover:bg-[#1fb857] text-slate-950 shadow-sm transition-colors cursor-pointer shrink-0"
          >
            <MessageCircle className="w-5 h-5" />
          </button>
        </div>

        {/* Separated Balances */}
        <div className="grid grid-cols-2 gap-2.5">
          <div className="rounded-xl bg-white/10 px-3.5 py-2.5 border border-white/15">
            <span className="text-[11px] text-white/75 block">
              {isCastigada ? 'Saldo congelado (C$)' : 'Saldo pendiente (C$)'}
            </span>
            <span className="text-base font-bold font-mono tabular-nums text-[#a1d63e]">
              {formatCurrency(totalsByCurrency.nio, 'NIO')}
            </span>
          </div>
          <div className="rounded-xl bg-white/10 px-3.5 py-2.5 border border-white/15">
            <span className="text-[11px] text-white/75 block">
              {isCastigada ? 'Saldo congelado (USD)' : 'Saldo pendiente (USD)'}
            </span>
            <span className="text-base font-bold font-mono tabular-nums text-[#69b8e9]">
              {formatCurrency(totalsByCurrency.usd, 'USD')}
            </span>
          </div>
        </div>

        {/* Aging indicator */}
        {activeCredits.length > 0 &&
          (() => {
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
              ? `Números congelados (${maxDaysWithoutPayment} días sin abono)`
              : maxDaysWithoutPayment >= 30
                ? `Alerta: ${maxDaysWithoutPayment} días sin abono o pago`
                : maxDaysWithoutPayment >= 20
                  ? `Atención: ${maxDaysWithoutPayment} días sin abono`
                  : `Al día: ${maxDaysWithoutPayment} día${maxDaysWithoutPayment === 1 ? '' : 's'} de ciclo`;

            return (
              <div className="mt-2.5 rounded-xl bg-white/10 px-3.5 py-2 border border-white/15 flex items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotColor}`} />
                  <span className={`font-bold truncate ${textColor}`}>{label}</span>
                </div>
                <span className="text-[11px] text-white/75 shrink-0">Crédito cerrado</span>
              </div>
            );
          })()}

        {/* PIN portal strip */}
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
                  className="min-h-[36px] px-2.5 rounded-lg bg-[#25D366] hover:bg-[#1fb857] text-slate-950 font-bold flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 shadow-sm"
                >
                  <MessageCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>Enviar PIN</span>
                </a>
                <button
                  type="button"
                  onClick={handleCopyPortalAccess}
                  className="min-h-[36px] px-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white font-semibold flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
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

      {/* Admin-only 90+ days: Move to Cartera Castigada */}
      {canMoveToCastigada && (
        <button
          type="button"
          onClick={() => {
            setErrorMessage('');
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
                Solo Administrador · Congela los saldos y retira de {moduleLabel} activo
              </p>
            </div>
          </div>
          <Snowflake className="w-4 h-4 text-[#d12925] shrink-0" />
        </button>
      )}

      {/* 3-Option Menu: Vender Producto | Registrar Pago | Modificar Registros */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        <button
          type="button"
          onClick={() => {
            setErrorMessage('');
            setStatusMessage('');
            setAction('sell_product');
          }}
          className={`min-h-[54px] rounded-xl px-4 py-3 text-left flex items-center gap-3 border-2 transition-all cursor-pointer ${
            action === 'sell_product'
              ? 'bg-[#145f96] text-white border-[#145f96] shadow-md'
              : 'bg-white text-slate-900 border-slate-200 hover:border-[#a1d63e]'
          }`}
        >
          <ShoppingBag
            className={`w-5 h-5 shrink-0 ${
              action === 'sell_product' ? 'text-[#a1d63e]' : 'text-[#145f96]'
            }`}
          />
          <span className="text-sm font-bold">Vender Producto</span>
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
            if (editableTxs.length > 0 && !modifyTxId) {
              setModifyTxId(editableTxs[0].id);
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

      {/* PANEL 1: VENDER PRODUCTO (Inventario -> Claro 🔴 / Tigo 🔵 / General) */}
      {action === 'sell_product' && (
        <form
          onSubmit={handleConfirmSale}
          className="rounded-2xl bg-white border border-slate-200 shadow-sm p-4 sm:p-5 space-y-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-[#145f96]">Vender Producto del Inventario</h3>
            {selectedProduct && (
              <button
                type="button"
                onClick={() => setSelectedProductId('')}
                className="text-xs font-bold text-[#145f96] underline cursor-pointer"
              >
                Cambiar producto
              </button>
            )}
          </div>

          {availableProducts.length === 0 ? (
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 text-center space-y-1.5">
              <Package className="w-7 h-7 text-slate-400 mx-auto" />
              <p className="text-xs font-bold text-slate-700">Inventario vacío</p>
              <p className="text-xs text-slate-500">
                Primero agrega Claro 🔴, Tigo 🔵 o tus productos en el módulo{' '}
                <strong>Inventario</strong>.
              </p>
            </div>
          ) : !selectedProduct ? (
            <div className="space-y-3">
              {/* Pinned Telephone Recharges: Claro 🔴 & Tigo 🔵 */}
              {rechargeProducts.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                    Recargas Telefónicas (10% fijo)
                  </span>
                  <div className="grid grid-cols-2 gap-2.5">
                    {rechargeProducts.map((prod) => (
                      <button
                        key={prod.id}
                        type="button"
                        onClick={() => handleSelectProduct(prod)}
                        className={`rounded-xl border-2 p-3 text-left transition-all cursor-pointer ${
                          prod.carrier === 'claro'
                            ? 'bg-[#d12925]/5 border-[#d12925]/35 hover:border-[#d12925]'
                            : 'bg-[#0284c7]/5 border-[#0284c7]/35 hover:border-[#0284c7]'
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span>{prod.carrier === 'claro' ? '🔴' : '🔵'}</span>
                          <span className="text-sm font-bold text-slate-900 truncate">
                            {prod.name}
                          </span>
                        </div>
                        <p className="text-[11px] font-mono text-slate-600 mt-1 tabular-nums">
                          Disp: {formatCurrency(prod.quantity, prod.currency)}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* General Inventory Products */}
              {availableProducts.some((p) => p.category !== 'recharge') && (
                <div className="space-y-2">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500 block">
                    Otros Productos del Inventario
                  </span>
                  <div className="relative">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="search"
                      value={productSearch}
                      onChange={(e) => setProductSearch(e.target.value)}
                      placeholder="Buscar producto..."
                      className="w-full min-h-[42px] rounded-xl border border-slate-300 pl-9 pr-3 text-sm"
                    />
                  </div>
                  <div className="rounded-xl border border-slate-200 divide-y divide-slate-200/70 max-h-60 overflow-y-auto akrobit-zebra-rows">
                    {generalProducts.length === 0 ? (
                      <p className="text-xs text-slate-500 text-center py-4">
                        Sin resultados para "{productSearch}".
                      </p>
                    ) : (
                      generalProducts.map((prod) => {
                        const unitPreview = calculateProductPricing({
                          costAmount: prod.costPrice,
                          profitType: prod.profitType,
                          profitValue: prod.profitValue,
                          commissionAmount: prod.salesCommission,
                        });
                        return (
                          <button
                            key={prod.id}
                            type="button"
                            onClick={() => handleSelectProduct(prod)}
                            className="w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left hover:bg-[#69b8e9]/20 cursor-pointer"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-bold text-slate-900 truncate">
                                {prod.name}
                              </p>
                              <p className="text-[11px] text-slate-500">
                                Stock: <strong>{prod.quantity}</strong> · Costo:{' '}
                                {formatCurrency(prod.costPrice, prod.currency)}
                              </p>
                            </div>
                            <span className="font-mono text-xs font-bold text-[#145f96] shrink-0 tabular-nums">
                              {formatCurrency(unitPreview.saleTotal, prod.currency)}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : selectedProduct.category === 'recharge' ? (
            /* RECHARGE SALE VIEW: Costo C$ | 10% | Total */
            <div className="space-y-3.5">
              <div className="rounded-xl bg-slate-50 border border-slate-200 px-3.5 py-2.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-base">
                    {selectedProduct.carrier === 'claro' ? '🔴' : '🔵'}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900 truncate">
                      {selectedProduct.name}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Disponible: {formatCurrency(selectedProduct.quantity, selectedProduct.currency)}
                    </p>
                  </div>
                </div>
                <span className="font-mono text-xs font-bold text-[#145f96] bg-[#145f96]/10 px-2.5 py-1 rounded-lg">
                  10% fijo
                </span>
              </div>

              {/* Quick recharge amount buttons */}
              <div className="flex flex-wrap gap-1.5">
                {QUICK_RECHARGE_AMOUNTS.map((amt) => (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => setRechargeCostInput(String(amt))}
                    className={`min-h-[36px] px-3 rounded-lg border text-xs font-mono font-bold cursor-pointer ${
                      Number(rechargeCostInput) === amt
                        ? 'bg-[#145f96] border-[#145f96] text-white'
                        : 'bg-white border-slate-200 text-slate-700 hover:border-[#69b8e9]'
                    }`}
                  >
                    C$ {amt}
                  </button>
                ))}
              </div>

              {/* 3 horizontal columns: Costo C$ | %10 | Total */}
              <div className="grid grid-cols-3 gap-2 items-end">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Costo C$</label>
                  <input
                    type="number"
                    step="0.01"
                    min="1"
                    inputMode="decimal"
                    value={rechargeCostInput}
                    onChange={(e) => setRechargeCostInput(e.target.value)}
                    placeholder="100"
                    className="w-full min-h-[46px] rounded-xl border-2 border-[#145f96]/30 px-2.5 text-sm font-mono font-bold tabular-nums focus:border-[#69b8e9] focus:outline-none"
                  />
                </div>
                <div>
                  <span className="block text-xs font-bold text-slate-700 mb-1 text-center">
                    %
                  </span>
                  <div className="min-h-[46px] rounded-xl bg-slate-100 border border-slate-200 px-2 flex items-center justify-center font-mono text-sm font-bold text-[#145f96]">
                    10%
                  </div>
                </div>
                <div>
                  <span className="block text-xs font-bold text-slate-700 mb-1 text-right">
                    Total
                  </span>
                  <div className="min-h-[46px] rounded-xl bg-[#a1d63e]/20 border border-[#a1d63e]/60 px-2.5 flex items-center justify-end font-mono text-xs sm:text-sm font-bold text-[#145f96] tabular-nums">
                    {formatCurrency(salePreview?.saleTotal ?? 0, selectedProduct.currency)}
                  </div>
                </div>
              </div>

              {salePreview && salePreview.costAmount > 0 && (
                <div className="rounded-xl bg-slate-50 border border-slate-200 px-3.5 py-2.5 text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Se descontará de inventario:</span>
                    <span className="font-mono font-semibold tabular-nums">
                      - {formatCurrency(salePreview.costAmount, selectedProduct.currency)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Ganancia interna (10%):</span>
                    <span className="font-mono font-bold text-[#4d7c0f] tabular-nums">
                      + {formatCurrency(salePreview.grossProfit, selectedProduct.currency)}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 pt-1 border-t border-slate-200">
                    El cliente solo recibe la factura por el <strong>Total ({formatCurrency(salePreview.saleTotal, selectedProduct.currency)})</strong>.
                  </p>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full min-h-[48px] rounded-xl bg-[#a1d63e] hover:bg-[#8ec22f] disabled:opacity-60 text-slate-950 font-bold text-sm shadow-sm cursor-pointer"
              >
                {submitting ? 'Registrando venta...' : 'Confirmar Venta y Enviar Factura'}
              </button>
            </div>
          ) : (
            /* GENERAL PRODUCT SALE VIEW: Quantity + Cost + Open Profit (% or Cantidad) + Commission */
            <div className="space-y-3.5">
              <div className="rounded-xl bg-slate-50 border border-slate-200 px-3.5 py-2.5 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-900 truncate">
                    {selectedProduct.name}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Disponible en inventario: <strong>{selectedProduct.quantity} uds</strong>
                  </p>
                </div>
                <span className="font-mono text-xs font-bold text-[#145f96]">
                  {selectedProduct.currency === 'NIO' ? 'C$' : 'USD'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Cantidad a vender
                  </label>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    inputMode="numeric"
                    value={unitsInput}
                    onChange={(e) => setUnitsInput(e.target.value)}
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 text-sm font-mono font-bold tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Costo unitario ({selectedProduct.currency === 'NIO' ? 'C$' : 'USD'})
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    value={customCostInput}
                    onChange={(e) => setCustomCostInput(e.target.value)}
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 text-sm font-mono font-bold tabular-nums"
                  />
                </div>
              </div>

              {/* Open profit choice: Cantidad vs % */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-bold text-slate-700">
                    Ganancia por unidad (editable)
                  </label>
                  <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-100">
                    <button
                      type="button"
                      onClick={() => setCustomProfitType('amount')}
                      className={`px-3 py-1 rounded-md text-xs font-bold cursor-pointer ${
                        customProfitType === 'amount'
                          ? 'bg-[#145f96] text-white shadow-sm'
                          : 'text-slate-600'
                      }`}
                    >
                      Cantidad
                    </button>
                    <button
                      type="button"
                      onClick={() => setCustomProfitType('percent')}
                      className={`px-3 py-1 rounded-md text-xs font-bold cursor-pointer ${
                        customProfitType === 'percent'
                          ? 'bg-[#145f96] text-white shadow-sm'
                          : 'text-slate-600'
                      }`}
                    >
                      %
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    value={customProfitValue}
                    onChange={(e) => setCustomProfitValue(e.target.value)}
                    placeholder={customProfitType === 'percent' ? '%' : 'Cantidad'}
                    className="w-full min-h-[44px] rounded-xl border-2 border-[#a1d63e]/60 px-3 text-sm font-mono font-bold tabular-nums focus:border-[#4d7c0f] focus:outline-none"
                  />
                  <div>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      inputMode="decimal"
                      value={customCommission}
                      onChange={(e) => setCustomCommission(e.target.value)}
                      placeholder="Comisión ud."
                      title="Comisión por venta (unidad)"
                      className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 text-sm font-mono tabular-nums"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-slate-400">
                  Izquierda: Ganancia ({customProfitType === 'percent' ? '%' : 'monto abierto'}) ·
                  Derecha: Comisión por venta por unidad
                </p>
              </div>

              {salePreview && (
                <div className="rounded-xl bg-slate-50 border border-slate-200 px-3.5 py-2.5 text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Costo total:</span>
                    <span className="font-mono tabular-nums">
                      {formatCurrency(salePreview.costAmount, selectedProduct.currency)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Ganancia bruta:</span>
                    <span className="font-mono font-bold text-[#4d7c0f] tabular-nums">
                      + {formatCurrency(salePreview.grossProfit, selectedProduct.currency)}
                    </span>
                  </div>
                  {salePreview.commissionAmount > 0 && (
                    <div className="flex justify-between">
                      <span className="text-slate-500">Comisión de venta:</span>
                      <span className="font-mono text-[#df7729] tabular-nums">
                        - {formatCurrency(salePreview.commissionAmount, selectedProduct.currency)}
                      </span>
                    </div>
                  )}
                  <div className="border-t border-slate-200 pt-1.5 flex justify-between text-sm font-bold text-[#145f96]">
                    <span>Total al cliente:</span>
                    <span className="font-mono tabular-nums">
                      {formatCurrency(salePreview.saleTotal, selectedProduct.currency)}
                    </span>
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full min-h-[48px] rounded-xl bg-[#a1d63e] hover:bg-[#8ec22f] disabled:opacity-60 text-slate-950 font-bold text-sm shadow-sm cursor-pointer"
              >
                {submitting ? 'Registrando venta...' : 'Confirmar Venta y Enviar Factura'}
              </button>
            </div>
          )}
        </form>
      )}

      {/* PANEL 2: REGISTRAR PAGO (with mandatory Cash / Bank selector) */}
      {action === 'register_payment' && (
        <form
          onSubmit={handleRegisterPayment}
          className="rounded-2xl bg-white border border-slate-200 shadow-sm p-4 sm:p-5 space-y-4"
        >
          <h3 className="text-sm font-bold text-[#145f96]">Registrar Pago ({moduleLabel})</h3>

          {activeCredits.length === 0 ? (
            <p className="text-sm text-slate-500 py-4">
              Este cliente no tiene saldos pendientes por pagar.
            </p>
          ) : (
            <>
              {activeCredits.length > 1 && (
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">
                    Selecciona la cuenta a abonar
                  </label>
                  <select
                    value={selectedCreditId}
                    onChange={(e) => {
                      setErrorMessage('');
                      setSelectedCreditId(e.target.value);
                    }}
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-900"
                  >
                    <option value="" disabled>
                      Selecciona la moneda/cuenta...
                    </option>
                    {activeCredits.map((c) => (
                      <option key={c.id} value={c.id}>
                        Cuenta {c.currency === 'NIO' ? 'Córdobas (C$)' : 'Dólares (USD)'} · Saldo:{' '}
                        {formatCurrency(c.currentBalance, c.currency)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {activePaymentCredit && activePaymentLiveStatus && (
                <>
                  <div className="grid grid-cols-2 gap-3 items-end">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label
                          htmlFor="closed-payment-amount"
                          className="block text-xs font-bold text-slate-700"
                        >
                          Cantidad (Abono)
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            setPaymentInput(String(activePaymentLiveStatus.totalDueToday))
                          }
                          className="text-[11px] font-bold text-[#145f96] hover:text-[#df7729] underline cursor-pointer whitespace-nowrap"
                        >
                          Liquidar todo
                        </button>
                      </div>
                      <input
                        id="closed-payment-amount"
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
                        Saldo Pendiente
                      </span>
                      <div className="min-h-[46px] rounded-xl bg-slate-100 border border-slate-200 px-3 flex items-center justify-end font-mono text-sm font-bold text-[#145f96] tabular-nums">
                        {formatCurrency(
                          activePaymentLiveStatus.totalDueToday,
                          activePaymentCredit.currency
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Mandatory Cash / Bank selector */}
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

                  {parsedPayment > 0 && (
                    <div className="rounded-xl bg-slate-50 border border-slate-200 p-3.5 text-xs space-y-1.5">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Saldo actual:</span>
                        <span className="font-mono tabular-nums">
                          {formatCurrency(
                            activePaymentLiveStatus.totalDueToday,
                            activePaymentCredit.currency
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Abono a aplicar:</span>
                        <span className="font-mono font-bold text-[#4d7c0f] tabular-nums">
                          - {formatCurrency(parsedPayment, activePaymentCredit.currency)}
                        </span>
                      </div>
                      <div className="border-t border-slate-200 pt-1.5 flex justify-between text-sm font-bold text-[#145f96]">
                        <span>Nuevo saldo:</span>
                        <span className="font-mono tabular-nums">
                          {formatCurrency(
                            Math.max(0, activePaymentLiveStatus.totalDueToday - parsedPayment),
                            activePaymentCredit.currency
                          )}
                        </span>
                      </div>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full min-h-[48px] rounded-xl bg-[#df7729] hover:bg-[#c8641a] disabled:opacity-60 text-white font-bold text-sm shadow-sm cursor-pointer"
                  >
                    {submitting ? 'Registrando pago...' : 'Registrar Pago y Enviar Factura'}
                  </button>
                </>
              )}
            </>
          )}
        </form>
      )}

      {/* PANEL 3: MODIFICAR REGISTROS */}
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

          {editableTxs.length === 0 ? (
            <p className="text-sm text-slate-500 py-4">
              Aún no hay ventas ni pagos registrados para este cliente.
            </p>
          ) : (
            <>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Movimiento a corregir
                </label>
                <select
                  value={modifyTxId}
                  onChange={(e) => setModifyTxId(e.target.value)}
                  className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 text-sm"
                >
                  {editableTxs.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.type === 'sale' ? t.productName || 'Venta' : 'Abono'} ·{' '}
                      {formatCurrency(t.amount, t.currency)} · {formatDateTime(t.createdAt)}
                    </option>
                  ))}
                </select>
              </div>

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
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Motivo de la corrección
                </label>
                <input
                  type="text"
                  value={modifyReason}
                  onChange={(e) => setModifyReason(e.target.value)}
                  placeholder="Ej. Error de monto registrado"
                  className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 text-sm"
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full min-h-[48px] rounded-xl bg-[#145f96] hover:bg-[#0e4670] disabled:opacity-60 text-white font-bold text-sm cursor-pointer"
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
              <div key={tx.id} className="py-2.5 space-y-0.5 text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="font-bold text-slate-900">
                    {tx.type === 'sale'
                      ? `${tx.productName || 'Producto vendido'}${
                          tx.quantitySold && tx.quantitySold > 1 ? ` (x${tx.quantitySold})` : ''
                        }`
                      : tx.type === 'payment'
                        ? `Pago recibido${
                            tx.paymentMethod ? ` · ${formatPaymentMethodLabel(tx.paymentMethod)}` : ''
                          }`
                        : 'Ajuste de cuenta'}
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

                {tx.type === 'sale' && typeof tx.netProfitAmount === 'number' && (
                  <p className="text-[11px] text-slate-400">
                    Interno: Costo {formatCurrency(tx.costAmount ?? 0, tx.currency)} · Gan. neta{' '}
                    <span className="text-[#4d7c0f] font-semibold">
                      {formatCurrency(tx.netProfitAmount, tx.currency)}
                    </span>
                    {(tx.commissionAmount ?? 0) > 0 &&
                      ` · Com: ${formatCurrency(tx.commissionAmount ?? 0, tx.currency)}`}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* MODAL: CONFIRM MOVE TO CARTERA CASTIGADA */}
      {castigadaConfirmOpen && canMoveToCastigada && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl border border-slate-200 p-5 space-y-4">
            <div className="flex items-center gap-2.5 text-[#d12925]">
              <Archive className="w-5 h-5 shrink-0" />
              <h3 className="text-base font-bold">¿Mover a Cartera Castigada?</h3>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">
              Se congelarán los saldos de <strong>{client.name}</strong> (
              <strong>{maxDaysWithoutPayment} días</strong> sin abono). Saldrá de{' '}
              <strong>{moduleLabel}</strong> activo y de la campanita de alertas.
            </p>
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
