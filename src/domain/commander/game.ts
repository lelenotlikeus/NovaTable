import {
  commanderPhases,
  type CommanderCardState,
  type CommanderGameAction,
  type CommanderGameState,
  type CommanderZone,
  type GameSetupPlayer
} from "./types";

const palettes = [
  ["#284d78", "#72c7f2"], ["#4f2b65", "#cb78ee"],
  ["#315a42", "#78d29a"], ["#6b342c", "#ef846c"],
  ["#6b5727", "#e7c667"], ["#293d42", "#7ac9c4"]
] as const;

function palette(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palettes[hash % palettes.length];
}

function expandedLibrary(player: GameSetupPlayer) {
  const names = player.cards.flatMap((entry) => Array.from({ length: entry.quantity }, () => entry.name));
  const commanderIndex = names.findIndex((name) => name.toLowerCase() === player.commander.toLowerCase());
  if (commanderIndex >= 0) names.splice(commanderIndex, 1);
  while (names.length < 99) names.push("Wastes");
  return names.slice(0, 99);
}

function reorderLibrary(cards: Record<string, CommanderCardState>, playerId: string, seed: number) {
  const library = Object.values(cards).filter((card) => card.ownerId === playerId && card.zone === "library");
  let value = seed >>> 0;
  for (let index = library.length - 1; index > 0; index--) {
    value = (value * 1664525 + 1013904223) >>> 0;
    const swap = value % (index + 1);
    [library[index], library[swap]] = [library[swap], library[index]];
  }
  return { ...cards, ...Object.fromEntries(library.map((card, order) => [card.id, { ...card, order }])) };
}

function zoneEdge(cards: Record<string, CommanderCardState>, ownerId: string, zone: CommanderZone, edge: "min" | "max") {
  const orders = Object.values(cards).filter((card) => card.zone === zone && (zone === "stack" || card.ownerId === ownerId)).map((card) => card.order);
  if (!orders.length) return 0;
  return edge === "min" ? Math.min(...orders) : Math.max(...orders);
}

function log(state: CommanderGameState, message: string, playerId: string | null = null): CommanderGameState {
  return {
    ...state,
    log: [...state.log, { id: state.nextLogId, message, playerId }].slice(-80),
    nextLogId: state.nextLogId + 1
  };
}

function playerName(state: CommanderGameState, id: string) {
  return state.players[id]?.name ?? "Player";
}

function draw(state: CommanderGameState, playerId: string, count: number) {
  const cards = { ...state.cards };
  const library = Object.values(cards)
    .filter((card) => card.ownerId === playerId && card.zone === "library")
    .sort((a, b) => a.order - b.order)
    .slice(0, count);
  const handOrder = zoneEdge(cards, playerId, "hand", "max");
  library.forEach((card, index) => {
    cards[card.id] = { ...card, zone: "hand", order: handOrder + index + 1, revealed: false };
  });
  return log({ ...state, cards }, `${playerName(state, playerId)} drew ${library.length} card${library.length === 1 ? "" : "s"}`, playerId);
}

