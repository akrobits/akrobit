import { cleanPhoneInput } from './finance';

export type ContactSourceType = 'google' | 'vcf' | 'device' | 'android-native';

export interface ContactCandidate {
  id: string;
  name: string;
  phones: string[];
  source: ContactSourceType;
}

export interface NativeContactsBridge {
  isAvailable?: () => boolean;
  pickContact?: () => Promise<{ name?: string; phones?: string[] } | null>;
  listContacts?: () => Promise<Array<{ id?: string; name?: string; phones?: string[] }>>;
}

declare global {
  interface Window {
    AkrobitNativeContacts?: NativeContactsBridge;
  }
}

export function hasNativeApkContactsBridge(): boolean {
  if (typeof window === 'undefined') return false;
  const bridge = window.AkrobitNativeContacts;
  if (!bridge) return false;
  if (typeof bridge.isAvailable === 'function') {
    return bridge.isAvailable();
  }
  return typeof bridge.listContacts === 'function' || typeof bridge.pickContact === 'function';
}

export async function readFromNativeApkContacts(): Promise<ContactCandidate[]> {
  const bridge = window.AkrobitNativeContacts;
  if (!bridge) return [];

  if (typeof bridge.listContacts === 'function') {
    const items = await bridge.listContacts();
    return items
      .map((item, index) => ({
        id: item.id || `native_${index}`,
        name: (item.name || '').trim(),
        phones: (item.phones || []).map((p) => p.trim()).filter(Boolean),
        source: 'android-native' as const,
      }))
      .filter((c) => c.name || c.phones.length > 0);
  }

  if (typeof bridge.pickContact === 'function') {
    const item = await bridge.pickContact();
    if (!item) return [];
    const phones = (item.phones || []).map((p) => p.trim()).filter(Boolean);
    const name = (item.name || '').trim();
    if (!name && phones.length === 0) return [];
    return [{ id: 'native_picked', name, phones, source: 'android-native' }];
  }

  return [];
}

function decodeQuotedPrintableUtf8(input: string): string {
  const cleaned = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i += 1) {
    if (cleaned[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
      bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = cleaned.charCodeAt(i);
      if (code < 128) {
        bytes.push(code);
      } else {
        const encoded = new TextEncoder().encode(cleaned[i]);
        for (const b of encoded) bytes.push(b);
      }
    }
  }
  try {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  } catch {
    return input;
  }
}

function unfoldVCardLines(rawText: string): string[] {
  // Handle Quoted-Printable soft line breaks ('=' at end of line) AND RFC line folding (leading space/tab)
  const rawLines = rawText.split(/\r?\n/);
  const unfolded: string[] = [];

  for (const line of rawLines) {
    if (unfolded.length > 0 && (/^[ \t]/.test(line) || /=$/.test(unfolded[unfolded.length - 1]))) {
      const prev = unfolded[unfolded.length - 1];
      if (/=$/.test(prev)) {
        unfolded[unfolded.length - 1] = prev.slice(0, -1) + line;
      } else {
        unfolded[unfolded.length - 1] = prev + line.slice(1);
      }
    } else {
      unfolded.push(line);
    }
  }

  return unfolded;
}

