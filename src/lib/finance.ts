import type {
  Client,
  Credit,
  CreditTransaction,
  CurrencyCode,
  InvoicePayload,
  PaymentMethod,
  ProfitType,
} from '../types';

export const INTEREST_RATE_OPTIONS = [5, 6, 7, 8, 9, 10] as const;

export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function formatActorName(rawName?: string): string {
  const clean = (rawName || '').trim();
  if (!clean || clean.toLowerCase() === 'akrobits') return 'Akrobit';
  return clean;
}

export function formatPaymentMethodLabel(method?: PaymentMethod): string {
  if (method === 'cash') return 'Cash';
  if (method === 'bank') return 'Bank';
  return '';
}

export function getModuleLabelById(moduleId?: string): string {
  if (!moduleId || moduleId === 'credit_cash') return 'Credit Cash';
  if (moduleId === 'maestros') return 'Maestros';
  return moduleId;
}

export function getCurrencySymbol(currency: CurrencyCode): string {
  return currency === 'NIO' ? 'C$' : 'USD';
}

export function formatCurrency(amount: number, currency: CurrencyCode): string {
  const safe = round2(amount);
  const formatted = safe.toLocaleString('es-NI', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === 'NIO' ? `C$ ${formatted}` : `USD ${formatted}`;
}

export function calculateInterestCeil(baseAmount: number, interestRate: number): number {
  if (baseAmount <= 0 || interestRate <= 0) return 0;
  // Normalize to 4 decimals before Math.ceil so exact numbers like 100 * 7% = 7.000000000000001 stay 7
  const exact = Math.round(((baseAmount * interestRate) / 100) * 10000) / 10000;
  return Math.ceil(exact);
}

export function calculateInitialCreditTotal(principal: number, interestRate: number): number {
  if (principal <= 0) return 0;
  const interest = calculateInterestCeil(principal, interestRate);
  return round2(principal + interest);
}

export interface ProductPricingBreakdown {
  costAmount: number;
  grossProfit: number;
  commissionAmount: number;
  netProfit: number;
  saleTotal: number;
}

/**
 * Computes pricing & analytics breakdown for inventory sales.
 * - For percent profit (e.g., Claro/Tigo 10% or % products), rounds UP with calculateInterestCeil.
 * - For open numeric amount profit, adds the exact amount.
 * - Net profit reflects real profit after sales commission.
 */
export function calculateProductPricing(params: {
  costAmount: number;
  profitType: ProfitType;
  profitValue: number;
  commissionAmount?: number;
}): ProductPricingBreakdown {
  const safeCost = round2(Math.max(0, params.costAmount));
  const safeProfitVal = Math.max(0, Number.isFinite(params.profitValue) ? params.profitValue : 0);
  const safeCommission = round2(
    Math.max(0, Number.isFinite(params.commissionAmount ?? 0) ? (params.commissionAmount ?? 0) : 0)
  );

  const grossProfit =
    params.profitType === 'percent'
      ? calculateInterestCeil(safeCost, safeProfitVal)
      : round2(safeProfitVal);

  const saleTotal = round2(safeCost + grossProfit);
  const netProfit = round2(grossProfit - safeCommission);

  return {
    costAmount: safeCost,
    grossProfit,
    commissionAmount: safeCommission,
    netProfit,
    saleTotal,
  };
}

/**
 * Computes prorated interest over a 30-day base cycle, always rounded UP to the next whole integer.
 * Example: 890 * 7% at 30 days = ceil(62.30) = 63; at 20 days = ceil(41.5333) = 42; at 36 days = ceil(74.76) = 75.
 */
export function calculateProratedInterestCeil(
  baseAmount: number,
  interestRate: number,
  daysElapsed: number
): number {
  if (baseAmount <= 0 || interestRate <= 0 || daysElapsed <= 0) return 0;
  const exact =
    Math.round(((baseAmount * interestRate * daysElapsed) / (100 * 30)) * 10000) / 10000;
  return Math.ceil(exact);
}

export function toTimestampMillis(ts: unknown): number {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return ts;
  }
  if (ts instanceof Date) {
    return ts.getTime();
  }
  if (ts && typeof ts === 'object') {
    if ('toMillis' in ts && typeof (ts as { toMillis: unknown }).toMillis === 'function') {
      return (ts as { toMillis: () => number }).toMillis();
    }
    if ('seconds' in ts && typeof (ts as { seconds: unknown }).seconds === 'number') {
      return (ts as { seconds: number }).seconds * 1000;
    }
  }
  return 0;
}

