import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import {
  ADMIN_BOOTSTRAP_EMAIL,
  OperationType,
  auth,
  db,
  handleFirestoreError,
} from '../lib/firebase';
import type { UserProfile, UserRole } from '../types';

interface AuthContextValue {
  user: User | null;
  profile: UserProfile | null;
  role: UserRole;
  isAdmin: boolean;
  isVerified: boolean;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  registerEmployee: (name: string, email: string, password: string) => Promise<void>;
  sendResetEmail: (email: string) => Promise<void>;
  resendVerificationEmail: () => Promise<void>;
  refreshUserSession: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isVerified, setIsVerified] = useState(false);
  const [loading, setLoading] = useState(true);

  const syncUserDocuments = async (currentUser: User) => {
    const isBootstrapped =
      currentUser.email?.toLowerCase() === ADMIN_BOOTSTRAP_EMAIL && currentUser.emailVerified;

    setIsVerified(Boolean(currentUser.emailVerified));

    if (!currentUser.emailVerified) {
      setProfile({
        uid: currentUser.uid,
        displayName: currentUser.displayName || currentUser.email || 'Usuario',
        role: isBootstrapped ? 'admin' : 'employee',
        active: isBootstrapped,
      });
      setIsAdmin(false);
      return;
    }

    try {
      await currentUser.getIdToken(true);
    } catch {
      // Offline: continue using cached token
    }

    const userRef = doc(db, 'users', currentUser.uid);
    const privateRef = doc(db, 'users', currentUser.uid, 'private', 'info');
    const adminRef = doc(db, 'admins', currentUser.uid);

    let adminFlag = isBootstrapped;

    try {
      const adminSnap = await getDoc(adminRef);
      if (adminSnap.exists()) {
        adminFlag = true;
      }
    } catch {
      // Non-admins receive permission denied on /admins/{uid} if doc doesn't exist or offline
    }

    try {
      const userSnap = await getDoc(userRef);
      if (userSnap.exists()) {
        const data = userSnap.data() as UserProfile;
        if (isBootstrapped && (data.role !== 'admin' || data.active !== true)) {
          await setDoc(
            userRef,
            {
              uid: currentUser.uid,
              displayName: (currentUser.displayName || data.displayName || 'Administrador').slice(0, 80),
              role: 'admin',
              active: true,
              createdAt: data.createdAt || serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
            { merge: false }
          );
          setProfile({ ...data, role: 'admin', active: true });
        } else {
          setProfile(data);
          if (data.role === 'admin' && data.active !== false) {
            adminFlag = true;
          }
        }
      } else {
        const initialName = (
          currentUser.displayName ||
          currentUser.email?.split('@')[0] ||
          (isBootstrapped ? 'Administrador Akrobit' : 'Colaborador Akrobit')
        ).slice(0, 80);

        const newProfile: UserProfile = {
          uid: currentUser.uid,
          displayName: initialName,
          role: isBootstrapped ? 'admin' : 'employee',
          active: isBootstrapped,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };

        await setDoc(userRef, newProfile);
        await setDoc(privateRef, {
          email: (currentUser.email || '').slice(0, 160),
          updatedAt: serverTimestamp(),
        });

        setProfile(newProfile);
      }
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes('offline')) {
        setProfile({
          uid: currentUser.uid,
          displayName: currentUser.displayName || 'Usuario Akrobit',
          role: adminFlag ? 'admin' : 'employee',
          active: isBootstrapped || adminFlag,
        });
      } else {
        handleFirestoreError(error, OperationType.WRITE, `users/${currentUser.uid}`);
      }
    }

    setIsAdmin(adminFlag);
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (!firebaseUser) {
        setProfile(null);
        setIsAdmin(false);
        setIsVerified(false);
        setLoading(false);
        return;
      }

      try {
        await syncUserDocuments(firebaseUser);
      } catch (err) {
        console.error('Error sincronizando perfil:', err);
      } finally {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  const signInWithGoogle = async () => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await signInWithPopup(auth, provider);
  };

  const signInWithEmail = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email.trim(), password);
  };

  const registerEmployee = async (name: string, email: string, password: string) => {
    const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
    if (name.trim()) {
      await updateProfile(cred.user, { displayName: name.trim().slice(0, 80) });
    }
    await sendEmailVerification(cred.user);
  };

  const sendResetEmail = async (email: string) => {
    await sendPasswordResetEmail(auth, email.trim());
  };

  const resendVerificationEmail = async () => {
    if (auth.currentUser) {
      await sendEmailVerification(auth.currentUser);
    }
  };

  const refreshUserSession = async () => {
    if (auth.currentUser) {
      await auth.currentUser.reload();
      await auth.currentUser.getIdToken(true);
      const updated = auth.currentUser;
      setUser(updated);
      setIsVerified(Boolean(updated.emailVerified));
      await syncUserDocuments(updated);
    }
  };

  const logout = async () => {
    await signOut(auth);
  };

  const role: UserRole = isAdmin ? 'admin' : 'employee';

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        role,
        isAdmin,
        isVerified,
        loading,
        signInWithGoogle,
        signInWithEmail,
        registerEmployee,
        sendResetEmail,
        resendVerificationEmail,
        refreshUserSession,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth debe utilizarse dentro de AuthProvider');
  }
  return ctx;
}
