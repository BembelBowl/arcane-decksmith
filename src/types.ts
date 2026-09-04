export type Format = "commander" | "standard";
export type GroupBy = "none" | "color" | "type" | "set" | "manaValue";
export type ViewMode = "grid" | "list";

export interface CardRecord {
  id: string;
  oracleId?: string;
  name: string;
  set: string;
  collectorNumber: string;
  lang: string;
  foil: boolean;
  variant?: string;
  count: number;
  addedAt: number;
  updatedAt: number;
  comment?: string;
  tags?: string[];
  condition?: string;
  location?: string;
  manaCost?: string;
  manaValue: number;
  colors: string[];
  colorIdentity: string[];
  typeLine?: string;
  oracleText?: string;
  imageUri?: string;
  imageUris?: { small?: string; normal?: string; large?: string };
  legalities?: Record<string, string>;
  isBasicLand?: boolean;
}

export interface DeckCard {
  id: string;
  name: string;
  count: number;
  manaValue: number;
  typeLine?: string;
  role: string;
  reason: string;
  available: number;
}

export interface DeckRecord {
  id: string;
  name: string;
  format: Format;
  commanderIds: string[];
  cards: DeckCard[];
  sideboard: DeckCard[];
  targetManaValue?: number;
  minManaValue?: number;
  maxManaValue?: number;
  colors: string[];
  createdAt: number;
  updatedAt: number;
  notes?: string;
  score?: number;
}