/**
 * Exact calendar-day difference in local dates (immune to hour-of-day shifts or DST).
 */
export function calculateCalendarDaysElapsed(
  startMs: number,
  nowMs: number = Date.now()
): number {
  if (!startMs || startMs <= 0 || nowMs <= startMs) return 0;
  const start = new Date(startMs);
  const end = new Date(nowMs);
  const startDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endDay = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.max(0, Math.round((endDay - startDay) / 86_400_000));
}

export function getCreditLastActivityMs(
  credit: Pick<Credit, 'id' | 'createdAt' | 'lastPaymentAt' | 'interestMode'>,
  transactions: CreditTransaction[]
): number {
  let latestPaymentMs = 0;
  let earliestSaleMs = 0;

  for (const tx of transactions) {
    if (tx.creditId !== credit.id) continue;
    const ms = toTimestampMillis(tx.createdAt);
    if (ms <= 0) continue;
    if (tx.type === 'payment') {
      if (ms > latestPaymentMs) latestPaymentMs = ms;
    } else if (tx.type === 'sale' || tx.type === 'credit') {
      if (earliestSaleMs === 0 || ms < earliestSaleMs) earliestSaleMs = ms;
    }
  }

  const creditPaymentMs = toTimestampMillis(credit.lastPaymentAt);
  const bestPaymentMs = Math.max(latestPaymentMs, creditPaymentMs);
  if (bestPaymentMs > 0) return bestPaymentMs;

  if (credit.interestMode === 'closed' && earliestSaleMs > 0) {
    return earliestSaleMs;
  }

  const createdMs = toTimestampMillis(credit.createdAt);
  return createdMs > 0 ? createdMs : Date.now();
}

export interface LiveCreditStatus {
  baseBalance: number;
  lastActivityMs: number;
  daysElapsed: number;
  accruedInterest: number;
  totalDueToday: number;
  projected30DayInterest: number;
  projected30DayTotal: number;
  isProratedDaily: boolean;
  isClosedCredit: boolean;
  isFrozen: boolean;
}

