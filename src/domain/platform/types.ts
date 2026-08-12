export type Presence = "online" | "offline" | "in-game";
export type InterfaceTheme = "dark" | "light";
export type LobbyFormat =
  | "Commander"
  | "Standard"
  | "Modern"
  | "Legacy"
  | "Vintage"
  | "Pauper"
  | "Custom";

export interface UserProfile {
  id: string;
  email?: string;
  username: string;
  displayName: string;
  avatar: string;
  avatarImage?: string;
  accentColor?: string;
  bio?: string;
  theme?: InterfaceTheme;
  honor?: number;
  xp?: number;
  level?: number;
  gamesPlayed?: number;
  gamesWon?: number;
  badge?: "OWNER" | "PIONEER";
  twoFactorEnabled?: boolean;
  presence: Presence;
}

export interface StoredAccount extends UserProfile {
  email: string;
  passwordHash: string;
  createdAt: number;
}

export interface DeckCardEntry {
  name: string;
  quantity: number;
  manaCost?: string;
}

export interface Deck {
  id: string;
  ownerId: string;
  name: string;
  format: LobbyFormat;
  commander: string;
  cards: DeckCardEntry[];
  updatedAt: number;
}

export interface LobbyPlayer {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  avatarImage?: string;
  accentColor?: string;
  deckId: string | null;
  deckName: string | null;
  commander: string | null;
  cards?: DeckCardEntry[];
  ready: boolean;
  host: boolean;
  bot: boolean;
  xp?: number;
  level?: number;
  gamesPlayed?: number;
  gamesWon?: number;
  honor?: number;
  badge?: "OWNER" | "PIONEER";
}

export const XP_PER_GAME = 100;
export const XP_WIN_BONUS = 250;

export function levelForXp(xp = 0) {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1;
}

export function xpForLevel(level: number) {
  return Math.max(0, level - 1) ** 2 * 100;
}

export interface LobbyMessage {
  id: string;
  author: string;
  text: string;
  createdAt: number;
}

export interface Lobby {
  id: string;
  code: string;
  name: string;
  hostId: string;
  format: LobbyFormat;
  privacy: "public" | "private";
  maxPlayers: number;
  spectatorsAllowed: boolean;
  startingLife: number;
  password: string;
  description: string;
  bracket: 1 | 2 | 3 | 4 | 5;
  gameSeed?: number;
  tags: string[];
  status: "waiting" | "in-game";
  players: LobbyPlayer[];
  messages: LobbyMessage[];
  createdAt: number;
}

export interface Friendship {
  id: string;
  fromId: string;
  toId: string;
  status: "pending" | "accepted";
}

export interface LobbyInvite {
  id: string;
  lobbyId: string;
  fromId: string;
  toId: string;
  createdAt: number;
}

export interface PlatformData {
  accounts: StoredAccount[];
  directory: UserProfile[];
  friendships: Friendship[];
  decks: Deck[];
  lobbies: Lobby[];
  invites: LobbyInvite[];
}