function parseSingleVCardBlock(blockText: string, index: number): ContactCandidate | null {
  const lines = unfoldVCardLines(blockText);
  let fullName = '';
  let structuredName = '';
  const phones: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || /^BEGIN:VCARD/i.test(line) || /^END:VCARD/i.test(line)) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const propHeader = line.slice(0, colonIdx).toUpperCase();
    const rawValue = line.slice(colonIdx + 1).trim();
    if (!rawValue) continue;

    const propBase = propHeader.split(';')[0].replace(/^ITEM\d+\./, '');
    const isQP = propHeader.includes('QUOTED-PRINTABLE');
    const decodedValue = isQP ? decodeQuotedPrintableUtf8(rawValue) : rawValue;

    if (propBase === 'FN' && !fullName) {
      fullName = decodedValue.replace(/\\([,;:\\])/g, '$1').trim();
    } else if (propBase === 'N' && !structuredName) {
      const parts = decodedValue
        .split(';')
        .map((p) => p.replace(/\\([,;:\\])/g, '$1').trim())
        .filter(Boolean);
      // vCard N is Family;Given;Middle;Prefix;Suffix
      if (parts.length >= 2) {
        structuredName = [parts[1], parts[2], parts[0]].filter(Boolean).join(' ').trim();
      } else if (parts.length === 1) {
        structuredName = parts[0];
      }
    } else if (propBase === 'TEL') {
      const telVal = decodedValue.replace(/^tel:/i, '').trim();
      if (telVal) {
        phones.push(telVal);
      }
    }
  }

  const name = fullName || structuredName;
  const uniquePhones = Array.from(
    new Map(
      phones.map((p) => {
        const key = cleanPhoneInput(p) || p;
        return [key, p] as const;
      })
    ).values()
  );

  // Prefer '+' international numbers first
  uniquePhones.sort(
    (a, b) => Number(cleanPhoneInput(b).startsWith('+')) - Number(cleanPhoneInput(a).startsWith('+'))
  );

  if (!name && uniquePhones.length === 0) return null;

  return {
    id: `vcf_${index}`,
    name: name || uniquePhones[0] || '',
    phones: uniquePhones,
    source: 'vcf',
  };
}

export function parseVCards(rawText: string): ContactCandidate[] {
  const normalized = rawText.trim();
  if (!normalized) return [];

  const matches = normalized.match(/BEGIN:VCARD[\s\S]*?END:VCARD/gi);
  const blocks = matches && matches.length > 0 ? matches : [normalized];

  const results: ContactCandidate[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const parsed = parseSingleVCardBlock(blocks[i], i);
    if (parsed) {
      results.push(parsed);
    }
  }
  return results;
}

export function parseSharedTextContact(title: string, text: string): ContactCandidate | null {
  const combined = [title, text].filter(Boolean).join('\n').trim();
  if (!combined) return null;

  // If shared text looks like a vCard, parse it directly
  if (/BEGIN:VCARD/i.test(combined) || /^TEL[:;]/im.test(combined)) {
    const cards = parseVCards(combined);
    if (cards.length > 0) return cards[0];
  }

  const phoneMatch = combined.match(/(\+?\d[\d\s\-().]{6,}\d)/);
  const phone = phoneMatch ? phoneMatch[1].trim() : '';
  const nameLine = combined
    .replace(phone, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 1 && !/^https?:\/\//i.test(l));

  if (!nameLine && !phone) return null;

  return {
    id: 'shared_text_0',
    name: nameLine || '',
    phones: phone ? [phone] : [],
    source: 'vcf',
  };
}

export function detectBrowserContext(): {
  inIframe: boolean;
  isStandalonePwa: boolean;
  isCustomTab: boolean;
  label: string;
} {
  if (typeof window === 'undefined') {
    return { inIframe: false, isStandalonePwa: false, isCustomTab: false, label: 'Navegador' };
  }

  const inIframe = window.self !== window.top;
  const ua = navigator.userAgent || '';
  const iosStandalone =
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  const displayStandalone = window.matchMedia('(display-mode: standalone)').matches;

  // Android Custom Tabs (Chrome / Edge when launched from a chat link) sometimes report display-mode: standalone
  // or carry an android-app:// document.referrer. Guard against false PWA positive in Edge Custom Tabs.
  const hasAndroidAppReferrer =
    typeof document !== 'undefined' && document.referrer.startsWith('android-app://');
  const isEdgeAndroid = /EdgA\//i.test(ua);
  const likelyCustomTab =
    hasAndroidAppReferrer ||
    (isEdgeAndroid && displayStandalone && !iosStandalone && window.history.length <= 2);

  const isStandalonePwa = (iosStandalone || displayStandalone) && !likelyCustomTab;

  const label = inIframe
    ? 'Vista incrustada'
    : likelyCustomTab
      ? isEdgeAndroid
        ? 'Pestaña Edge'
        : 'Pestaña rápida'
      : isStandalonePwa
        ? 'App instalada (PWA)'
        : /SamsungBrowser/i.test(ua)
          ? 'Samsung Internet'
          : isEdgeAndroid
            ? 'Microsoft Edge'
            : 'Google Chrome';

  return { inIframe, isStandalonePwa, isCustomTab: likelyCustomTab, label };
}