export function createCommanderGame(players: GameSetupPlayer[], startingLife = 40): CommanderGameState {
  if (players.length !== 4) throw new Error("Commander games require four players in this milestone.");
  const cards: Record<string, CommanderCardState> = {};
  const gamePlayers = Object.fromEntries(players.map((player, playerIndex) => {
    const commanderId = `${player.id}-commander`;
    cards[commanderId] = {
      id: commanderId, ownerId: player.id, name: player.commander, zone: "commander", order: 0,
      tapped: false, faceDown: false, counters: 0, namedCounters: {}, power: null, toughness: null, powerModifier: 0, toughnessModifier: 0,
      token: false, revealed: true, annotation: "", attachedTo: null, battlefieldX: null, battlefieldY: null,
      rotation: 0, zIndex: 0,
      palette: palette(player.commander)
    };
    expandedLibrary(player).forEach((name, index) => {
      const cardId = `${player.id}-card-${index}`;
      cards[cardId] = {
        id: cardId, ownerId: player.id, name, zone: "library", order: index,
        tapped: false, faceDown: false, counters: 0, namedCounters: {}, power: null,
        toughness: null, powerModifier: 0, toughnessModifier: 0,
        token: false, revealed: false, annotation: "", attachedTo: null, battlefieldX: null, battlefieldY: null,
        rotation: 0, zIndex: 0,
        palette: palette(name)
      };
    });
    return [player.id, {
      id: player.id, name: player.name, avatar: player.avatar, avatarImage: player.avatarImage, accentColor: player.accentColor, commanderCardId: commanderId,
      life: startingLife, poison: 0, commanderTax: 0,
      commanderDamage: Object.fromEntries(players.filter((other) => other.id !== player.id).map((other) => [other.id, 0])),
      local: player.local
    }];
  }));
  let state: CommanderGameState = {
    localPlayerId: players.find((player) => player.local)?.id ?? players[0].id,
    playerOrder: players.map((player) => player.id), activePlayerId: players[0].id,
    turn: 1, phase: "untap", players: gamePlayers, cards, arrows: [], selectedCardId: null,
    log: [{ id: 1, message: "Commander game started", playerId: null }], nextLogId: 2
  };
  return state;
}

