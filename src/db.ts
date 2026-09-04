import {
  addDoc, collection, deleteDoc, doc, getDocs, setDoc, updateDoc, query, orderBy
} from "firebase/firestore";
import { db } from "./firebase";
import type { CardRecord, DeckRecord } from "./types";

const key = (uid: string, suffix: string) => `arcane-decksmith:${uid}:${suffix}`;

function localGet<T>(k: string): T[] {
  try { return JSON.parse(localStorage.getItem(k) ?? "[]") as T[]; } catch { return []; }
}
function localSet<T>(k: string, value: T[]) {
  localStorage.setItem(k, JSON.stringify(value));
}

export async function loadCollection(uid: string): Promise<CardRecord[]> {
  if (!db) return localGet<CardRecord>(key(uid, "collection"));
  const snap = await getDocs(query(collection(db, "users", uid, "collection"), orderBy("name")));
  return snap.docs.map((d) => d.data() as CardRecord);
}

export async function saveCard(uid: string, card: CardRecord) {
  if (!db) {
    const all = localGet<CardRecord>(key(uid, "collection"));
    const i = all.findIndex((c) => c.id === card.id);
    if (i >= 0) all[i] = card; else all.push(card);
    localSet(key(uid, "collection"), all);
    return;
  }
  await setDoc(doc(db, "users", uid, "collection", card.id), card, { merge: true });
}

export async function removeCard(uid: string, id: string) {
  if (!db) {
    localSet(key(uid, "collection"), localGet<CardRecord>(key(uid, "collection")).filter((c) => c.id !== id));
    return;
  }
  await deleteDoc(doc(db, "users", uid, "collection", id));
}

export async function loadDecks(uid: string): Promise<DeckRecord[]> {
  if (!db) return localGet<DeckRecord>(key(uid, "decks"));
  const snap = await getDocs(query(collection(db, "users", uid, "decks"), orderBy("updatedAt", "desc")));
  return snap.docs.map((d) => d.data() as DeckRecord);
}

export async function saveDeck(uid: string, deck: DeckRecord) {
  if (!db) {
    const all = localGet<DeckRecord>(key(uid, "decks"));
    const i = all.findIndex((d) => d.id === deck.id);
    if (i >= 0) all[i] = deck; else all.unshift(deck);
    localSet(key(uid, "decks"), all);
    return;
  }
  await setDoc(doc(db, "users", uid, "decks", deck.id), deck, { merge: true });
}

export async function removeDeck(uid: string, id: string) {
  if (!db) {
    localSet(key(uid, "decks"), localGet<DeckRecord>(key(uid, "decks")).filter((d) => d.id !== id));
    return;
  }
  await deleteDoc(doc(db, "users", uid, "decks", id));
}

export function uidFromEmail(email: string) {
  return `demo-${btoa(email.toLowerCase()).replace(/[^a-z0-9]/gi, "").slice(0, 32)}`;
}

export async function ensureProfile(uid: string, email?: string) {
  if (!db) return;
  await setDoc(doc(db, "users", uid), { email: email ?? "", updatedAt: Date.now() }, { merge: true });
}
