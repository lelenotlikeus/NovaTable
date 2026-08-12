const DATABASE_NAME = "novatable-card-database";
const DATABASE_VERSION = 1;
const STORE_NAME = "cards";
const STATUS_KEY = "novatable.cards.installed.v2";
const ARTWORK_KEY = "novatable.card-artwork.v1";
const BULK_ENDPOINT = "https://api.scryfall.com/bulk-data";

export interface CardRecord {
  name: string;
  nameLower: string;
  manaCost: string;
  colorIdentity?: string[];
  typeLine: string;
  oracleText: string;
  power: string | null;
  toughness: string | null;
  imageUrl: string | null;
  otherFaceName?: string;
  otherFaceImageUrl?: string | null;
  printingId?: string;
  setCode?: string;
  setName?: string;
  collectorNumber?: string;
  releasedAt?: string;
  artist?: string;
}

export interface CardPrinting extends CardRecord {
  printingId: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  releasedAt: string;
  artist: string;
}

interface ScryfallCard {
  id?: string;
  name: string;
  mana_cost?: string;
  color_identity?: string[];
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  set?: string;
  set_name?: string;
  collector_number?: string;
  released_at?: string;
  artist?: string;
  image_uris?: { normal?: string; large?: string };
  card_faces?: Array<{
    name?: string;
    mana_cost?: string;
    type_line?: string;
    oracle_text?: string;
    power?: string;
    toughness?: string;
    image_uris?: { normal?: string; large?: string };
  }>;
}

interface ScryfallList { data: ScryfallCard[]; has_more: boolean; next_page?: string }

interface BulkList {
  data: Array<{
    type: string;
    updated_at: string;
    download_uri?: string;
    jsonl_download_uri?: string;
    size?: number;
    compressed_size?: number;
  }>;
}

const memoryCache = new Map<string, CardRecord | null>();
const pendingLookups = new Map<string, Promise<CardRecord | null>>();

export function isCardDatabaseInstalled() {
  return localStorage.getItem(STATUS_KEY) !== null;
}

export function cardDatabaseStatus(): { version: string; count: number } | null {
  const value = localStorage.getItem(STATUS_KEY);
  if (!value) return null;
  try {
    return JSON.parse(value) as { version: string; count: number };
  } catch {
    return null;
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "nameLower" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the local card database."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save the card database."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Card database installation was interrupted."));
  });
}

export function cardRecordFromScryfall(card: ScryfallCard, requestedName = card.name): CardRecord {
  const firstFace = card.card_faces?.find((face) => face.name?.toLocaleLowerCase() === requestedName.toLocaleLowerCase()) ?? card.card_faces?.[0];
  const otherFace = card.card_faces?.find((face) => face !== firstFace);
  return {
    name: firstFace?.name ?? card.name,
    nameLower: requestedName.toLocaleLowerCase(),
    manaCost: card.mana_cost ?? firstFace?.mana_cost ?? "",
    colorIdentity: card.color_identity ?? [],
    typeLine: firstFace?.type_line ?? card.type_line ?? "",
    oracleText: card.oracle_text ?? firstFace?.oracle_text ?? "",
    power: firstFace?.power ?? card.power ?? null,
    toughness: firstFace?.toughness ?? card.toughness ?? null,
    imageUrl: card.image_uris?.large ?? firstFace?.image_uris?.large ?? card.image_uris?.normal ?? firstFace?.image_uris?.normal ?? null,
    otherFaceName: otherFace?.name,
    otherFaceImageUrl: otherFace?.image_uris?.large ?? otherFace?.image_uris?.normal ?? null,
    printingId: card.id,
    setCode: card.set?.toUpperCase(),
    setName: card.set_name,
    collectorNumber: card.collector_number,
    releasedAt: card.released_at,
    artist: card.artist
  };
}

export async function installCardDatabase(onProgress: (progress: number, message: string) => void) {
  onProgress(2, "Finding the latest Magic card catalog…");
  const metadataResponse = await fetch(BULK_ENDPOINT, { headers: { Accept: "application/json" } });
  if (!metadataResponse.ok) throw new Error(`Card catalog request failed (${metadataResponse.status}).`);
  const metadata = (await metadataResponse.json()) as BulkList;
  const oracleCards = metadata.data.find((item) => item.type === "oracle_cards");
  if (!oracleCards) throw new Error("The Oracle Cards bulk catalog is unavailable.");
  const downloadUri = oracleCards.jsonl_download_uri ?? oracleCards.download_uri;
  if (!downloadUri) throw new Error("The Oracle Cards download URL is unavailable.");

  onProgress(5, "Downloading card names, rules and artwork links…");
  const bulkResponse = await fetch(downloadUri, { headers: { Accept: "application/json, application/gzip" } });
  if (!bulkResponse.ok) throw new Error(`Card database download failed (${bulkResponse.status}).`);
  const totalBytes = Number(bulkResponse.headers.get("content-length")) || oracleCards.compressed_size || oracleCards.size || 0;
  let payload: Uint8Array;
  if (bulkResponse.body) {
    const reader = bulkResponse.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      const downloadProgress = totalBytes ? received / totalBytes : Math.min(received / 150_000_000, 1);
      onProgress(5 + Math.round(downloadProgress * 60), `Downloading card catalog… ${Math.round(received / 1_048_576)} MB`);
    }
    payload = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      payload.set(chunk, offset);
      offset += chunk.length;
    }
  } else {
    payload = new Uint8Array(await bulkResponse.arrayBuffer());
  }

  onProgress(68, "Preparing cards for offline search…");
  const compressed = downloadUri.endsWith(".gz");
  const payloadBuffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
  const text = compressed
    ? await new Response(new Blob([payloadBuffer]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
    : new TextDecoder().decode(payload);
  const sourceCards = downloadUri.includes(".jsonl")
    ? text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ScryfallCard)
    : JSON.parse(text) as ScryfallCard[];
  const cards = sourceCards.flatMap((card) => [
    cardRecordFromScryfall(card),
    ...(card.card_faces ?? []).flatMap((face) => face.name ? [cardRecordFromScryfall(card, face.name)] : [])
  ]);
  const database = await openDatabase();
  const clearTransaction = database.transaction(STORE_NAME, "readwrite");
  clearTransaction.objectStore(STORE_NAME).clear();
  await transactionDone(clearTransaction);

  const batchSize = 750;
  for (let start = 0; start < cards.length; start += batchSize) {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    for (const card of cards.slice(start, start + batchSize)) store.put(card);
    await transactionDone(transaction);
    onProgress(70 + Math.round(((start + batchSize) / cards.length) * 29), `Saving cards… ${Math.min(start + batchSize, cards.length).toLocaleString()} / ${cards.length.toLocaleString()}`);
  }
  database.close();
  memoryCache.clear();
  localStorage.setItem(STATUS_KEY, JSON.stringify({ version: oracleCards.updated_at, count: cards.length }));
  onProgress(100, `${cards.length.toLocaleString()} cards are ready.`);
  return cards.length;
}

