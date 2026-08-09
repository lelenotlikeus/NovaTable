import type { DeckCardEntry } from "../platform/types";

export const commanderPhases = ["untap", "upkeep", "draw", "main-1", "begin-combat", "attackers", "blockers", "combat-damage", "end-combat", "main-2", "end"] as const;
export type CommanderPhase = (typeof commanderPhases)[number];
export type CommanderZone = "library" | "hand" | "battlefield" | "graveyard" | "exile" | "commander" | "stack";

export interface GameSetupPlayer {
  id: string;
  name: string;
  avatar: string;
  avatarImage?: string;
  accentColor?: string;
  commander: string;
  cards: DeckCardEntry[];
  local: boolean;
}

export interface CommanderPlayer {
  id: string;
  name: string;
  avatar: string;
  avatarImage?: string;
  accentColor?: string;
  commanderCardId: string;
  life: number;
  poison: number;
  commanderTax: number;
  commanderDamage: Record<string, number>;
  local: boolean;
}

export interface CommanderCardState {
  id: string;
  ownerId: string;
  controllerId: string;
  name: string;
  zone: CommanderZone;
  order: number;
  tapped: boolean;
  faceDown: boolean;
  counters: number;
  namedCounters: Record<string, number>;
  power: number | null;
  toughness: number | null;
  powerModifier: number;
  toughnessModifier: number;
  token: boolean;
  revealed: boolean;
  annotation: string;
  attachedTo: string | null;
  battlefieldX: number | null;
  battlefieldY: number | null;
  rotation: number;
  zIndex: number;
  transformed: boolean;
  artworkUrl?: string | null;
  backArtworkUrl?: string | null;
  palette: readonly [string, string];
}

export interface CommanderLogEntry {
  id: number;
  message: string;
  playerId: string | null;
}

export interface CommanderTarget {
  kind: "card" | "player";
  id: string;
}

export interface CommanderArrow {
  id: string;
  from: CommanderTarget;
  to: CommanderTarget;
}

export interface CommanderGameState {
  localPlayerId: string;
  playerOrder: string[];
  activePlayerId: string;
  turn: number;
  phase: CommanderPhase;
  players: Record<string, CommanderPlayer>;
  cards: Record<string, CommanderCardState>;
  arrows: CommanderArrow[];
  selectedCardId: string | null;
  log: CommanderLogEntry[];
  nextLogId: number;
}

export type CommanderGameAction =
  | { type: "DRAW_CARD"; playerId: string; count?: number }
  | { type: "MOVE_CARD"; cardId: string; zone: CommanderZone; placement?: "top" | "bottom"; x?: number; y?: number; zIndex?: number }
  | { type: "MOVE_ZONE_CARDS"; playerId: string; from: CommanderZone; zone: CommanderZone; placement?: "top" | "bottom" }
  | { type: "TAP_CARD"; cardId: string }
  | { type: "UNTAP_CARD"; cardId: string }
  | { type: "UNTAP_ALL"; playerId: string }
  | { type: "CHANGE_LIFE"; playerId: string; delta: number }
  | { type: "CHANGE_POISON"; playerId: string; delta: number }
  | { type: "CHANGE_COMMANDER_TAX"; playerId: string; delta: number }
  | { type: "CHANGE_COMMANDER_DAMAGE"; playerId: string; sourcePlayerId: string; delta: number }
  | { type: "CREATE_TOKEN"; playerId: string; name?: string; count?: number; power?: number | null; toughness?: number | null; counters?: number }
  | { type: "ADD_COUNTER"; cardId: string; delta: number }
  | { type: "MODIFY_POWER_TOUGHNESS"; cardId: string; power: number; toughness: number }
  | { type: "SET_POWER_TOUGHNESS"; cardId: string; powerModifier: number; toughnessModifier: number }
  | { type: "RESET_POWER_TOUGHNESS"; cardId: string }
  | { type: "SET_NAMED_COUNTER"; cardId: string; name: string; value: number }
  | { type: "TOGGLE_FACE_DOWN"; cardId: string }
  | { type: "TOGGLE_TRANSFORM"; cardId: string }
  | { type: "CHANGE_CONTROLLER"; cardId: string; playerId: string }
  | { type: "SET_CARD_ARTWORK"; cardId: string; artworkUrl: string | null; backArtworkUrl?: string | null }
  | { type: "CLONE_CARD"; cardId: string }
  | { type: "ATTACH_CARD"; cardId: string; targetCardId: string | null }
  | { type: "SET_ANNOTATION"; cardId: string; annotation: string }
  | { type: "ROLL_DIE"; playerId: string; sides: number; result: number }
  | { type: "FLIP_COIN"; playerId: string; result: "heads" | "tails" }
  | { type: "CHAT_MESSAGE"; playerId: string; text: string }
  | { type: "SHUFFLE_LIBRARY"; playerId: string; seed: number }
  | { type: "MILL"; playerId: string; count: number }
  | { type: "MULLIGAN"; playerId: string; seed: number; count?: number }
  | { type: "REVEAL_CARD"; cardId: string }
  | { type: "HIDE_CARD"; cardId: string }
  | { type: "ADD_ARROW"; arrow: CommanderArrow }
  | { type: "REMOVE_ARROW"; arrowId: string }
  | { type: "CLEAR_ARROWS" }
  | { type: "SELECT_CARD"; cardId: string | null }
  | { type: "SET_PHASE"; phase: CommanderPhase }
  | { type: "NEXT_PHASE" }
  | { type: "NEXT_TURN" };
