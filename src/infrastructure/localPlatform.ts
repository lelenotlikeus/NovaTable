import type {
  Deck,
  DeckCardEntry,
  Lobby,
  LobbyFormat,
  LobbyPlayer,
  PlatformData,
  StoredAccount,
  UserProfile
} from "../domain/platform/types";
import { clearRemoteToken, remoteApi, remoteApiEnabled, storeRemoteToken } from "./remoteApi";

const DATA_KEY = "novatable.platform.v1";
const SESSION_KEY = "novatable.session.v1";

function lobbyPlayer(user: UserProfile, host = false): LobbyPlayer {
  return {
    id: id("seat"), userId: user.id, username: user.username,
    displayName: user.displayName, avatar: user.avatar,
    avatarImage: user.avatarImage, accentColor: user.accentColor,
    deckId: null, deckName: null, commander: null,
    ready: false, host, bot: user.id.startsWith("bot-")
  };
}

function emptyData(): PlatformData {
  return {
    accounts: [], directory: [], friendships: [], decks: [], lobbies: [], invites: []
  };
}

function read(): PlatformData {
  const value = localStorage.getItem(DATA_KEY);
  if (value) {
    try {
      const data = JSON.parse(value) as PlatformData;
      const size = data.directory.length + data.friendships.length + data.lobbies.length + data.invites.length;
      data.directory = data.directory.filter((user) => !user.id.startsWith("demo-"));
      data.friendships = data.friendships.filter((friendship) => !friendship.fromId.startsWith("demo-") && !friendship.toId.startsWith("demo-"));
      data.lobbies = data.lobbies.filter((lobby) => lobby.id !== "public-commander" && !lobby.hostId.startsWith("demo-"));
      data.invites = data.invites.filter((invite) => !invite.fromId.startsWith("demo-") && !invite.toId.startsWith("demo-") && invite.lobbyId !== "public-commander");
      if (size !== data.directory.length + data.friendships.length + data.lobbies.length + data.invites.length) write(data);
      return data;
    } catch { /* reset below */ }
  }
  const data = emptyData();
  write(data);
  return data;
}

function write(data: PlatformData) {
  localStorage.setItem(DATA_KEY, JSON.stringify(data));
}

