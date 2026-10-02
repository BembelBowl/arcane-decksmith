import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  startAfter,
  where,
  writeBatch,
  type QueryConstraint,
  type QueryDocumentSnapshot
} from "firebase/firestore";
import { BATCH_SIZE, firestoreClean, withRetry } from "./db";
import { db } from "./firebase";
import type { MarketListing } from "./marketplace";

export const MARKET_PAGE_SIZE = 48;

/** Der Marketplace braucht Firestore. Im lokalen Demo-Modus gibt es ihn nicht. */
export const marketplaceSupported = Boolean(db);

export type MarketCursor = QueryDocumentSnapshot;

export interface MarketPage {
  listings: MarketListing[];
  cursor: MarketCursor | null;
  hasMore: boolean;
}

function requireDb() {
  if (!db) {
    throw new Error("Der Marketplace benötigt ein Konto. Im lokalen Demo-Modus ist er nicht verfügbar.");
  }
  return db;
}

function asListing(snapshot: QueryDocumentSnapshot): MarketListing {
  return { ...(snapshot.data() as Omit<MarketListing, "id">), id: snapshot.id };
}

/** Alle eigenen Angebote. */
export async function loadMyListings(uid: string): Promise<MarketListing[]> {
  const firestore = requireDb();
  const snap = await getDocs(query(collection(firestore, "marketListings"), where("ownerId", "==", uid)));
  return snap.docs.map(asListing).sort((a, b) => a.name.localeCompare(b.name, "de"));
}

/**
 * Lädt eine Seite Angebote. Ohne Suche: neueste zuerst. Mit Suche: Namensanfang
 * (Firestore kann keine Teilwortsuche; "sol" findet "Sol Ring", nicht "Mana Sol").
 */
export async function loadMarketPage(options: {
  search?: string;
  cursor?: MarketCursor | null;
  pageSize?: number;
} = {}): Promise<MarketPage> {
  const firestore = requireDb();
  const pageSize = options.pageSize ?? MARKET_PAGE_SIZE;
  const search = (options.search ?? "").trim().toLowerCase();

  const constraints: QueryConstraint[] = search
    ? [
        where("nameLower", ">=", search),
        where("nameLower", "<=", `${search}`),
        orderBy("nameLower")
      ]
    : [orderBy("updatedAt", "desc")];

  if (options.cursor) constraints.push(startAfter(options.cursor));
  // Eine Karte mehr laden, um zu wissen, ob es weitere Seiten gibt.
  constraints.push(limit(pageSize + 1));

  const snap = await getDocs(query(collection(firestore, "marketListings"), ...constraints));
  const docs = snap.docs.slice(0, pageSize);

  return {
    listings: docs.map(asListing),
    cursor: docs.length > 0 ? docs[docs.length - 1] : null,
    hasMore: snap.docs.length > pageSize
  };
}

/** Schreibt Angebote gebündelt (Batches mit Retry). */
export async function saveListings(listings: MarketListing[]): Promise<void> {
  if (listings.length === 0) return;
  const firestore = requireDb();

  for (let start = 0; start < listings.length; start += BATCH_SIZE) {
    const chunk = listings.slice(start, start + BATCH_SIZE);
    await withRetry(async () => {
      const batch = writeBatch(firestore);
      for (const listing of chunk) {
        const { id, ...data } = firestoreClean(listing);
        batch.set(doc(firestore, "marketListings", id), data);
      }
      await batch.commit();
    });
  }
}

export async function removeListings(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const firestore = requireDb();

  for (let start = 0; start < ids.length; start += BATCH_SIZE) {
    const chunk = ids.slice(start, start + BATCH_SIZE);
    await withRetry(async () => {
      const batch = writeBatch(firestore);
      for (const id of chunk) batch.delete(doc(firestore, "marketListings", id));
      await batch.commit();
    });
  }
}

export async function removeListing(id: string): Promise<void> {
  await deleteDoc(doc(requireDb(), "marketListings", id));
}

/** Anzeigename aus dem eigenen Profil (nur für den Besitzer lesbar). */
export async function loadDisplayName(uid: string): Promise<string> {
  const snap = await getDoc(doc(requireDb(), "users", uid));
  const value = snap.exists() ? snap.data().displayName : "";
  return typeof value === "string" ? value : "";
}

export async function saveDisplayName(uid: string, displayName: string): Promise<void> {
  await setDoc(
    doc(requireDb(), "users", uid),
    { displayName, updatedAt: Date.now() },
    { merge: true }
  );
}
