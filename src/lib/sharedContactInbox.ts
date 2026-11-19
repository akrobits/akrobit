import {
  parseSharedTextContact,
  parseVCards,
  type ContactCandidate,
} from './contactsAdapter';

const SHARE_CACHE_NAME = 'akrobit-shared-contact-v1';
const SHARE_CACHE_KEY = '/_shared_contact_payload.json';

interface RawSharedPayload {
  vcardsText?: string;
  title?: string;
  text?: string;
  url?: string;
  receivedAt?: number;
}

export async function consumePendingSharedContacts(): Promise<ContactCandidate[]> {
  if (typeof window === 'undefined') return [];

  // Clean URL marker (?sharedContact=1) if present
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('sharedContact')) {
      url.searchParams.delete('sharedContact');
      window.history.replaceState(
        window.history.state ?? {},
        '',
        url.pathname + url.search + url.hash
      );
    }
  } catch {
    // Ignore URL errors
  }

  if (!('caches' in window)) return [];

  try {
    const cache = await caches.open(SHARE_CACHE_NAME);
    const match = await cache.match(SHARE_CACHE_KEY);
    if (!match) return [];

    const data = (await match.json()) as RawSharedPayload;
    await cache.delete(SHARE_CACHE_KEY);

    if (data.vcardsText && data.vcardsText.trim().length > 0) {
      const parsed = parseVCards(data.vcardsText);
      if (parsed.length > 0) return parsed;
    }

    const fromText = parseSharedTextContact(data.title || '', data.text || '');
    return fromText ? [fromText] : [];
  } catch {
    return [];
  }
}
