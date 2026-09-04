import {
  createUserWithEmailAndPassword, sendPasswordResetEmail, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, type User
} from "firebase/auth";
import { auth } from "./firebase";
import { ensureProfile } from "./db";

export type AuthState = { user: User | null; loading: boolean };

export function subscribeAuth(cb: (state: AuthState) => void) {
  if (!auth) {
    cb({ user: null, loading: false });
    return () => undefined;
  }
  cb({ user: null, loading: true });
  return onAuthStateChanged(auth, (user) => {
    if (user) void ensureProfile(user.uid, user.email ?? undefined);
    cb({ user, loading: false });
  });
}

export async function register(email: string, password: string) {
  if (!auth) throw new Error("Firebase ist noch nicht konfiguriert.");
  return createUserWithEmailAndPassword(auth, email, password);
}
export async function login(email: string, password: string) {
  if (!auth) throw new Error("Firebase ist noch nicht konfiguriert.");
  return signInWithEmailAndPassword(auth, email, password);
}
export async function resetPassword(email: string) {
  if (!auth) throw new Error("Firebase ist noch nicht konfiguriert.");
  return sendPasswordResetEmail(auth, email);
}
export async function logout() {
  if (!auth) return;
  await signOut(auth);
}

export function authMessage(code: string): string {
  const map: Record<string, string> = {
    "auth/invalid-email": "Bitte eine gültige E-Mail-Adresse eingeben.",
    "auth/invalid-credential": "E-Mail oder Passwort ist nicht korrekt.",
    "auth/email-already-in-use": "Diese E-Mail-Adresse ist bereits registriert.",
    "auth/weak-password": "Das Passwort ist zu schwach (mindestens 6 Zeichen).",
    "auth/too-many-requests": "Zu viele Versuche. Bitte später erneut versuchen.",
    "auth/network-request-failed": "Netzwerkfehler. Bitte Verbindung prüfen.",
    "auth/user-not-found": "Kein Konto mit dieser E-Mail-Adresse gefunden."
  };
  return map[code] ?? "Die Anmeldung konnte nicht durchgeführt werden.";
}