export function calculateLiveCreditStatus(
  credit: Credit,
  transactions: CreditTransaction[],
  nowMs: number = Date.now()
): LiveCreditStatus {
  const baseBalance = round2(Math.max(0, credit.currentBalance));
  const isClosedCredit = credit.interestMode === 'closed';
  const isProratedDaily = credit.interestMode === 'prorated_daily';
  const isFrozen =
    credit.frozenAt != null ||
    typeof credit.frozenDays === 'number' ||
    typeof credit.frozenAccruedInterest === 'number';

  if (credit.status !== 'active' || baseBalance <= 0) {
    return {
      baseBalance: 0,
      lastActivityMs: 0,
      daysElapsed: 0,
      accruedInterest: 0,
      totalDueToday: 0,
      projected30DayInterest: 0,
      projected30DayTotal: 0,
      isProratedDaily,
      isClosedCredit,
      isFrozen,
    };
  }

  const lastActivityMs = getCreditLastActivityMs(credit, transactions);

  if (isFrozen) {
    const frozenDays = Math.max(0, Math.round(credit.frozenDays ?? 0));
    const frozenInterest = isClosedCredit
      ? 0
      : round2(Math.max(0, credit.frozenAccruedInterest ?? 0));
    const totalDueToday = round2(baseBalance + frozenInterest);
    return {
      baseBalance,
      lastActivityMs,
      daysElapsed: frozenDays,
      accruedInterest: frozenInterest,
      totalDueToday,
      projected30DayInterest: 0,
      projected30DayTotal: totalDueToday,
      isProratedDaily,
      isClosedCredit,
      isFrozen: true,
    };
  }

  const daysElapsed = calculateCalendarDaysElapsed(lastActivityMs, nowMs);

  // Closed credits (Maestros & future product modules): zero monthly/daily interest on balance
  if (isClosedCredit) {
    return {
      baseBalance,
      lastActivityMs,
      daysElapsed,
      accruedInterest: 0,
      totalDueToday: baseBalance,
      projected30DayInterest: 0,
      projected30DayTotal: baseBalance,
      isProratedDaily: false,
      isClosedCredit: true,
      isFrozen: false,
    };
  }

  if (isProratedDaily) {
    const accruedInterest = calculateProratedInterestCeil(
      baseBalance,
      credit.interestRate,
      daysElapsed
    );
    const totalDueToday = round2(baseBalance + accruedInterest);
    const projected30DayInterest = calculateInterestCeil(baseBalance, credit.interestRate);
    const projected30DayTotal = round2(baseBalance + projected30DayInterest);
    return {
      baseBalance,
      lastActivityMs,
      daysElapsed,
      accruedInterest,
      totalDueToday,
      projected30DayInterest,
      projected30DayTotal,
      isProratedDaily: true,
      isClosedCredit: false,
      isFrozen: false,
    };
  }

  // Legacy pre-added credit: first 30 days are already included in currentBalance; after day 30, extra days accrue.
  const extraDays = Math.max(0, daysElapsed - 30);
  const accruedInterest =
    extraDays > 0
      ? calculateProratedInterestCeil(baseBalance, credit.interestRate, extraDays)
      : 0;
  return {
    baseBalance,
    lastActivityMs,
    daysElapsed,
    accruedInterest,
    totalDueToday: round2(baseBalance + accruedInterest),
    projected30DayInterest: 0,
    projected30DayTotal: baseBalance,
    isProratedDaily: false,
    isClosedCredit: false,
    isFrozen: false,
  };
}

export type ModuleOverdueTier = 'normal' | 'orange' | 'red';
export type PortalAgingTier = 'green' | 'orange' | 'red';

export function getModuleOverdueTier(daysElapsed: number): ModuleOverdueTier {
  if (daysElapsed >= 30) return 'red';
  if (daysElapsed >= 25) return 'orange';
  return 'normal';
}

export function getPortalAgingTier(daysElapsed: number): PortalAgingTier {
  if (daysElapsed >= 30) return 'red';
  if (daysElapsed >= 20) return 'orange';
  return 'green';
}

export interface OverdueClientAlert {
  key: string;
  moduleId: string;
  moduleLabel: string;
  client: Client;
  maxDaysWithoutPayment: number;
  overdueCreditsCount: number;
  totalNio: number;
  totalUsd: number;
  credits: Credit[];
  transactions: CreditTransaction[];
}

