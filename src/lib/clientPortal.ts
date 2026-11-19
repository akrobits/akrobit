import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
  type WriteBatch,
} from 'firebase/firestore';
import { ORG_ID, db } from './firebase';
import { calculateLiveCreditStatus, cleanPhoneInput, round2 } from './finance';
import type {
  Client,
  ClientPortalSnapshot,
  Credit,
  CreditTransaction,
  PortfolioStatus,
  PortalCreditItem,
  PortalTransactionItem,
} from '../types';

export const AKROBIT_BUSINESS_PHONE = '+50576881122';
export const AKROBIT_CATALOG_URL = 'https://wa.me/c/50576881122';
export const AKROBIT_PRIMARY_DOMAIN = 'akrobit.app';
export const AKROBIT_WWW_DOMAIN = 'www.akrobit.app';
export const AKROBIT_OFFICIAL_DOMAINS = [
  AKROBIT_PRIMARY_DOMAIN,
  AKROBIT_WWW_DOMAIN,
] as const;
export const AKROBIT_CANONICAL_ORIGIN = `https://${AKROBIT_WWW_DOMAIN}`;
export const AKROBIT_PORTAL_URL = `${AKROBIT_CANONICAL_ORIGIN}/micuenta`;

export function isOfficialAkrobitDomain(hostname?: string): boolean {
  const target = (
    hostname ?? (typeof window !== 'undefined' ? window.location.hostname : '')
  ).toLowerCase();
  return target === AKROBIT_PRIMARY_DOMAIN || target === AKROBIT_WWW_DOMAIN;
}

function getTimestampMillis(ts: unknown): number {
  if (ts && typeof ts === 'object' && 'toMillis' in ts) {
    return (ts as { toMillis: () => number }).toMillis();
  }
  return Date.now();
}

export function formatPortalDateTime(ts: unknown): string {
  try {
    if (ts && typeof ts === 'object' && 'toDate' in ts) {
      return (ts as { toDate: () => Date })
        .toDate()
        .toLocaleString('es-NI', { dateStyle: 'short', timeStyle: 'short' })
        .slice(0, 60);
    }
  } catch {
    // Fallback to current date
  }
  return new Date()
    .toLocaleString('es-NI', { dateStyle: 'short', timeStyle: 'short' })
    .slice(0, 60);
}

export function isClientPortalRoute(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const normalizedPath = window.location.pathname.replace(/\/+$/, '').toLowerCase();
    return (
      params.has('micuenta') ||
      params.has('mi-cuenta') ||
      normalizedPath === '/micuenta' ||
      normalizedPath === '/mi-cuenta'
    );
  } catch {
    return false;
  }
}

export function getPublicPortalUrl(): string {
  return AKROBIT_PORTAL_URL;
}

export function buildClientPortalAccessMessage(
  clientName: string,
  phone: string,
  portalCode: string
): string {
  const safeName = clientName.trim() || 'estimado cliente';
  return [
    `Hola! *${safeName}*`,
    'Consulta tu saldo y movimientos en tiempo real:',
    getPublicPortalUrl(),
    `Teléfono: ${phone}`,
    `PIN: *${portalCode}*`,
  ].join('\n');
}

/**
 * Generates an unpredictable 6-digit numeric secret code completely unrelated to the phone number.
 */
export function generatePortalCode(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return String(arr[0] % 1_000_000).padStart(6, '0');
  }
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

/**
 * Normalizes phone input entered by customers in the portal or saved by team members.
 * Defaults 8-digit local Nicaraguan numbers to +505 so clients can type either 76881122 or +50576881122.
 */
export function normalizePortalPhoneInput(rawPhone: string): string {
  const cleaned = cleanPhoneInput(rawPhone);
  if (!cleaned) return '';
  if (cleaned.startsWith('+')) return cleaned;
  if (/^\d{8}$/.test(cleaned)) {
    return `+505${cleaned}`;
  }
  if (/^\d{9,15}$/.test(cleaned)) {
    return `+${cleaned}`;
  }
  return cleaned;
}

/**
 * Derives the 64-character lowercase SHA-256 hex key used as the Firestore document ID
 * for /clientPortals/{portalKey}. Without both exact phone and 6-digit code, the doc cannot be read.
 */