function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function hashPassword(password: string) {
  const bytes = new TextEncoder().encode(`novatable-local:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function publicUser(account: StoredAccount): UserProfile {
  const { passwordHash: _passwordHash, createdAt: _createdAt, ...profile } = account;
  return profile;
}

export async function registerAccount(input: { email: string; username: string; password: string; displayName: string }): Promise<UserProfile> {
  if (remoteApiEnabled) {
    const result = await remoteApi<{ user: UserProfile; token: string }>("/register", { method: "POST", body: JSON.stringify(input) });
    storeRemoteAccount(result.user, result.token);
    return result.user;
  }
  const data = read();
  const email = input.email.trim().toLowerCase();
  const username = input.username.trim().toLowerCase();
  if (!email || !username || input.password.length < 8 || !input.displayName.trim())
    throw new Error("Complete every field; the password must contain at least 8 characters.");
  if (data.accounts.some((account) => account.email === email)) throw new Error("An account already uses this email.");
  if ([...data.accounts, ...data.directory].some((user) => user.username.toLowerCase() === username))
    throw new Error("This username is already taken.");
  const account: StoredAccount = {
    id: id("user"), email, username, passwordHash: await hashPassword(input.password),
    displayName: input.displayName.trim(), avatar: input.displayName.trim().slice(0, 2).toUpperCase(),
    presence: "online", theme: "dark", createdAt: Date.now()
  };
  data.accounts.push(account);
  write(data);
  localStorage.setItem(SESSION_KEY, account.id);
  return publicUser(account);
}

export async function loginAccount(identity: string, password: string): Promise<UserProfile> {
  if (remoteApiEnabled) {
    const result = await remoteApi<{ user: UserProfile; token: string }>("/login", { method: "POST", body: JSON.stringify({ identity, password }) });
    storeRemoteAccount(result.user, result.token);
    return result.user;
  }
  const normalized = identity.trim().toLowerCase();
  const account = read().accounts.find((candidate) => candidate.email === normalized || candidate.username === normalized);
  if (!account || account.passwordHash !== (await hashPassword(password))) throw new Error("Email/username or password is incorrect.");
  localStorage.setItem(SESSION_KEY, account.id);
  return publicUser(account);
}

export function currentUser(): UserProfile | null {
  const userId = localStorage.getItem(SESSION_KEY);
  const account = read().accounts.find((candidate) => candidate.id === userId);
  return account ? publicUser(account) : null;
}

export function logoutAccount() { localStorage.removeItem(SESSION_KEY); clearRemoteToken(); }
export function decksFor(userId: string) { return read().decks.filter((deck) => deck.ownerId === userId); }

export function updateProfile(userId: string, patch: { displayName: string; avatarImage?: string; accentColor: string; bio: string; theme: "dark" | "light" }): UserProfile {
  const data = read();
  const account = data.accounts.find((candidate) => candidate.id === userId);
  if (!account) throw new Error("Account not found.");
  const displayName = patch.displayName.trim();
  if (!displayName) throw new Error("Display name is required.");
  account.displayName = displayName;
  account.avatar = displayName.slice(0, 2).toUpperCase();
  account.avatarImage = patch.avatarImage;
  account.accentColor = /^#[0-9a-f]{6}$/i.test(patch.accentColor) ? patch.accentColor : "#62e6bb";
  account.bio = patch.bio.trim().slice(0, 240);
  account.theme = patch.theme === "light" ? "light" : "dark";
  write(data);
  if (remoteApiEnabled) void remoteApi("/profile", { method: "POST", body: JSON.stringify({ displayName: account.displayName, avatarImage: account.avatarImage, accentColor: account.accentColor, bio: account.bio, theme: account.theme }) });
  return publicUser(account);
}

export function parseDeckList(text: string): DeckCardEntry[] {
  const cards = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || /^commander:?$/i.test(line)) continue;
    const match = line.match(/^(\d+)x?\s+(.+?)(?:\s+\([A-Z0-9]+\)\s+\d+)?$/i);
    if (!match) throw new Error(`Could not read deck line: ${line}`);
    const name = match[2].trim();
    cards.set(name, (cards.get(name) ?? 0) + Number(match[1]));
  }
  if (!cards.size) throw new Error("Paste at least one card line.");
  return [...cards].map(([name, quantity]) => ({ name, quantity }));
}

export function saveDeck(input: { ownerId: string; name: string; commander: string; list: string }): Deck {
  if (!input.name.trim() || !input.commander.trim()) throw new Error("Deck name and commander are required.");
  const data = read();
  const deck: Deck = {
    id: id("deck"), ownerId: input.ownerId, name: input.name.trim(), format: "Commander",
    commander: input.commander.trim(), cards: parseDeckList(input.list), updatedAt: Date.now()
  };
  data.decks.push(deck); write(data); return deck;
}

export function updateDeck(deckId: string, ownerId: string, input: { name: string; commander: string; cards: DeckCardEntry[] }): Deck {
  const data = read();
  const deck = data.decks.find((candidate) => candidate.id === deckId && candidate.ownerId === ownerId);
  if (!deck) throw new Error("Deck not found.");
  const name = input.name.trim(); const commander = input.commander.trim();
  const cards = mergeCardEntries(input.cards);
  if (!name || !commander) throw new Error("Deck name and commander are required.");
  if (!cards.length) throw new Error("A deck must contain at least one card.");
  Object.assign(deck, { name, commander, cards, updatedAt: Date.now() });
  for (const lobby of data.lobbies) for (const player of lobby.players) if (player.deckId === deckId) {
    player.deckName = name; player.commander = commander; player.ready = false;
  }
  write(data); return structuredClone(deck);
}

export function deleteDeck(deckId: string, ownerId: string) {
  const data = read();
  if (!data.decks.some((deck) => deck.id === deckId && deck.ownerId === ownerId)) throw new Error("Deck not found.");
  data.decks = data.decks.filter((deck) => deck.id !== deckId || deck.ownerId !== ownerId);
  for (const lobby of data.lobbies) for (const player of lobby.players) if (player.deckId === deckId) {
    player.deckId = null; player.deckName = null; player.commander = null; player.ready = false;
  }
  write(data);
}

function mergeCardEntries(entries: DeckCardEntry[]) {
  const merged = new Map<string, DeckCardEntry>();
  for (const entry of entries) {
    const name = entry.name.trim(); const quantity = Math.floor(entry.quantity);
    if (!name || quantity <= 0) continue;
    const key = name.toLocaleLowerCase(); const current = merged.get(key);
    merged.set(key, { name: current?.name ?? name, quantity: (current?.quantity ?? 0) + quantity });
  }
  return [...merged.values()];
}

export function publicLobbies() {
  return read().lobbies.filter((lobby) => lobby.privacy === "public" && lobby.status === "waiting");
}

export function createLobby(user: UserProfile, input: {
  name: string; format: LobbyFormat; privacy: "public" | "private"; maxPlayers: number;
  spectatorsAllowed: boolean; startingLife: number; password: string; description: string;
}): Lobby {
  if (!input.name.trim()) throw new Error("Lobby name is required.");
  const data = read();
  const lobby: Lobby = {
    id: id("lobby"), code: crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase(),
    name: input.name.trim(), hostId: user.id, format: input.format, privacy: input.privacy,
    maxPlayers: input.maxPlayers, spectatorsAllowed: input.spectatorsAllowed,
    startingLife: input.startingLife, password: input.password, description: input.description.trim(),
    tags: [input.format === "Commander" ? "Commander" : "Constructed", input.privacy === "private" ? "Invite only" : "Open"],
    status: "waiting", players: [lobbyPlayer(user, true)],
    messages: [{ id: id("message"), author: "NovaTable", text: "Lobby created. Choose a deck and ready up.", createdAt: Date.now() }],
    createdAt: Date.now()
  };
  data.lobbies.push(lobby); write(data); return lobby;
}

export function findLobby(code: string) { return read().lobbies.find((lobby) => lobby.code === code.trim().toUpperCase()) ?? null; }
export function findLobbyById(lobbyId: string) { return read().lobbies.find((lobby) => lobby.id === lobbyId) ?? null; }
export function joinLobby(lobbyId: string, user: UserProfile, password = ""): Lobby {
  return updateLobby(lobbyId, (lobby) => {
    if (lobby.password && lobby.password !== password) throw new Error("Lobby password is incorrect.");
    if (lobby.players.some((player) => player.userId === user.id)) return;
    if (lobby.players.length >= lobby.maxPlayers) throw new Error("This lobby is full.");
    lobby.players.push(lobbyPlayer(user));
  });
}

function storeRemoteAccount(user: UserProfile, token: string) {
  const data = read();
  const existing = data.accounts.find((account) => account.id === user.id);
  if (existing) Object.assign(existing, user);
  else {
    data.accounts.push({ ...user, passwordHash: "remote", createdAt: Date.now() });
  }
  write(data);
  localStorage.setItem(SESSION_KEY, user.id);
  storeRemoteToken(token);
}

export function addDevelopmentPlayer(lobbyId: string): Lobby {
  return updateLobby(lobbyId, (lobby) => {
    if (lobby.players.length >= lobby.maxPlayers) throw new Error("Every player slot is occupied.");
    const index = lobby.players.length;
    const names = ["Mira Vale", "Orin", "Nia"];
    const commanders = ["Muldrotha, the Gravetide", "Isshin, Two Heavens as One", "Lathril, Blade of the Elves"];
    const name = names[Math.max(0, index - 1)] ?? `Player ${index + 1}`;
    lobby.players.push({
      id: id("seat"), userId: `bot-${index}`, username: name.toLowerCase().replaceAll(" ", ""),
      displayName: name, avatar: name.slice(0, 2).toUpperCase(), deckId: `bot-deck-${index}`,
      deckName: `${name}'s Commander deck`, commander: commanders[Math.max(0, index - 1)] ?? "Atraxa, Praetors' Voice",
      ready: true, host: false, bot: true
    });
  });
}

