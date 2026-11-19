import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  inMemoryPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
  type Auth,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { auth as mainAuth } from './firebase';
import type { ContactCandidate } from './contactsAdapter';

export const GOOGLE_CONTACTS_SCOPES = ['https://www.googleapis.com/auth/contacts.readonly'] as const;

const CONTACTS_APP_NAME = 'akrobit-google-contacts';
const CONTACTS_IDB_NAME = 'akrobit_contacts_cache_v1';
const CONTACTS_IDB_STORE = 'directory';

// In-memory only token cache (never persisted to localStorage or sessionStorage)
let cachedContactsAccessToken: string | null = null;
let cachedGoogleAccountEmail: string | null = null;

export interface CachedDirectorySnapshot {
  akrobitUid: string;
  googleEmail: string | null;
  contacts: ContactCandidate[];
  updatedAt: number;
}

function openDirectoryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB no disponible'));
      return;
    }
    const req = indexedDB.open(CONTACTS_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(CONTACTS_IDB_STORE)) {
        database.createObjectStore(CONTACTS_IDB_STORE, { keyPath: 'akrobitUid' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('No se pudo abrir caché local'));
  });
}

export async function loadCachedContactsDirectory(
  akrobitUid: string
): Promise<CachedDirectorySnapshot | null> {
  if (!akrobitUid) return null;
  try {
    const database = await openDirectoryDb();
    return await new Promise((resolve) => {
      const tx = database.transaction(CONTACTS_IDB_STORE, 'readonly');
      const store = tx.objectStore(CONTACTS_IDB_STORE);
      const req = store.get(akrobitUid);
      req.onsuccess = () => {
        resolve((req.result as CachedDirectorySnapshot | undefined) || null);
      };
      req.onerror = () => resolve(null);
      tx.oncomplete = () => database.close();
    });
  } catch {
    return null;
  }
}

export async function saveCachedContactsDirectory(
  akrobitUid: string,
  googleEmail: string | null,
  contacts: ContactCandidate[]
): Promise<void> {
  if (!akrobitUid) return;
  try {
    const database = await openDirectoryDb();
    await new Promise<void>((resolve) => {
      const tx = database.transaction(CONTACTS_IDB_STORE, 'readwrite');
      const store = tx.objectStore(CONTACTS_IDB_STORE);
      store.put({
        akrobitUid,
        googleEmail,
        contacts,
        updatedAt: Date.now(),
      } satisfies CachedDirectorySnapshot);
      tx.oncomplete = () => {
        database.close();
        resolve();
      };
      tx.onerror = () => {
        database.close();
        resolve();
      };
    });
  } catch {
    // Ignore cache write errors
  }
}

export async function clearCachedContactsDirectory(): Promise<void> {
  try {
    const database = await openDirectoryDb();
    await new Promise<void>((resolve) => {
      const tx = database.transaction(CONTACTS_IDB_STORE, 'readwrite');
      tx.objectStore(CONTACTS_IDB_STORE).clear();
      tx.oncomplete = () => {
        database.close();
        resolve();
      };
      tx.onerror = () => {
        database.close();
        resolve();
      };
    });
  } catch {
    // Ignore cleanup errors
  }
}

function getIsolatedContactsAuth(): Auth {
  const existing = getApps().find((a: FirebaseApp) => a.name === CONTACTS_APP_NAME);
  const contactsApp = existing || initializeApp(firebaseConfig, CONTACTS_APP_NAME);
  const isolatedAuth = getAuth(contactsApp);
  void setPersistence(isolatedAuth, inMemoryPersistence).catch(() => {
    // Fallback gracefully if persistence cannot be changed
  });
  return isolatedAuth;
}

// Automatically clear in-memory token and local contact directory snapshot when Akrobit user logs out
onAuthStateChanged(mainAuth, (user) => {
  if (!user) {
    cachedContactsAccessToken = null;
    cachedGoogleAccountEmail = null;
    void clearCachedContactsDirectory();
  }
});

export function hasCachedGoogleContactsToken(): boolean {
  return Boolean(cachedContactsAccessToken);
}

export function getCachedGoogleAccountEmail(): string | null {
  return cachedGoogleAccountEmail;
}