export async function computePortalKey(
  rawPhone: string,
  portalCode: string
): Promise<string> {
  const normalizedPhone = normalizePortalPhoneInput(rawPhone);
  const cleanCode = portalCode.replace(/\D/g, '').slice(0, 6);
  const material = `${normalizedPhone}:${cleanCode}:akrobit-portal-v1`;

  const encoded = new TextEncoder().encode(material);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function buildClientPortalPayload(
  portalKey: string,
  clientId: string,
  clientName: string,
  credits: Credit[],
  transactions: CreditTransaction[],
  portfolioStatus: PortfolioStatus = 'active'
): ClientPortalSnapshot {
  const allClientCreditsSorted = credits
    .filter((c) => c.clientId === clientId)
    .sort((a, b) => getTimestampMillis(a.createdAt) - getTimestampMillis(b.createdAt));

  const creditLabelById = new Map<string, string>();
  allClientCreditsSorted.forEach((cr, idx) => {
    creditLabelById.set(cr.id, `Credit Cash N°${idx + 1}`);
  });

  const activeSorted = allClientCreditsSorted
    .filter((c) => c.status === 'active' && c.currentBalance > 0)
    .slice(0, 50);

  let totalNio = 0;
  let totalUsd = 0;
  const activeCredits: PortalCreditItem[] = activeSorted.map((c, idx) => {
    const live = calculateLiveCreditStatus(c, transactions);
    if (c.currency === 'NIO') totalNio = round2(totalNio + live.totalDueToday);
    else totalUsd = round2(totalUsd + live.totalDueToday);

    return {
      label: (creditLabelById.get(c.id) || `Credit Cash N°${idx + 1}`).slice(0, 60),
      currency: c.currency,
      principal: round2(c.principal),
      interestRate: c.interestRate,
      currentBalance: live.baseBalance,
      dateLabel: formatPortalDateTime(c.createdAt),
      lastActivityMs: live.lastActivityMs,
      interestMode: c.interestMode || 'pre_added',
      projected30DayInterest: live.projected30DayInterest,
      projected30DayTotal: live.projected30DayTotal,
      ...(live.isFrozen
        ? {
            isFrozen: true,
            frozenDays: live.daysElapsed,
            frozenAccruedInterest: live.accruedInterest,
          }
        : {}),
    };
  });

  const sortedTxs = transactions
    .filter((t) => t.clientId === clientId)
    .sort((a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt))
    .slice(0, 100);

  const recentTransactions: PortalTransactionItem[] = sortedTxs.map((tx) => {
    const cleanNote = (tx.note || '').trim().slice(0, 240);
    return {
      type: tx.type,
      currency: tx.currency,
      amount: round2(Math.max(0, tx.amount)),
      interestRate: tx.interestRate,
      previousBalance: round2(Math.max(0, tx.previousBalance)),
      newBalance: round2(Math.max(0, tx.newBalance)),
      ...(cleanNote ? { note: cleanNote } : {}),
      dateLabel: formatPortalDateTime(tx.createdAt),
    };
  });

  return {
    id: portalKey,
    clientId,
    clientName: clientName.trim().slice(0, 120) || 'Cliente Akrobit',
    orgId: ORG_ID,
    totalNio: round2(Math.max(0, totalNio)),
    totalUsd: round2(Math.max(0, totalUsd)),
    activeCredits,
    recentTransactions,
    portfolioStatus,
    updatedAt: serverTimestamp(),
  };
}

export function attachPortalSnapshotToBatch(
  batch: WriteBatch,
  portalKey: string,
  clientId: string,
  clientName: string,
  credits: Credit[],
  transactions: CreditTransaction[],
  portfolioStatus: PortfolioStatus = 'active'
): void {
  const payload = buildClientPortalPayload(
    portalKey,
    clientId,
    clientName,
    credits,
    transactions,
    portfolioStatus
  );
  batch.set(doc(db, 'clientPortals', portalKey), payload);
}

/**
 * Ensures a client has a portalCode + portalKey and keeps /clientPortals/{portalKey} up to date.
 * Useful both for auto-provisioning legacy clients and updating after admin approval.
 */
export async function syncClientPortalFromServer(clientId: string): Promise<void> {
  const clientRef = doc(db, 'clients', clientId);
  const clientSnap = await getDoc(clientRef);
  if (!clientSnap.exists()) return;

  const client = clientSnap.data() as Client;
  if (client.active === false) {
    if (client.portalKey) {
      const batch = writeBatch(db);
      batch.delete(doc(db, 'clientPortals', client.portalKey));
      await batch.commit();
    }
    return;
  }

  const portalCode = client.portalCode || generatePortalCode();
  const portalKey =
    client.portalKey || (await computePortalKey(client.phone, portalCode));

  const [creditsSnap, txsSnap] = await Promise.all([
    getDocs(
      query(
        collection(db, 'credits'),
        where('orgId', '==', ORG_ID),
        where('clientId', '==', clientId)
      )
    ),
    getDocs(
      query(
        collection(db, 'transactions'),
        where('orgId', '==', ORG_ID),
        where('clientId', '==', clientId)
      )
    ),
  ]);

  const credits = creditsSnap.docs.map((d) => d.data() as Credit);
  const transactions = txsSnap.docs.map((d) => d.data() as CreditTransaction);

  const batch = writeBatch(db);
  if (client.portalCode !== portalCode || client.portalKey !== portalKey) {
    batch.update(clientRef, {
      portalCode,
      portalKey,
      updatedAt: serverTimestamp(),
    });
  }
  attachPortalSnapshotToBatch(
    batch,
    portalKey,
    client.id,
    client.name,
    credits,
    transactions,
    client.portfolioStatus || 'active'
  );
  await batch.commit();
}

/**
 * Generates a brand-new 6-digit code for a client, deleting the previous portal snapshot atomically.
 */
export async function regenerateClientPortalCredentials(
  client: Client,
  clientCredits: Credit[],
  clientTransactions: CreditTransaction[]
): Promise<{ portalCode: string; portalKey: string }> {
  const newCode = generatePortalCode();
  const newKey = await computePortalKey(client.phone, newCode);

  const batch = writeBatch(db);
  if (client.portalKey && client.portalKey !== newKey) {
    batch.delete(doc(db, 'clientPortals', client.portalKey));
  }
  batch.update(doc(db, 'clients', client.id), {
    portalCode: newCode,
    portalKey: newKey,
    updatedAt: serverTimestamp(),
  });
  attachPortalSnapshotToBatch(
    batch,
    newKey,
    client.id,
    client.name,
    clientCredits,
    clientTransactions,
    client.portfolioStatus || 'active'
  );

  await Promise.race([
    batch.commit(),
    new Promise<void>((resolve) => setTimeout(resolve, 1200)),
  ]);

  return { portalCode: newCode, portalKey: newKey };
}