export function setLobbyDeck(lobbyId: string, userId: string, deck: Deck): Lobby {
  return updateLobby(lobbyId, (lobby) => {
    const player = lobby.players.find((candidate) => candidate.userId === userId);
    if (!player) throw new Error("You are not in this lobby.");
    player.deckId = deck.id; player.deckName = deck.name; player.commander = deck.commander; player.cards = deck.cards; player.ready = false;
  });
}

export function setReady(lobbyId: string, userId: string, ready: boolean): Lobby {
  return updateLobby(lobbyId, (lobby) => {
    const player = lobby.players.find((candidate) => candidate.userId === userId);
    if (!player?.deckId) throw new Error("Choose a deck before becoming ready.");
    player.ready = ready;
  });
}

export function postLobbyMessage(lobbyId: string, author: string, text: string): Lobby {
  return updateLobby(lobbyId, (lobby) => {
    if (text.trim()) lobby.messages.push({ id: id("message"), author, text: text.trim(), createdAt: Date.now() });
  });
}

export function updateLobbySettings(lobbyId: string, hostId: string, patch: Partial<Pick<Lobby, "name" | "privacy" | "maxPlayers" | "spectatorsAllowed" | "startingLife" | "password" | "description">>): Lobby {
  return updateLobby(lobbyId, (lobby) => {
    if (lobby.hostId !== hostId) throw new Error("Only the host can change lobby settings.");
    Object.assign(lobby, patch);
  });
}