export function buildOverdueClientAlerts(params: {
  moduleId: string;
  moduleLabel: string;
  clients: Client[];
  credits: Credit[];
  transactions: CreditTransaction[];
  nowMs?: number;
}): OverdueClientAlert[] {
  const { moduleId, moduleLabel, clients, credits, transactions, nowMs = Date.now() } = params;
  const activeClientMap = new Map<string, Client>();
  for (const client of clients) {
    const clientModule = client.moduleId || 'credit_cash';
    if (
      clientModule === moduleId &&
      client.active !== false &&
      client.portfolioStatus !== 'castigada'
    ) {
      activeClientMap.set(client.id, client);
    }
  }

  const creditsByClient = new Map<string, Credit[]>();
  for (const cr of credits) {
    if (!activeClientMap.has(cr.clientId)) continue;
    const list = creditsByClient.get(cr.clientId) || [];
    list.push(cr);
    creditsByClient.set(cr.clientId, list);
  }

  const txsByClient = new Map<string, CreditTransaction[]>();
  for (const tx of transactions) {
    if (!activeClientMap.has(tx.clientId)) continue;
    const list = txsByClient.get(tx.clientId) || [];
    list.push(tx);
    txsByClient.set(tx.clientId, list);
  }

  const alerts: OverdueClientAlert[] = [];

  for (const [clientId, client] of activeClientMap.entries()) {
    const clientCredits = creditsByClient.get(clientId) || [];
    const clientTxs = txsByClient.get(clientId) || [];

    let maxDays = 0;
    let overdueCount = 0;
    let totalNio = 0;
    let totalUsd = 0;

    for (const cr of clientCredits) {
      if (cr.status !== 'active' || cr.currentBalance <= 0) continue;
      const live = calculateLiveCreditStatus(cr, clientTxs, nowMs);
      if (cr.currency === 'NIO') totalNio = round2(totalNio + live.totalDueToday);
      else totalUsd = round2(totalUsd + live.totalDueToday);

      if (live.daysElapsed >= 30) {
        overdueCount += 1;
        if (live.daysElapsed > maxDays) maxDays = live.daysElapsed;
      }
    }

    if (overdueCount > 0) {
      alerts.push({
        key: `${moduleId}:${client.id}`,
        moduleId,
        moduleLabel,
        client,
        maxDaysWithoutPayment: maxDays,
        overdueCreditsCount: overdueCount,
        totalNio,
        totalUsd,
        credits: clientCredits,
        transactions: clientTxs,
      });
    }
  }

  alerts.sort((a, b) => b.maxDaysWithoutPayment - a.maxDaysWithoutPayment);
  return alerts;
}

export interface PaymentCalculationResult {
  remainingBeforeInterest: number;
  interestAdded: number;
  newBalance: number;
  settled: boolean;
}

/**
 * Legacy pre-added balance calculation (kept for fallback on legacy credits).
 */
export function calculatePaymentOnBalance(
  currentBalance: number,
  paymentAmount: number,
  interestRate: number
): PaymentCalculationResult {
  const safeCurrent = round2(Math.max(0, currentBalance));
  const safePayment = round2(Math.max(0, paymentAmount));
  const remainingBeforeInterest = round2(Math.max(0, safeCurrent - safePayment));

  if (remainingBeforeInterest <= 0) {
    return {
      remainingBeforeInterest: 0,
      interestAdded: 0,
      newBalance: 0,
      settled: true,
    };
  }

  const interestAdded = calculateInterestCeil(remainingBeforeInterest, interestRate);
  const newBalance = round2(remainingBeforeInterest + interestAdded);

  return {
    remainingBeforeInterest,
    interestAdded,
    newBalance,
    settled: false,
  };
}

export interface ProratedPaymentResult {
  baseBalance: number;
  daysElapsed: number;
  accruedInterest: number;
  totalDueToday: number;
  newBalance: number;
  settled: boolean;
}

/**
 * Prorated daily balance settlement:
 * 1. Compute accrued interest up to the exact payment day (rounded UP).
 * 2. Total due today = baseBalance + accruedInterest.
 * 3. Subtract payment -> remaining amount becomes the new capital base starting at Day 0.
 */
export function calculateProratedPayment(
  baseBalance: number,
  interestRate: number,
  daysElapsed: number,
  paymentAmount: number
): ProratedPaymentResult {
  const safeBase = round2(Math.max(0, baseBalance));
  const accruedInterest = calculateProratedInterestCeil(safeBase, interestRate, daysElapsed);
  const totalDueToday = round2(safeBase + accruedInterest);
  const safePayment = round2(Math.max(0, paymentAmount));
  const newBalance = round2(Math.max(0, totalDueToday - safePayment));

  return {
    baseBalance: safeBase,
    daysElapsed,
    accruedInterest,
    totalDueToday,
    newBalance,
    settled: newBalance <= 0,
  };
}

export interface CountryPhonePrefix {
  code: string;
  label: string;
  example: string;
}

export const COUNTRY_PHONE_PREFIXES: CountryPhonePrefix[] = [
  { code: '+505', label: 'NI +505', example: '+50576881122' },
  { code: '+1', label: 'EE.UU. +1', example: '+13055551234' },
  { code: '+506', label: 'CR +506', example: '+50688887777' },
  { code: '+507', label: 'PA +507', example: '+50761234567' },
  { code: '+34', label: 'ES +34', example: '+34612345678' },
];

