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
  email: string;
  username: string;
  displayName: string;
  avatar: string;
  avatarImage?: string;
  accentColor?: string;
  bio?: string;
  theme?: InterfaceTheme;
  honor?: number;
  presence: Presence;
}

export interface StoredAccount extends UserProfile {
  passwordHash: string;
  createdAt: number;
}

export interface DeckCardEntry {
  name: string;
  quantity: number;
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