export function clearGoogleContactsToken(): void {
  cachedContactsAccessToken = null;
  cachedGoogleAccountEmail = null;
}

export async function connectGoogleContacts(forceAccountSwitch = false): Promise<{
  accessToken: string;
  email: string | null;
}> {
  if (cachedContactsAccessToken && !forceAccountSwitch) {
    return { accessToken: cachedContactsAccessToken, email: cachedGoogleAccountEmail };
  }

  const contactsAuth = getIsolatedContactsAuth();
  const provider = new GoogleAuthProvider();
  for (const scope of GOOGLE_CONTACTS_SCOPES) {
    provider.addScope(scope);
  }
  provider.setCustomParameters({ prompt: 'select_account' });

  const result = await signInWithPopup(contactsAuth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  if (!credential?.accessToken) {
    throw new Error('No se recibió el permiso de acceso a Google Contactos.');
  }

  cachedContactsAccessToken = credential.accessToken;
  cachedGoogleAccountEmail = result.user?.email || null;

  // Sign out isolated auxiliary instance immediately; token remains in memory only
  void signOut(contactsAuth).catch(() => {
    // Ignore cleanup errors
  });

  return {
    accessToken: cachedContactsAccessToken,
    email: cachedGoogleAccountEmail,
  };
}

interface PeopleConnection {
  resourceName?: string;
  names?: Array<{ displayName?: string; givenName?: string; familyName?: string }>;
  phoneNumbers?: Array<{ value?: string; canonicalForm?: string }>;
}

interface PeopleConnectionsResponse {
  connections?: PeopleConnection[];
  nextPageToken?: string;
}

export async function fetchGoogleContacts(accessToken: string): Promise<ContactCandidate[]> {
  const candidates: ContactCandidate[] = [];
  let pageToken: string | undefined;
  let pagesFetched = 0;

  while (pagesFetched < 5) {
    const params = new URLSearchParams({
      personFields: 'names,phoneNumbers',
      pageSize: '1000',
      sortOrder: 'FIRST_NAME_ASCENDING',
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const res = await fetch(
      `https://people.googleapis.com/v1/people/me/connections?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (res.status === 401 || res.status === 403) {
      clearGoogleContactsToken();
      throw new Error('AUTH_EXPIRED');
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Error al consultar Google Contactos (${res.status}): ${errText.slice(0, 120)}`);
    }

    const data = (await res.json()) as PeopleConnectionsResponse;
    const rows = data.connections || [];

    for (let i = 0; i < rows.length; i += 1) {
      const person = rows[i];
      const phonesRaw = (person.phoneNumbers || [])
        .map((p) => (p.canonicalForm || p.value || '').trim())
        .filter(Boolean);

      if (phonesRaw.length === 0) continue;

      const uniquePhones = Array.from(new Set(phonesRaw));
      // Sort so international '+' numbers appear first
      uniquePhones.sort((a, b) => Number(b.startsWith('+')) - Number(a.startsWith('+')));

      const nameObj = person.names?.[0];
      const displayName = (
        nameObj?.displayName ||
        [nameObj?.givenName, nameObj?.familyName].filter(Boolean).join(' ') ||
        uniquePhones[0]
      ).trim();

      candidates.push({
        id: person.resourceName || `g_${pagesFetched}_${i}`,
        name: displayName,
        phones: uniquePhones,
        source: 'google',
      });
    }

    pagesFetched += 1;
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  // Deduplicate synced Google Contacts entries sharing the exact same display name & numbers
  const mergedMap = new Map<string, ContactCandidate>();
  for (const item of candidates) {
    const key = item.name.trim().toLowerCase();
    const existing = mergedMap.get(key);
    if (!existing) {
      mergedMap.set(key, { ...item, phones: [...item.phones] });
    } else {
      const seenNorm = new Set(existing.phones.map((p) => p.replace(/[\s\-().]/g, '')));
      for (const phone of item.phones) {
        const norm = phone.replace(/[\s\-().]/g, '');
        if (!seenNorm.has(norm)) {
          seenNorm.add(norm);
          existing.phones.push(phone);
        }
      }
      existing.phones.sort((a, b) => Number(b.startsWith('+')) - Number(a.startsWith('+')));
    }
  }

  return Array.from(mergedMap.values());
}
