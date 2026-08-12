import { describe, expect, it } from "vitest";
import { cardsInZone, cardTextShortcuts, commanderGameReducer, createCommanderGame } from "./game";
import type { GameSetupPlayer } from "./types";

const players: GameSetupPlayer[] = ["You", "Mira", "Orin", "Nia"].map((name, index) => ({
  id: `p${index}`,
  name,
  avatar: name.slice(0, 2).toUpperCase(),
  commander: `Commander ${index}`,
  cards: [{ name: "Sol Ring", quantity: 1 }, { name: "Forest", quantity: 98 }],
  local: index === 0
}));

describe("Commander game event reducer", () => {
  it("creates a four-player 40-life game and supports core tabletop actions", () => {
    let state = createCommanderGame(players, 40);
    expect(Object.values(state.players).map((player) => player.life)).toEqual([40, 40, 40, 40]);
    expect(cardsInZone(state, "p0", "hand")).toHaveLength(0);
    expect(state.log.map((entry) => entry.message)).toEqual(["Commander game started"]);
    state = commanderGameReducer(state, { type: "DRAW_CARD", playerId: "p0", count: 7 });
    expect(cardsInZone(state, "p0", "hand")).toHaveLength(7);

    const card = cardsInZone(state, "p0", "hand")[0];
    state = commanderGameReducer(state, { type: "MOVE_CARD", cardId: card.id, zone: "battlefield", x: 27, y: 68 });
    state = commanderGameReducer(state, { type: "TAP_CARD", cardId: card.id });
    state = commanderGameReducer(state, { type: "ADD_COUNTER", cardId: card.id, delta: 1 });
    state = commanderGameReducer(state, { type: "CREATE_TOKEN", playerId: "p0" });
    state = commanderGameReducer(state, { type: "CHANGE_LIFE", playerId: "p0", delta: -3 });
    state = commanderGameReducer(state, { type: "ADD_ARROW", arrow: { id: "attack-1", from: { kind: "card", id: card.id }, to: { kind: "player", id: "p1" } } });
    state = commanderGameReducer(state, { type: "NEXT_PHASE" });

    expect(state.cards[card.id].tapped).toBe(true);
    expect(state.cards[card.id].rotation).toBe(90);
    expect(state.cards[card.id].counters).toBe(1);
    expect([state.cards[card.id].battlefieldX, state.cards[card.id].battlefieldY]).toEqual([27, 68]);
    expect(cardsInZone(state, "p0", "battlefield")).toHaveLength(2);
    expect(state.players.p0.life).toBe(37);
    expect(state.arrows).toHaveLength(1);
    expect(state.phase).toBe("upkeep");
    expect(state.log.some((entry) => /moved to battlefield|tapped|phase/.test(entry.message))).toBe(false);

    state = commanderGameReducer(state, { type: "CLEAR_ARROWS" });
    expect(state.arrows).toHaveLength(0);

    state = commanderGameReducer(state, { type: "MOVE_CARD", cardId: card.id, zone: "battlefield", x: 73.5, y: 31.25, zIndex: 12 });
    state = commanderGameReducer(state, { type: "UNTAP_CARD", cardId: card.id });
    expect([state.cards[card.id].battlefieldX, state.cards[card.id].battlefieldY, state.cards[card.id].zIndex]).toEqual([73.5, 31.25, 12]);
    expect(state.cards[card.id].rotation).toBe(0);

    state = commanderGameReducer(state, { type: "MOVE_CARD", cardId: card.id, zone: "graveyard" });
    expect(state.cards[card.id]).toMatchObject({ zone: "graveyard", tapped: false, rotation: 0, battlefieldX: null, battlefieldY: null });
  });

  it("creates named tokens and exposes common manual shortcuts from Oracle text", () => {
    let state = createCommanderGame(players, 40);
    state = commanderGameReducer(state, { type: "CREATE_TOKEN", playerId: "p0", name: "Treasure", count: 2, power: null, toughness: null });
    const tokens = cardsInZone(state, "p0", "battlefield").filter((card) => card.token);
    expect(tokens).toHaveLength(2);
    expect(cardsInZone(state, "p0", "battlefield")[0]).toMatchObject({ name: "Treasure", power: null, toughness: null });
    state = commanderGameReducer(state, { type: "MOVE_CARD", cardId: tokens[0].id, zone: "graveyard" });
    state = commanderGameReducer(state, { type: "MOVE_CARD", cardId: tokens[1].id, zone: "exile" });
    expect(state.cards[tokens[0].id]).toBeUndefined();
    expect(state.cards[tokens[1].id]).toBeUndefined();
    expect(cardsInZone(state, "p0", "graveyard").filter((card) => card.token)).toHaveLength(0);
    expect(cardsInZone(state, "p0", "exile").filter((card) => card.token)).toHaveLength(0);

    expect(cardTextShortcuts("Create two Treasure tokens. Investigate. Draw two cards. You gain 3 life. Mill two cards.")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "token", name: "Treasure", count: 2 }),
      expect.objectContaining({ kind: "token", name: "Clue", count: 1 }),
      expect.objectContaining({ kind: "draw", count: 2 }),
      expect.objectContaining({ kind: "life", amount: 3 }),
      expect.objectContaining({ kind: "mill", count: 2 })
    ]));
    expect(cardTextShortcuts("Create two 1/1 white Soldier creature tokens.")).toContainEqual(expect.objectContaining({ kind: "token", name: "Soldier", count: 2, power: 1, toughness: 1 }));
  });

  it("supports stack, face-down cards, copies, attachments, annotations and named counters", () => {
    let state = createCommanderGame(players, 40);
    state = commanderGameReducer(state, { type: "DRAW_CARD", playerId: "p0", count: 7 });
    const [a, b] = cardsInZone(state, "p0", "hand");
    state = commanderGameReducer(state, { type: "MOVE_CARD", cardId: a.id, zone: "battlefield" });
    state = commanderGameReducer(state, { type: "MOVE_CARD", cardId: b.id, zone: "battlefield" });
    state = commanderGameReducer(state, { type: "TOGGLE_FACE_DOWN", cardId: a.id });
    state = commanderGameReducer(state, { type: "SET_NAMED_COUNTER", cardId: a.id, name: "charge", value: 3 });
    state = commanderGameReducer(state, { type: "SET_ANNOTATION", cardId: a.id, annotation: "Copied by Saheeli" });
    state = commanderGameReducer(state, { type: "ATTACH_CARD", cardId: a.id, targetCardId: b.id });
    state = commanderGameReducer(state, { type: "CLONE_CARD", cardId: a.id });

    expect(state.cards[a.id]).toMatchObject({ faceDown: true, namedCounters: { charge: 3 }, annotation: "Copied by Saheeli", attachedTo: b.id });
    const copy = Object.values(state.cards).find((card) => card.id.startsWith("copy-"))!;
    expect(copy).toMatchObject({ name: a.name, token: true, faceDown: false, counters: 0 });
    state = commanderGameReducer(state, { type: "MOVE_CARD", cardId: copy.id, zone: "graveyard" });
    expect(state.cards[copy.id]).toBeUndefined();

    state = commanderGameReducer(state, { type: "MOVE_CARD", cardId: b.id, zone: "graveyard" });
    expect(state.cards[a.id].attachedTo).toBeNull();
    state = commanderGameReducer(state, { type: "MOVE_CARD", cardId: a.id, zone: "stack" });
    expect(cardsInZone(state, "p0", "stack")).toHaveLength(1);
    state = commanderGameReducer(state, { type: "ROLL_DIE", playerId: "p0", sides: 20, result: 17 });
    state = commanderGameReducer(state, { type: "FLIP_COIN", playerId: "p0", result: "heads" });
    expect(state.log.at(-2)?.message).toContain("17 on a d20");
    expect(state.log.at(-1)?.message).toContain("heads");
  });

  it("moves complete zones and permits manual phase correction", () => {
    let state = createCommanderGame(players, 40);
    state = commanderGameReducer(state, { type: "DRAW_CARD", playerId: "p0", count: 7 });
    state = commanderGameReducer(state, { type: "MOVE_ZONE_CARDS", playerId: "p0", from: "hand", zone: "graveyard" });
    expect(cardsInZone(state, "p0", "hand")).toHaveLength(0);
    expect(cardsInZone(state, "p0", "graveyard")).toHaveLength(7);
    state = commanderGameReducer(state, { type: "MOVE_ZONE_CARDS", playerId: "p0", from: "graveyard", zone: "library", placement: "bottom" });
    expect(cardsInZone(state, "p0", "graveyard")).toHaveLength(0);
    expect(cardsInZone(state, "p0", "library")).toHaveLength(99);
    state = commanderGameReducer(state, { type: "SET_PHASE", phase: "attackers" });
    expect(state.phase).toBe("attackers");
  });

  it("does not invent Wastes and shuffles each new game from the shared seed", () => {
    const shortDeck = players.map((player) => ({ ...player, cards: [{ name: "Sol Ring", quantity: 1 }, { name: "Forest", quantity: 9 }] }));
    const first = createCommanderGame(shortDeck, 40, 123);
    const second = createCommanderGame(shortDeck, 40, 456);
    expect(cardsInZone(first, "p0", "library")).toHaveLength(10);
    expect(cardsInZone(first, "p0", "library").some((card) => card.name === "Wastes")).toBe(false);
    expect(cardsInZone(first, "p0", "library").map((card) => card.id)).not.toEqual(cardsInZone(second, "p0", "library").map((card) => card.id));
  });

  it("adds mana for tapped basic lands and spends available mana on played spells", () => {
    const manaPlayers: GameSetupPlayer[] = players.map((player, index) => index ? player : { ...player, manaColors: ["U"], cards: [
      { name: "Island", quantity: 1 }, { name: "Counterspell", quantity: 1, manaCost: "{U}{U}" }
    ] });
    let state = createCommanderGame(manaPlayers, 40);
    state = commanderGameReducer(state, { type: "DRAW_CARD", playerId: "p0", count: 2 });
    const island = cardsInZone(state, "p0", "hand").find((card) => card.name === "Island")!;
    const counterspell = cardsInZone(state, "p0", "hand").find((card) => card.name === "Counterspell")!;
    state = commanderGameReducer(state, { type: "MOVE_CARD", cardId: island.id, zone: "battlefield" });
    state = commanderGameReducer(state, { type: "TAP_CARD", cardId: island.id });
    state = commanderGameReducer(state, { type: "TAP_CARD", cardId: island.id });
    expect(state.players.p0.manaPool.U).toBe(1);
    state = commanderGameReducer(state, { type: "CHANGE_MANA", playerId: "p0", color: "U", delta: 1 });
    state = commanderGameReducer(state, { type: "MOVE_CARD", cardId: counterspell.id, zone: "stack", manaCost: "{U}{U}" });
    expect(state.players.p0.manaPool.U).toBe(0);
    state = commanderGameReducer(state, { type: "CHANGE_MANA", playerId: "p0", color: "U", delta: -1 });
    expect(state.players.p0.manaPool.U).toBe(0);
  });

  it("supports complete combat steps, control changes, transforms and shared artwork", () => {
    let state = createCommanderGame(players, 40);
    const card = cardsInZone(state, "p0", "library")[0];
    state = commanderGameReducer(state, { type: "MOVE_CARD", cardId: card.id, zone: "battlefield" });
    state = commanderGameReducer(state, { type: "CHANGE_CONTROLLER", cardId: card.id, playerId: "p1" });
    expect(cardsInZone(state, "p1", "battlefield")).toContainEqual(expect.objectContaining({ id: card.id }));
    state = commanderGameReducer(state, { type: "TOGGLE_TRANSFORM", cardId: card.id });
    state = commanderGameReducer(state, { type: "SET_CARD_ARTWORK", cardId: card.id, artworkUrl: "front.jpg", backArtworkUrl: "back.jpg" });
    expect(state.cards[card.id]).toMatchObject({ transformed: true, artworkUrl: "front.jpg", backArtworkUrl: "back.jpg" });
    state = commanderGameReducer(state, { type: "SET_PHASE", phase: "begin-combat" });
    state = commanderGameReducer(state, { type: "NEXT_PHASE" });
    expect(state.phase).toBe("attackers");
    state = commanderGameReducer(state, { type: "MOVE_CARD", cardId: card.id, zone: "graveyard" });
    expect(cardsInZone(state, "p0", "graveyard")).toContainEqual(expect.objectContaining({ id: card.id, controllerId: "p0", transformed: false }));
  });
});
