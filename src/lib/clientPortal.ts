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
import { cleanPhoneInput, round2 } from './finance';
import type {
  Client,
  ClientPortalSnapshot,
  Credit,
  CreditTransaction,
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
export const AKROBIT_CANONICAL_ORIGIN = `https://${AKROBIT_PRIMARY_DOMAIN}`;
export const AKROBIT_PORTAL_URL = `${AKROBIT_CANONICAL_ORIGIN}/?mi-cuenta`;

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
    const normalizedPath = window.location.pathname.replace(/\/+$/, '');
    return params.has('mi-cuenta') || normalizedPath === '/mi-cuenta';
  } catch {
    return false;
  }
}

export function getPublicPortalUrl(): string {
  return AKROBIT_PORTAL_URL;
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
  transactions: CreditTransaction[]
): ClientPortalSnapshot {
  const activeSorted = credits
    .filter((c) => c.clientId === clientId && c.status === 'active' && c.currentBalance > 0)
    .sort((a, b) => getTimestampMillis(a.createdAt) - getTimestampMillis(b.createdAt))
    .slice(0, 50);

  let totalNio = 0;
  let totalUsd = 0;
  const activeCredits: PortalCreditItem[] = activeSorted.map((c, idx) => {
    const safeBalance = round2(Math.max(0, c.currentBalance));
    if (c.currency === 'NIO') totalNio = round2(totalNio + safeBalance);
    else totalUsd = round2(totalUsd + safeBalance);

    return {
      label: `Credit Cash N°${idx + 1}`.slice(0, 60),
      currency: c.currency,
      principal: round2(c.principal),
      interestRate: c.interestRate,
      currentBalance: safeBalance,
      dateLabel: formatPortalDateTime(c.createdAt),
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
    updatedAt: serverTimestamp(),
  };
}

export function attachPortalSnapshotToBatch(
  batch: WriteBatch,
  portalKey: string,
  clientId: string,
  clientName: string,
  credits: Credit[],
  transactions: CreditTransaction[]
): void {
  const payload = buildClientPortalPayload(
    portalKey,
    clientId,
    clientName,
    credits,
    transactions
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
    transactions
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
    clientTransactions
  );

  await Promise.race([
    batch.commit(),
    new Promise<void>((resolve) => setTimeout(resolve, 1200)),
  ]);

  return { portalCode: newCode, portalKey: newKey };
}