export async function getCardByName(name: string): Promise<CardRecord | null> {
  const key = name.toLocaleLowerCase();
  const preferred = artworkPreferences()[key];
  if (preferred) return withLargeArtwork(preferred);
  if (memoryCache.has(key)) return memoryCache.get(key) ?? null;
  const pending = pendingLookups.get(key);
  if (pending) return pending;
  const lookup = resolveCard(name, key).catch(() => null).then((value) => {
    memoryCache.set(key, value);
    pendingLookups.delete(key);
    return value;
  });
  pendingLookups.set(key, lookup);
  return lookup;
}

export async function searchCardDatabase(query: string, limit = 12): Promise<CardRecord[]> {
  const prefix = query.trim().toLocaleLowerCase();
  if (!prefix || !isCardDatabaseInstalled()) return [];
  const database = await openDatabase();
  const cards = await new Promise<CardRecord[]>((resolve, reject) => {
    const results: CardRecord[] = [];
    const request = database.transaction(STORE_NAME).objectStore(STORE_NAME)
      .openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || results.length >= limit) return resolve(results);
      results.push(cursor.value as CardRecord);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  database.close();
  return cards;
}

async function resolveCard(name: string, key: string) {
  if (isCardDatabaseInstalled()) {
    const database = await openDatabase();
    const value = await new Promise<CardRecord | undefined>((resolve, reject) => {
      const request = database.transaction(STORE_NAME).objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result as CardRecord | undefined);
      request.onerror = () => reject(request.error);
    });
    database.close();
    if (value?.imageUrl) return withLargeArtwork(value);
  }
  if (import.meta.env.MODE === "test") return null;
  const response = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`, { headers: { Accept: "application/json;q=0.9,*/*;q=0.8" } });
  if (!response.ok) return null;
  return cardRecordFromScryfall(await response.json() as ScryfallCard, name);
}

function withLargeArtwork<T extends CardRecord>(card: T): T {
  const imageUrl = card.imageUrl?.replace("/small/", "/large/").replace("/normal/", "/large/") ?? null;
  const otherFaceImageUrl = card.otherFaceImageUrl?.replace("/small/", "/large/").replace("/normal/", "/large/") ?? null;
  return imageUrl === card.imageUrl && otherFaceImageUrl === card.otherFaceImageUrl ? card : { ...card, imageUrl, otherFaceImageUrl };
}

export async function getCardPrintings(name: string): Promise<CardPrinting[]> {
  let url: string | undefined = `https://api.scryfall.com/cards/search?order=released&unique=prints&q=${encodeURIComponent(`!\"${name}\"`)}`;
  const cards: CardPrinting[] = [];
  while (url && cards.length < 500) {
    const response = await fetch(url, { headers: { Accept: "application/json;q=0.9,*/*;q=0.8" } });
    if (!response.ok) throw new Error(response.status === 404 ? "No printings found for this card." : `Artwork request failed (${response.status}).`);
    const page = await response.json() as ScryfallList;
    for (const source of page.data) {
      const card = cardRecordFromScryfall(source, name);
      if (card.imageUrl && source.id && source.set && source.set_name) cards.push({
        ...card,
        printingId: source.id,
        setCode: source.set.toUpperCase(),
        setName: source.set_name,
        collectorNumber: source.collector_number ?? "",
        releasedAt: source.released_at ?? "",
        artist: source.artist ?? "Unknown artist"
      });
    }
    url = page.has_more ? page.next_page : undefined;
  }
  return cards;
}

export function setPreferredCardPrinting(name: string, printing: CardPrinting | null) {
  const key = name.toLocaleLowerCase();
  const preferences = artworkPreferences();
  if (printing) preferences[key] = printing;
  else delete preferences[key];
  localStorage.setItem(ARTWORK_KEY, JSON.stringify(preferences));
  memoryCache.delete(key);
  window.dispatchEvent(new CustomEvent("novatable:artwork-changed", { detail: key }));
}

function artworkPreferences(): Record<string, CardPrinting> {
  try { return JSON.parse(localStorage.getItem(ARTWORK_KEY) ?? "{}") as Record<string, CardPrinting>; }
  catch { return {}; }
}
