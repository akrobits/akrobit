import type { CurrencyCode, InvoicePayload } from '../types';

export const INTEREST_RATE_OPTIONS = [5, 6, 7, 8, 9, 10] as const;

export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
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

export interface PaymentCalculationResult {
  remainingBeforeInterest: number;
  interestAdded: number;
  newBalance: number;
  settled: boolean;
}

/**
 * Credit-on-remaining-balance calculation:
 * 1. Subtract payment from currentBalance.
 * 2. If remaining <= 0 -> settled (balance = 0, no interest charged on 0).
 * 3. Otherwise -> compute selected interestRate% rounded UP to the next whole integer, and add it.
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
  if (payload.kind === 'consolidated') {
    const items = payload.consolidatedItems || [];
    const lines: string[] = [
      '*Akrobit · Credit Cash*',
      '*Estado de cuenta consolidado*',
      '────────────────────────',
      `Fecha: ${payload.dateLabel}`,
      `Cliente: ${payload.clientName}`,
      '────────────────────────',
    ];

    items.forEach((item, idx) => {
      lines.push(
        `*${item.label}*`,
        `Fecha crédito: ${item.dateLabel}`,
        `Moneda: ${item.currency === 'NIO' ? 'Córdobas (C$)' : 'Dólares (USD)'}`,
        `Capital: ${formatCurrency(item.principal, item.currency)} (${item.interestRate}%)`,
        `*Saldo pendiente: ${formatCurrency(item.currentBalance, item.currency)}*`
      );
      if (idx < items.length - 1) {
        lines.push('');
      }
    });

    lines.push('────────────────────────', '*Total pendiente consolidado:*');
    if ((payload.totalNio ?? 0) > 0) {
      lines.push(`*Córdobas: ${formatCurrency(payload.totalNio ?? 0, 'NIO')}*`);
    }
    if ((payload.totalUsd ?? 0) > 0) {
      lines.push(`*Dólares: ${formatCurrency(payload.totalUsd ?? 0, 'USD')}*`);
    }

    if (payload.portalUrl && payload.portalCode) {
      lines.push(
        '────────────────────────',
        'Consulta tu historial en vivo:',
        payload.portalUrl,
        `Código de acceso: *${payload.portalCode}*`
      );
    }

    lines.push('────────────────────────', 'https://wa.me/c/50576881122');

    return lines.join('\n');
  }

  const lines: string[] = [
    '*Akrobit · Credit Cash*',
    payload.kind === 'credit' ? '*Comprobante de crédito*' : '*Comprobante de abono*',
    '────────────────────────',
    `Fecha: ${payload.dateLabel}`,
    `Ref: ${payload.referenceId.slice(-8).toUpperCase()}`,
    `Cliente: ${payload.clientName}`,
  ];

  if (payload.creditLabel) {
    lines.push(`Cuenta: *${payload.creditLabel}*`);
  }

  lines.push(`Moneda: ${payload.currency === 'NIO' ? 'Córdobas (C$)' : 'Dólares (USD)'}`);

  if (payload.kind === 'credit') {
    const interestValue = round2(payload.newBalance - payload.amount);
    lines.push(
      `Capital otorgado: ${formatCurrency(payload.amount, payload.currency)}`,
      `Porcentaje (${payload.interestRate}%): ${formatCurrency(interestValue, payload.currency)}`,
      `*Total del crédito: ${formatCurrency(payload.newBalance, payload.currency)}*`
    );
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
      'Consulta tu historial en vivo:',
      payload.portalUrl,
      `Código de acceso: *${payload.portalCode}*`
    );
  }

  lines.push('────────────────────────', 'https://wa.me/c/50576881122');

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