export function cleanPhoneInput(rawPhone: string): string {
  // Strip invisible Unicode directional/control marks, spaces, hyphens, parentheses
  const stripped = rawPhone
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\s\-().]/g, '')
    .trim();
  if (!stripped) return '';
  const hasPlus = stripped.startsWith('+');
  const digits = stripped.replace(/\D/g, '');
  if (!digits) return hasPlus ? '+' : '';
  return hasPlus ? `+${digits}` : digits;
}

export interface PhoneValidationResult {
  valid: boolean;
  normalized: string;
  error?: string;
}

export function validateInternationalPhone(rawPhone: string): PhoneValidationResult {
  const cleaned = cleanPhoneInput(rawPhone);
  if (!cleaned) {
    return {
      valid: false,
      normalized: '',
      error: 'Ingresa el número de teléfono con código de país (ej. +50576881122, +1..., +506...).',
    };
  }

  if (!cleaned.startsWith('+')) {
    return {
      valid: false,
      normalized: cleaned,
      error:
        'Obligatorio: el teléfono debe iniciar con el código de país (+), por ejemplo +50576881122, +1..., +506..., +507... o +34...',
    };
  }

  const digits = cleaned.slice(1);
  if (!/^\d+$/.test(digits) || digits.length < 7) {
    return {
      valid: false,
      normalized: cleaned,
      error: 'Ingresa el prefijo del país (+) seguido del número completo de teléfono.',
    };
  }

  // Nicaragua (+505): always 8 digits after +505
  if (digits.startsWith('505')) {
    const local = digits.slice(3);
    if (local.length !== 8) {
      return {
        valid: false,
        normalized: cleaned,
        error: 'En Nicaragua (+505) el número debe tener exactamente 8 dígitos después de +505 (ej. +50576881122).',
      };
    }
    return { valid: true, normalized: `+${digits}` };
  }

  // EE.UU. / Canadá (+1): 10 digits after +1
  if (digits.startsWith('1')) {
    const local = digits.slice(1);
    if (local.length !== 10) {
      return {
        valid: false,
        normalized: cleaned,
        error: 'En EE.UU. (+1) el número debe tener 10 dígitos después de +1 (ej. +13055551234).',
      };
    }
    return { valid: true, normalized: `+${digits}` };
  }

  // Costa Rica (+506): 8 digits after +506
  if (digits.startsWith('506')) {
    const local = digits.slice(3);
    if (local.length !== 8) {
      return {
        valid: false,
        normalized: cleaned,
        error: 'En Costa Rica (+506) el número debe tener 8 dígitos después de +506 (ej. +50688887777).',
      };
    }
    return { valid: true, normalized: `+${digits}` };
  }

  // Panamá (+507): 7 or 8 digits after +507
  if (digits.startsWith('507')) {
    const local = digits.slice(3);
    if (local.length < 7 || local.length > 8) {
      return {
        valid: false,
        normalized: cleaned,
        error: 'En Panamá (+507) el número debe tener 7 u 8 dígitos después de +507.',
      };
    }
    return { valid: true, normalized: `+${digits}` };
  }

  // España (+34): 9 digits after +34
  if (digits.startsWith('34')) {
    const local = digits.slice(2);
    if (local.length !== 9) {
      return {
        valid: false,
        normalized: cleaned,
        error: 'En España (+34) el número debe tener 9 dígitos después de +34.',
      };
    }
    return { valid: true, normalized: `+${digits}` };
  }

  // Any other valid international E.164 number (+prefix + number, 8 to 15 digits total)
  if (digits.length < 8 || digits.length > 15) {
    return {
      valid: false,
      normalized: cleaned,
      error: 'El número internacional debe tener entre 8 y 15 dígitos en total después del +.',
    };
  }

  return { valid: true, normalized: `+${digits}` };
}

export function sanitizeWhatsAppPhone(rawPhone: string): string {
  const digits = rawPhone.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 8) {
    return `505${digits}`;
  }
  return digits;
}