export function kickLobbyPlayer(lobbyId: string, hostId: string, playerId: string): Lobby {
  return updateLobby(lobbyId, (lobby) => {
    if (lobby.hostId !== hostId) throw new Error("Only the host can remove players.");
    lobby.players = lobby.players.filter((player) => player.id !== playerId || player.host);
  });
}

export function inviteFriendToLobby(lobbyId: string, fromId: string, toId: string) {
  const data = read();
  if (!data.invites.some((invite) => invite.lobbyId === lobbyId && invite.toId === toId))
    data.invites.push({ id: id("invite"), lobbyId, fromId, toId, createdAt: Date.now() });
  write(data);
}

export function invitationsFor(userId: string) {
  const data = read();
  const users = [...data.directory, ...data.accounts.map(publicUser)];
  return data.invites.filter((invite) => invite.toId === userId).map((invite) => ({
    invite,
    lobby: data.lobbies.find((lobby) => lobby.id === invite.lobbyId)!,
    from: users.find((user) => user.id === invite.fromId)!
  })).filter((entry) => entry.lobby && entry.from);
}

export function startLobby(lobbyId: string, hostId: string): Lobby {
  return updateLobby(lobbyId, (lobby) => {
    if (lobby.hostId !== hostId) throw new Error("Only the host can start the game.");
    if (lobby.players.length !== lobby.maxPlayers || lobby.players.some((player) => !player.ready))
      throw new Error("Fill every seat and make sure every player is ready.");
    lobby.status = "in-game";
  });
}

export function leaveLobby(lobbyId: string, userId: string) {
  const data = read(); const lobby = data.lobbies.find((candidate) => candidate.id === lobbyId); if (!lobby) return;
  if (lobby.hostId === userId) data.lobbies = data.lobbies.filter((candidate) => candidate.id !== lobbyId);
  else lobby.players = lobby.players.filter((player) => player.userId !== userId);
  write(data);
}

export function friendSnapshot(userId: string) {
  const data = read(); const users = [...data.directory, ...data.accounts.map(publicUser)];
  const requests = data.friendships.filter((friendship) => friendship.toId === userId && friendship.status === "pending")
    .map((friendship) => ({ friendship, user: users.find((user) => user.id === friendship.fromId)! }));
  const friends = data.friendships.filter((friendship) => friendship.status === "accepted" && (friendship.fromId === userId || friendship.toId === userId))
    .map((friendship) => users.find((user) => user.id === (friendship.fromId === userId ? friendship.toId : friendship.fromId))!).filter(Boolean);
  return { friends, requests };
}

export function searchUsers(query: string, currentUserId: string) {
  const search = query.trim().toLowerCase(); if (!search) return [];
  const data = read();
  return [...data.directory, ...data.accounts.map(publicUser)]
    .filter((user) => user.id !== currentUserId && user.username.toLowerCase().includes(search)).slice(0, 8);
}

export function sendFriendRequest(fromId: string, toId: string) {
  const data = read();
  if (!data.friendships.some((friendship) => [friendship.fromId, friendship.toId].includes(fromId) && [friendship.fromId, friendship.toId].includes(toId))) {
    data.friendships.push({ id: id("friend"), fromId, toId, status: "pending" }); write(data);
  }
}

export function answerFriendRequest(friendshipId: string, accept: boolean) {
  const data = read(); const friendship = data.friendships.find((candidate) => candidate.id === friendshipId); if (!friendship) return;
  if (accept) friendship.status = "accepted";
  else data.friendships = data.friendships.filter((candidate) => candidate.id !== friendshipId);
  write(data);
}

function updateLobby(lobbyId: string, mutation: (lobby: Lobby) => void): Lobby {
  const data = read(); const lobby = data.lobbies.find((candidate) => candidate.id === lobbyId);
  if (!lobby) throw new Error("Lobby no longer exists.");
  mutation(lobby); write(data); return structuredClone(lobby);
}

export function resetLocalPlatformForTests() {
  localStorage.removeItem(DATA_KEY); localStorage.removeItem(SESSION_KEY);
}