export function commanderGameReducer(state: CommanderGameState, action: CommanderGameAction): CommanderGameState {
  switch (action.type) {
    case "ADD_ARROW": return { ...state, arrows: [...state.arrows.filter((arrow) => arrow.id !== action.arrow.id), action.arrow] };
    case "REMOVE_ARROW": return { ...state, arrows: state.arrows.filter((arrow) => arrow.id !== action.arrowId) };
    case "CLEAR_ARROWS": return { ...state, arrows: [] };
    case "SELECT_CARD": return { ...state, selectedCardId: action.cardId };
    case "DRAW_CARD": return draw(state, action.playerId, action.count ?? 1);
    case "CHANGE_LIFE": {
      const player = state.players[action.playerId];
      return { ...state, players: { ...state.players, [player.id]: { ...player, life: player.life + action.delta } } };
    }
    case "CHANGE_POISON": {
      const player = state.players[action.playerId];
      return { ...state, players: { ...state.players, [player.id]: { ...player, poison: Math.max(0, player.poison + action.delta) } } };
    }
    case "CHANGE_COMMANDER_TAX": {
      const player = state.players[action.playerId];
      return { ...state, players: { ...state.players, [player.id]: { ...player, commanderTax: Math.max(0, player.commanderTax + action.delta) } } };
    }
    case "CHANGE_COMMANDER_DAMAGE": {
      const player = state.players[action.playerId];
      return { ...state, players: { ...state.players, [player.id]: { ...player,
        commanderDamage: { ...player.commanderDamage, [action.sourcePlayerId]: Math.max(0, (player.commanderDamage[action.sourcePlayerId] ?? 0) + action.delta) }
      } } };
    }
    case "MOVE_CARD": {
      const card = state.cards[action.cardId]; if (!card) return state;
      const order = action.zone === "library"
        ? action.placement === "top" ? zoneEdge(state.cards, card.ownerId, "library", "min") - 1 : zoneEdge(state.cards, card.ownerId, "library", "max") + 1
        : zoneEdge(state.cards, card.ownerId, action.zone, "max") + 1;
      const cards = Object.fromEntries(Object.entries(state.cards).map(([id, candidate]) => [id,
        candidate.attachedTo === card.id ? { ...candidate, attachedTo: null } : candidate]));
      if (card.token && action.zone !== "battlefield") {
        delete cards[card.id];
        return { ...state, selectedCardId: null, cards, arrows: state.arrows.filter((arrow) =>
          !(arrow.from.kind === "card" && arrow.from.id === card.id) && !(arrow.to.kind === "card" && arrow.to.id === card.id)) };
      }
      cards[card.id] = {
        ...card,
        zone: action.zone,
        order,
        tapped: action.zone === "battlefield" ? card.tapped : false,
        attachedTo: action.zone === "battlefield" ? card.attachedTo : null,
        revealed: action.zone === "hand" || action.zone === "library" ? false : true,
        battlefieldX: action.zone === "battlefield" ? action.x ?? card.battlefieldX ?? 50 : null,
        battlefieldY: action.zone === "battlefield" ? action.y ?? card.battlefieldY ?? 50 : null,
        rotation: action.zone === "battlefield" ? card.rotation : 0,
        zIndex: action.zone === "battlefield" ? action.zIndex ?? card.zIndex : 0
      };
      const next = { ...state, selectedCardId: null, cards };
      return action.zone === "battlefield" || action.zone === card.zone
        ? next
        : log(next, `${card.name} moved to ${action.zone}`, card.ownerId);
    }
    case "MOVE_ZONE_CARDS": {
      const moving = cardsInZone(state, action.playerId, action.from);
      if (!moving.length || action.from === action.zone) return state;
      const cards = { ...state.cards };
      const firstOrder = action.zone === "library" && action.placement === "top"
        ? zoneEdge(cards, action.playerId, action.zone, "min") - moving.length
        : zoneEdge(cards, action.playerId, action.zone, "max") + 1;
      moving.forEach((card, index) => {
        if (card.token && action.zone !== "battlefield") delete cards[card.id];
        else cards[card.id] = { ...card, zone: action.zone, order: firstOrder + index,
          tapped: false, attachedTo: null, battlefieldX: null, battlefieldY: null, rotation: 0, zIndex: 0,
          revealed: action.zone !== "hand" && action.zone !== "library" };
      });
      const arrows = state.arrows.filter((arrow) =>
        (arrow.from.kind !== "card" || cards[arrow.from.id]) && (arrow.to.kind !== "card" || cards[arrow.to.id]));
      return log({ ...state, cards, arrows }, `${playerName(state, action.playerId)} moved ${moving.length} cards from ${action.from} to ${action.zone}`, action.playerId);
    }
    case "TAP_CARD":
    case "UNTAP_CARD": {
      const card = state.cards[action.cardId]; if (!card || card.zone !== "battlefield") return state;
      const tapped = action.type === "TAP_CARD";
      return { ...state, cards: { ...state.cards, [card.id]: { ...card, tapped, rotation: tapped ? 90 : 0 } } };
    }
    case "UNTAP_ALL": {
      const cards = Object.fromEntries(Object.entries(state.cards).map(([id, card]) => [id,
        card.ownerId === action.playerId && card.zone === "battlefield" ? { ...card, tapped: false, rotation: 0 } : card]));
      return { ...state, cards };
    }
    case "ADD_COUNTER": {
      const card = state.cards[action.cardId]; if (!card) return state;
      return { ...state, cards: { ...state.cards, [card.id]: { ...card, counters: Math.max(0, card.counters + action.delta) } } };
    }
    case "MODIFY_POWER_TOUGHNESS": {
      const card = state.cards[action.cardId]; if (!card) return state;
      return { ...state, cards: { ...state.cards, [card.id]: { ...card,
        powerModifier: card.powerModifier + action.power, toughnessModifier: card.toughnessModifier + action.toughness } } };
    }
    case "SET_POWER_TOUGHNESS": {
      const card = state.cards[action.cardId]; if (!card) return state;
      return { ...state, cards: { ...state.cards, [card.id]: { ...card, powerModifier: action.powerModifier, toughnessModifier: action.toughnessModifier } } };
    }
    case "RESET_POWER_TOUGHNESS": {
      const card = state.cards[action.cardId]; if (!card) return state;
      return { ...state, cards: { ...state.cards, [card.id]: { ...card, powerModifier: 0, toughnessModifier: 0 } } };
    }
    case "SET_NAMED_COUNTER": {
      const card = state.cards[action.cardId]; if (!card) return state;
      const name = action.name.trim(); if (!name) return state;
      const namedCounters = { ...card.namedCounters };
      if (action.value > 0) namedCounters[name] = Math.floor(action.value); else delete namedCounters[name];
      return { ...state, cards: { ...state.cards, [card.id]: { ...card, namedCounters } } };
    }
    case "TOGGLE_FACE_DOWN": {
      const card = state.cards[action.cardId]; if (!card) return state;
      return log({ ...state, cards: { ...state.cards, [card.id]: { ...card, faceDown: !card.faceDown } } }, `${card.name} turned ${card.faceDown ? "face up" : "face down"}`, card.ownerId);
    }
    case "CLONE_CARD": {
      const card = state.cards[action.cardId]; if (!card) return state;
      const id = `copy-${state.nextLogId}-${card.id}`;
      const clone: CommanderCardState = { ...card, id, token: true, tapped: false, faceDown: false, counters: 0, namedCounters: {}, annotation: "", attachedTo: null,
        order: zoneEdge(state.cards, card.ownerId, card.zone, "max") + 1,
        battlefieldX: card.zone === "battlefield" ? Math.min(94, (card.battlefieldX ?? 50) + 5) : null,
        battlefieldY: card.zone === "battlefield" ? Math.min(92, (card.battlefieldY ?? 50) + 5) : null,
        rotation: 0, zIndex: card.zIndex + 1 };
      return log({ ...state, cards: { ...state.cards, [id]: clone } }, `${playerName(state, card.ownerId)} copied ${card.name}`, card.ownerId);
    }
    case "ATTACH_CARD": {
      const card = state.cards[action.cardId];
      const target = action.targetCardId ? state.cards[action.targetCardId] : null;
      if (!card || (action.targetCardId && (!target || target.zone !== "battlefield"))) return state;
      return log({ ...state, cards: { ...state.cards, [card.id]: { ...card, attachedTo: action.targetCardId } } },
        action.targetCardId ? `${card.name} attached to ${target!.name}` : `${card.name} unattached`, card.ownerId);
    }
    case "SET_ANNOTATION": {
      const card = state.cards[action.cardId]; if (!card) return state;
      return log({ ...state, cards: { ...state.cards, [card.id]: { ...card, annotation: action.annotation.trim() } } }, `${card.name} annotation updated`, card.ownerId);
    }
    case "CREATE_TOKEN": {
      const name = action.name?.trim() || "Soldier";
      const count = Math.max(1, Math.min(20, Math.floor(action.count ?? 1)));
      const power = action.power === undefined ? name === "Soldier" ? 1 : null : action.power;
      const toughness = action.toughness === undefined ? name === "Soldier" ? 1 : null : action.toughness;
      const cards = { ...state.cards };
      const firstOrder = zoneEdge(cards, action.playerId, "battlefield", "max") + 1;
      for (let index = 0; index < count; index++) {
        const cardId = `token-${state.nextLogId}-${action.playerId}-${index}`;
        cards[cardId] = {
          id: cardId, ownerId: action.playerId, name, zone: "battlefield", order: firstOrder + index,
          tapped: false, faceDown: false, counters: Math.max(0, action.counters ?? 0), namedCounters: {}, power, toughness, powerModifier: 0, toughnessModifier: 0,
          token: true, revealed: true, annotation: "", attachedTo: null,
          battlefieldX: 28 + ((state.nextLogId * 13 + index * 9) % 55), battlefieldY: 52 + (index % 2) * 8,
          rotation: 0, zIndex: state.nextLogId + index,
          palette: palette(name)
        };
      }
      const stats = power !== null && toughness !== null ? `${power}/${toughness} ` : "";
      return log({ ...state, cards }, `${playerName(state, action.playerId)} created ${count} ${stats}${name} token${count === 1 ? "" : "s"}`, action.playerId);
    }
    case "SHUFFLE_LIBRARY":
      return log({ ...state, cards: reorderLibrary(state.cards, action.playerId, action.seed) }, `${playerName(state, action.playerId)} shuffled`, action.playerId);
    case "MILL": {
      const cards = { ...state.cards };
      Object.values(cards).filter((card) => card.ownerId === action.playerId && card.zone === "library")
        .sort((a, b) => a.order - b.order).slice(0, action.count)
        .forEach((card, index) => { cards[card.id] = { ...card, zone: "graveyard", order: zoneEdge(cards, action.playerId, "graveyard", "max") + index + 1, revealed: true }; });
      return log({ ...state, cards }, `${playerName(state, action.playerId)} milled ${action.count}`, action.playerId);
    }
    case "MULLIGAN": {
      let cards = { ...state.cards };
      Object.values(cards).filter((card) => card.ownerId === action.playerId && card.zone === "hand")
        .forEach((card) => { cards[card.id] = { ...card, zone: "library" }; });
      cards = reorderLibrary(cards, action.playerId, action.seed);
      return draw(log({ ...state, cards }, `${playerName(state, action.playerId)} took a mulligan`, action.playerId), action.playerId, action.count ?? 7);
    }
    case "REVEAL_CARD": {
      const card = state.cards[action.cardId]; if (!card) return state;
      return log({ ...state, cards: { ...state.cards, [card.id]: { ...card, revealed: true } } }, `${playerName(state, card.ownerId)} revealed ${card.name}`, card.ownerId);
    }
    case "HIDE_CARD": {
      const card = state.cards[action.cardId]; if (!card) return state;
      return log({ ...state, cards: { ...state.cards, [card.id]: { ...card, revealed: false } } }, `${playerName(state, card.ownerId)} hid ${card.name}`, card.ownerId);
    }
    case "ROLL_DIE":
      return log(state, `${playerName(state, action.playerId)} rolled ${action.result} on a d${action.sides}`, action.playerId);
    case "FLIP_COIN":
      return log(state, `${playerName(state, action.playerId)} flipped ${action.result}`, action.playerId);
    case "CHAT_MESSAGE": {
      const text = action.text.trim().slice(0, 500);
      return text ? log(state, `${playerName(state, action.playerId)}: ${text}`, action.playerId) : state;
    }
    case "SET_PHASE":
      return { ...state, phase: action.phase };
    case "NEXT_PHASE": {
      const index = commanderPhases.indexOf(state.phase);
      if (index === commanderPhases.length - 1) return commanderGameReducer(state, { type: "NEXT_TURN" });
      const phase = commanderPhases[index + 1];
      return { ...state, phase };
    }
    case "NEXT_TURN": {
      const index = state.playerOrder.indexOf(state.activePlayerId);
      const activePlayerId = state.playerOrder[(index + 1) % state.playerOrder.length];
      return log({ ...state, activePlayerId, turn: state.turn + 1, phase: "untap" }, `Turn ${state.turn + 1}: ${playerName(state, activePlayerId)}`, activePlayerId);
    }
  }
}