export function buildWhatsAppInvoiceText(payload: InvoicePayload): string {
  const moduleTitle = payload.moduleLabel || 'Credit Cash';
  const greeting = `Hola! *${payload.clientName.trim() || 'Cliente'}*`;

  if (payload.kind === 'consolidated') {
    const items = payload.consolidatedItems || [];
    const lines: string[] = [
      greeting,
      `*Akrobit · ${moduleTitle}*`,
      '*Estado de cuenta consolidado*',
      '────────────────────────',
    ];

    items.forEach((item, idx) => {
      lines.push(`*${item.label}*`);
      if (item.interestMode === 'closed') {
        lines.push(`*Saldo pendiente: ${formatCurrency(item.currentBalance, item.currency)}*`);
      } else {
        lines.push(
          `Capital: ${formatCurrency(item.principal, item.currency)} (${item.interestRate}%)`
        );
        if (typeof item.daysElapsed === 'number' && (item.accruedInterest ?? 0) > 0) {
          lines.push(
            `Interés acumulado (${item.daysElapsed} días): + ${formatCurrency(item.accruedInterest ?? 0, item.currency)}`
          );
        }
        lines.push(`*Total pendiente al día: ${formatCurrency(item.currentBalance, item.currency)}*`);
      }
      if (idx < items.length - 1) {
        lines.push('');
      }
    });

    lines.push('────────────────────────', '*Total pendiente consolidado:*');
    if ((payload.totalNio ?? 0) > 0) {
      lines.push(`*${formatCurrency(payload.totalNio ?? 0, 'NIO')}*`);
    }
    if ((payload.totalUsd ?? 0) > 0) {
      lines.push(`*${formatCurrency(payload.totalUsd ?? 0, 'USD')}*`);
    }

    if (payload.portalUrl && payload.portalCode) {
      lines.push(
        '────────────────────────',
        'Consulta tu historial en tiempo real:',
        payload.portalUrl,
        `PIN: *${payload.portalCode}*`
      );
    }

    return lines.join('\n');
  }

  const subtitle =
    payload.kind === 'sale'
      ? '*Comprobante de compra*'
      : payload.kind === 'credit'
        ? '*Comprobante de crédito*'
        : '*Comprobante de abono*';

  const lines: string[] = [
    greeting,
    `*Akrobit · ${moduleTitle}*`,
    subtitle,
    '────────────────────────',
  ];

  if (payload.creditLabel && payload.kind !== 'sale') {
    lines.push(`Cuenta: *${payload.creditLabel}*`);
  }

  if (payload.kind === 'sale') {
    const qtySuffix =
      payload.quantitySold && payload.quantitySold > 1 ? ` (x${payload.quantitySold})` : '';
    if (payload.productName) {
      lines.push(`Detalle: ${payload.productName}${qtySuffix}`);
    }
    lines.push(
      `*Total: ${formatCurrency(payload.amount, payload.currency)}*`,
      `Saldo anterior: ${formatCurrency(payload.previousBalance, payload.currency)}`,
      `*Saldo actual: ${formatCurrency(payload.newBalance, payload.currency)}*`
    );
  } else if (payload.kind === 'credit') {
    if (payload.interestMode === 'prorated_daily') {
      const est30Interest =
        payload.projected30DayInterest ??
        calculateInterestCeil(payload.amount, payload.interestRate);
      const est30Total =
        payload.projected30DayTotal ?? round2(payload.amount + est30Interest);

      lines.push(
        `Capital otorgado: *${formatCurrency(payload.amount, payload.currency)}*`,
        `Tasa mensual (${payload.interestRate}% s/saldo): proporcional al día de pago`,
        `Referencia a 30 días: ${formatCurrency(est30Total, payload.currency)} (+${formatCurrency(est30Interest, payload.currency)})`
      );
    } else {
      const interestValue = round2(payload.newBalance - payload.amount);
      lines.push(
        `Capital otorgado: ${formatCurrency(payload.amount, payload.currency)}`,
        `Porcentaje (${payload.interestRate}%): ${formatCurrency(interestValue, payload.currency)}`,
        `*Total del crédito: ${formatCurrency(payload.newBalance, payload.currency)}*`
      );
    }
  } else if (payload.interestMode === 'closed') {
    lines.push(
      `Saldo anterior: ${formatCurrency(payload.previousBalance, payload.currency)}`,
      `Abono realizado: - ${formatCurrency(payload.amount, payload.currency)}`
    );
    if (payload.newBalance <= 0) {
      lines.push('*Estado: CUENTA LIQUIDADA (Saldo 0.00)*');
    } else {
      lines.push(`*Nuevo saldo actual: ${formatCurrency(payload.newBalance, payload.currency)}*`);
    }
  } else if (payload.interestMode === 'prorated_daily') {
    const days = payload.daysElapsed ?? 0;
    const accrued = payload.accruedInterest ?? 0;
    const totalDay = payload.totalDueToday ?? round2(payload.previousBalance + accrued);

    lines.push(
      `Capital anterior: ${formatCurrency(payload.previousBalance, payload.currency)}`,
      `Interés (${days} día${days === 1 ? '' : 's'} al ${payload.interestRate}%): + ${formatCurrency(accrued, payload.currency)}`,
      `Total exigible al día: ${formatCurrency(totalDay, payload.currency)}`,
      `Abono realizado: - ${formatCurrency(payload.amount, payload.currency)}`
    );
    if (payload.newBalance <= 0) {
      lines.push('*Estado: CRÉDITO LIQUIDADO (Saldo 0.00)*');
    } else {
      lines.push(`*Nuevo saldo capital: ${formatCurrency(payload.newBalance, payload.currency)}*`);
    }
  } else {
    lines.push(
      `Saldo anterior: ${formatCurrency(payload.previousBalance, payload.currency)}`,
      `Abono realizado: ${formatCurrency(payload.amount, payload.currency)}`
    );
    if ((payload.remainingBeforeInterest ?? 0) > 0) {
      lines.push(
        `Saldo restante: ${formatCurrency(payload.remainingBeforeInterest ?? 0, payload.currency)}`,
        `Interés s/saldo (${payload.interestRate}%): ${formatCurrency(payload.interestAdded ?? 0, payload.currency)}`,
        `*Nuevo saldo actual: ${formatCurrency(payload.newBalance, payload.currency)}*`
      );
    } else {
      lines.push('*Estado: CRÉDITO LIQUIDADO (Saldo 0.00)*');
    }
  }

  if (payload.portalUrl && payload.portalCode) {
    lines.push(
      '────────────────────────',
      'Consulta tu historial en tiempo real:',
      payload.portalUrl,
      `PIN: *${payload.portalCode}*`
    );
  }

  return lines.join('\n');
}

export function buildWhatsAppLink(rawPhone: string, message: string): string {
  const cleanPhone = sanitizeWhatsAppPhone(rawPhone);
  const encoded = encodeURIComponent(message);
  return cleanPhone ? `https://wa.me/${cleanPhone}?text=${encoded}` : `https://wa.me/?text=${encoded}`;
}

export function isAndroidDevice(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

/**
 * On Android devices, prioritizes WhatsApp Business (com.whatsapp.w4b) directly via Intent URI
 * with automatic browser fallback to wa.me if WhatsApp Business is not installed.
 */
export function buildWhatsAppBusinessLink(rawPhone: string, message: string): string {
  const fallbackUrl = buildWhatsAppLink(rawPhone, message);
  if (!isAndroidDevice()) {
    return fallbackUrl;
  }
  const cleanPhone = sanitizeWhatsAppPhone(rawPhone);
  const encoded = encodeURIComponent(message);
  const query = cleanPhone ? `phone=${cleanPhone}&text=${encoded}` : `text=${encoded}`;
  return `intent://send?${query}#Intent;scheme=whatsapp;package=com.whatsapp.w4b;S.browser_fallback_url=${encodeURIComponent(fallbackUrl)};end`;
}

export function generateDocId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 14)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}_${rand}`;
}