export function cardsInZone(state: CommanderGameState, playerId: string, zone: CommanderZone) {
  return Object.values(state.cards).filter((card) => card.ownerId === playerId && card.zone === zone).sort((a, b) => a.order - b.order);
}

export type CardTextShortcut =
  | { kind: "token"; label: string; name: string; count: number; power: number | null; toughness: number | null }
  | { kind: "draw" | "mill"; label: string; count: number }
  | { kind: "life"; label: string; amount: number }
  | { kind: "counter"; label: string };

const amounts: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, x: 1 };
const namedTokens = [
  "Treasure", "Blood", "Clue", "Food", "Map", "Powerstone", "Gold", "Junk", "Shard",
  "Incubator", "Zombie Army", "Phyrexian Mite", "Eldrazi Spawn", "Eldrazi Scion", "Thopter",
  "Servo", "Construct", "Soldier", "Spirit", "Zombie", "Goblin", "Saproling", "Beast", "Bird"
];

function amount(value: string) { return Number(value) || amounts[value.toLocaleLowerCase()] || 1; }
function escapePattern(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Manual tabletop shortcuts only: this intentionally does not evaluate targets, costs or replacement effects. */
export function cardTextShortcuts(oracleText: string): CardTextShortcut[] {
  const shortcuts: CardTextShortcut[] = [];
  const seen = new Set<string>();
  const add = (key: string, shortcut: CardTextShortcut) => { if (!seen.has(key)) { seen.add(key); shortcuts.push(shortcut); } };
  const cleanText = oracleText.replace(/\([^)]*\)/g, "");

  for (const sentence of cleanText.split(/[.\n]/).filter(Boolean)) {
    if (/\binvestigate\b/i.test(sentence)) add("token:Clue:1", { kind: "token", label: "Investigate — create a Clue", name: "Clue", count: 1, power: null, toughness: null });
    if (!/\bcreate(?:s)?\b/i.test(sentence)) continue;

    for (const name of namedTokens) {
      const match = sentence.match(new RegExp(`\\b(a|an|one|two|three|four|five|\\d+|x)\\s+(?:tapped\\s+)?${escapePattern(name)}\\s+tokens?\\b`, "i"));
      if (!match) continue;
      const count = amount(match[1]);
      add(`token:${name}:${count}`, { kind: "token", label: `Create ${match[1].toLocaleLowerCase() === "x" ? "X " : count > 1 ? `${count} ` : "a "}${name} token${count > 1 ? "s" : ""}`, name, count, power: null, toughness: null });
    }

    for (const match of sentence.matchAll(/\b(a|an|one|two|three|four|five|\d+|x)\s+([^,;]+?)\s+tokens?\b/gi)) {
      const stats = match[2].match(/(\d+)\s*\/\s*(\d+)/);
      let name = match[2]
        .replace(/\d+\s*\/\s*\d+/g, "")
        .replace(/\b(?:tapped|attacking|colorless|white|blue|black|red|green|legendary|artifact|enchantment|creature)\b/gi, "")
        .replace(/\s+/g, " ").trim();
      const known = namedTokens.find((token) => new RegExp(`\\b${escapePattern(token)}\\b`, "i").test(name));
      if (known) name = known;
      if (!name || /\bcopy\b/i.test(name)) continue;
      const count = amount(match[1]);
      const power = stats ? Number(stats[1]) : null;
      const toughness = stats ? Number(stats[2]) : null;
      add(`token:${name}:${count}`, { kind: "token", label: `Create ${count > 1 ? `${count} ` : "a "}${power !== null ? `${power}/${toughness} ` : ""}${name} token${count > 1 ? "s" : ""}`, name, count, power, toughness });
    }
  }

  for (const match of cleanText.matchAll(/\bdraw (a|one|two|three|four|five|\d+) cards?\b/gi)) {
    const count = amount(match[1]); add(`draw:${count}`, { kind: "draw", label: `Draw ${count} card${count === 1 ? "" : "s"}`, count });
  }
  for (const match of cleanText.matchAll(/\b(?:you )?mill (one|two|three|four|five|\d+) cards?\b/gi)) {
    const count = amount(match[1]); add(`mill:${count}`, { kind: "mill", label: `Mill yourself ${count}`, count });
  }
  for (const match of cleanText.matchAll(/\byou gain (one|two|three|four|five|\d+) life\b/gi)) {
    const gained = amount(match[1]); add(`life:${gained}`, { kind: "life", label: `Gain ${gained} life`, amount: gained });
  }
  if (/\+1\/\+1 counter/i.test(cleanText)) add("counter:+1", { kind: "counter", label: "Add a +1/+1 counter" });
  return shortcuts;
}
