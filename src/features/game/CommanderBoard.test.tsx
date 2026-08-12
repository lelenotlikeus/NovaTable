import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GameSetupPlayer } from "../../domain/commander/types";
import { CommanderBoard } from "./CommanderBoard";

const players: GameSetupPlayer[] = ["You", "Mira", "Orin", "Nia"].map((name, index) => ({
  id: `p${index}`,
  name,
  avatar: name.slice(0, 2).toUpperCase(),
  commander: index === 0 ? "Atraxa, Praetors' Voice" : `Commander ${index}`,
  cards: [{ name: "Sol Ring", quantity: 1 }, { name: "Forest", quantity: 98 }],
  local: index === 0
}));

const battlefieldBounds = rect(100, 100, 1000, 500);
const handCardBounds = rect(180, 700, 120, 168);

function renderGame() {
  const result = render(<CommanderBoard players={players} startingLife={40} lobbyName="Commander Night" onLeave={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "Draw 7" }));
  return result;
}

describe("Commander board interactions", () => {
  it("renders four seats with visible side zones instead of compressed opponent footers", () => {
    render(<CommanderBoard players={players} startingLife={40} lobbyName="Commander Night" onLeave={() => undefined} />);
    expect(document.querySelectorAll(".opponent-board")).toHaveLength(3);
    expect(document.querySelector(".local-board")).toBeInTheDocument();
    document.querySelectorAll<HTMLElement>(".opponent-zones").forEach((zones) => {
      expect(zones).toHaveTextContent("Library");
      expect(zones).toHaveTextContent("Graveyard");
      expect(zones).toHaveTextContent("Exile");
    });
    expect(document.querySelector(".opponent-board > footer")).toBeNull();
    expect(document.querySelectorAll(".mana-pool")).toHaveLength(4);
    expect(document.querySelectorAll(".player-hud__name > div > .mana-pool")).toHaveLength(4);
    expect(document.querySelector(".player-hud.is-local .mana-g img")).toHaveAttribute("src", "https://svgs.scryfall.io/card-symbols/G.svg");
    fireEvent.click(screen.getByRole("button", { name: "Add G mana" }));
    expect(document.querySelector(".player-hud.is-local .mana-g b")).toHaveTextContent("1");
  });

  it("starts with an empty hand and lets the player draw the opening seven", () => {
    render(<CommanderBoard players={players} startingLife={40} lobbyName="Commander Night" onLeave={() => undefined} />);
    expect(document.querySelector(".local-hand > span")).toHaveTextContent("0");
    fireEvent.click(screen.getByRole("button", { name: "Draw 7" }));
    expect(document.querySelector(".local-hand > span")).toHaveTextContent("7");
  });

  it("drags from hand, freely repositions, taps, previews and moves through the context menu", () => {
    renderGame();
    const battlefield = document.querySelector<HTMLElement>(".battlefield-drop")!;
    battlefield.getBoundingClientRect = vi.fn(() => battlefieldBounds);
    document.elementFromPoint = vi.fn(() => battlefield);

    let solRing = screen.getByRole("button", { name: "Sol Ring" });
    solRing.getBoundingClientRect = vi.fn(() => handCardBounds);
    solRing.setPointerCapture = vi.fn();
    fireEvent.pointerDown(solRing, { button: 0, pointerId: 1, clientX: 240, clientY: 784 });
    fireEvent.pointerMove(solRing, { pointerId: 1, clientX: 700, clientY: 350 });
    fireEvent.pointerUp(solRing, { pointerId: 1, clientX: 700, clientY: 350 });

    solRing = screen.getByRole("button", { name: "Sol Ring" });
    expect(solRing).toHaveClass("is-free");
    expect(solRing).toHaveStyle({ left: "60%", top: "50%" });

    solRing.getBoundingClientRect = vi.fn(() => rect(640, 266, 120, 168));
    solRing.setPointerCapture = vi.fn();
    fireEvent.pointerDown(solRing, { button: 0, pointerId: 2, clientX: 700, clientY: 350 });
    fireEvent.pointerMove(solRing, { pointerId: 2, clientX: 300, clientY: 220 });
    fireEvent.pointerUp(solRing, { pointerId: 2, clientX: 300, clientY: 220 });
    solRing = screen.getByRole("button", { name: "Sol Ring" });
    expect(solRing).toHaveStyle({ left: "20%", top: "24%" });

    fireEvent.doubleClick(solRing);
    solRing = screen.getByRole("button", { name: "Sol Ring, tapped" });
    expect(solRing.querySelector(".commander-card")).toHaveClass("is-tapped");
    fireEvent.doubleClick(solRing);
    expect(screen.getByRole("button", { name: "Sol Ring" }).querySelector(".commander-card")).not.toHaveClass("is-tapped");

    fireEvent.mouseEnter(solRing);
    const preview = document.querySelector<HTMLElement>(".card-preview-panel")!;
    expect(within(preview).getAllByText("Sol Ring")).toHaveLength(2);

    fireEvent.contextMenu(solRing, { clientX: 500, clientY: 300 });
    const menu = screen.getByRole("menu");
    expect(Number.parseFloat(menu.style.top) + Number.parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(window.innerHeight - 8);
    fireEvent.click(within(menu).getByRole("button", { name: "Graveyard / Sacrifice" }));
    expect(document.querySelector('[data-drop-zone="graveyard"] strong')).toHaveTextContent("1");
    expect(document.querySelector(".battlefield-drop [data-card-id]")).toBeNull();
  });

  it("drags the commander to the battlefield and back to the command zone", () => {
    renderGame();
    const battlefield = document.querySelector<HTMLElement>(".battlefield-drop")!;
    const commandZone = document.querySelector<HTMLElement>(".commander-zone")!;
    battlefield.getBoundingClientRect = vi.fn(() => battlefieldBounds);
    document.elementFromPoint = vi.fn(() => battlefield);

    let commander = screen.getByRole("button", { name: "Atraxa, Praetors' Voice" });
    commander.getBoundingClientRect = vi.fn(() => rect(20, 300, 80, 112));
    commander.setPointerCapture = vi.fn();
    fireEvent.pointerDown(commander, { button: 0, pointerId: 3, clientX: 60, clientY: 356 });
    fireEvent.pointerMove(commander, { pointerId: 3, clientX: 500, clientY: 300 });
    fireEvent.pointerUp(commander, { pointerId: 3, clientX: 500, clientY: 300 });
    expect(battlefield.querySelector('[data-card-id="p0-commander"]')).toBeInTheDocument();

    commander = screen.getByRole("button", { name: "Atraxa, Praetors' Voice" });
    commander.getBoundingClientRect = vi.fn(() => rect(440, 244, 120, 168));
    commander.setPointerCapture = vi.fn();
    document.elementFromPoint = vi.fn(() => commandZone);
    fireEvent.pointerDown(commander, { button: 0, pointerId: 4, clientX: 500, clientY: 328 });
    fireEvent.pointerMove(commander, { pointerId: 4, clientX: 60, clientY: 356 });
    fireEvent.pointerUp(commander, { pointerId: 4, clientX: 60, clientY: 356 });
    expect(commandZone.querySelector('[data-card-id="p0-commander"]')).toBeInTheDocument();
    expect(commandZone).toHaveTextContent("Tax 0");
  });

  it("draws and clears a right-drag arrow from a card to a player", () => {
    renderGame();
    const screenRoot = document.querySelector<HTMLElement>(".commander-screen")!;
    const solRing = screen.getByRole("button", { name: "Sol Ring" });
    const mira = screen.getByText("Mira").closest<HTMLElement>(".player-hud")!;
    screenRoot.setPointerCapture = vi.fn();
    solRing.getBoundingClientRect = vi.fn(() => rect(100, 600, 120, 168));
    mira.getBoundingClientRect = vi.fn(() => rect(700, 80, 360, 45));
    document.elementFromPoint = vi.fn(() => mira);

    fireEvent.pointerDown(solRing, { button: 2, pointerId: 9, clientX: 160, clientY: 684 });
    fireEvent.pointerMove(solRing, { button: 2, pointerId: 9, clientX: 880, clientY: 102 });
    fireEvent.pointerUp(solRing, { button: 2, pointerId: 9, clientX: 880, clientY: 102 });
    expect(document.querySelectorAll(".table-arrow:not(.is-draft)")).toHaveLength(1);

    fireEvent.contextMenu(document.querySelector(".table-arrow-hit")!);
    expect(document.querySelector(".table-arrow")).toBeNull();
  });

  it("allows life changes only from the local player's HUD", () => {
    renderGame();
    const localHud = document.querySelector<HTMLElement>(".player-hud.is-local")!;
    const opponentHud = screen.getByText("Mira").closest<HTMLElement>(".player-hud")!;
    expect(within(localHud).getByRole("button", { name: "Lose one life" })).toBeInTheDocument();
    expect(within(localHud).getByRole("button", { name: "Gain one life" })).toBeInTheDocument();
    expect(within(opponentHud).queryByRole("button", { name: /life/i })).toBeNull();
  });

  it("opens zone actions and drags a graveyard card back to hand", () => {
    renderGame();
    const solRing = screen.getByRole("button", { name: "Sol Ring" });
    fireEvent.contextMenu(solRing, { clientX: 500, clientY: 300 });
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "Graveyard / Sacrifice" }));

    const library = document.querySelector<HTMLElement>('[data-drop-zone="library"]')!;
    fireEvent.contextMenu(library, { clientX: 200, clientY: 300 });
    const libraryMenu = screen.getByRole("menu", { name: "Library actions" });
    expect(within(libraryMenu).getByRole("button", { name: "Draw X" })).toBeInTheDocument();
    expect(within(libraryMenu).getByRole("button", { name: /Shuffle library/ })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);

    fireEvent.click(document.querySelector<HTMLElement>('[data-drop-zone="graveyard"]')!);
    const viewer = screen.getByRole("dialog", { name: "Graveyard cards" });
    const graveyardCard = within(viewer).getByRole("button", { name: "Sol Ring" });
    const hand = document.querySelector<HTMLElement>('[data-drop-zone="hand"]')!;
    graveyardCard.getBoundingClientRect = vi.fn(() => handCardBounds);
    graveyardCard.setPointerCapture = vi.fn();
    document.elementFromPoint = vi.fn(() => hand);
    fireEvent.pointerDown(graveyardCard, { button: 0, pointerId: 12, clientX: 240, clientY: 784 });
    fireEvent.pointerMove(graveyardCard, { pointerId: 12, clientX: 800, clientY: 900 });
    fireEvent.pointerUp(graveyardCard, { pointerId: 12, clientX: 800, clientY: 900 });

    expect(within(viewer).queryByRole("button", { name: "Sol Ring" })).toBeNull();
    expect(within(hand).getByRole("button", { name: "Sol Ring" })).toBeInTheDocument();
  });

  it("reveals and directly drags the top card across library, graveyard and exile", () => {
    render(<CommanderBoard players={players} startingLife={40} lobbyName="Commander Night" onLeave={() => undefined} />);
    const library = document.querySelector<HTMLElement>('[data-drop-zone="library"]')!;
    const battlefield = document.querySelector<HTMLElement>('[data-drop-zone="battlefield"]')!;
    battlefield.getBoundingClientRect = vi.fn(() => battlefieldBounds);

    fireEvent.contextMenu(library, { clientX: 200, clientY: 300 });
    fireEvent.click(within(screen.getByRole("menu", { name: "Library actions" })).getByRole("button", { name: "Reveal top card" }));
    expect(library).toHaveTextContent("Sol Ring");

    library.getBoundingClientRect = vi.fn(() => rect(20, 300, 80, 112));
    library.setPointerCapture = vi.fn();
    document.elementFromPoint = vi.fn(() => battlefield);
    fireEvent.pointerDown(library, { button: 0, pointerId: 20, clientX: 60, clientY: 356 });
    fireEvent.pointerMove(library, { pointerId: 20, clientX: 500, clientY: 300 });
    fireEvent.pointerUp(library, { pointerId: 20, clientX: 500, clientY: 300 });

    const solRing = within(battlefield).getByRole("button", { name: "Sol Ring" });
    fireEvent.contextMenu(solRing, { clientX: 500, clientY: 300 });
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "Graveyard / Sacrifice" }));

    const graveyard = document.querySelector<HTMLElement>('[data-drop-zone="graveyard"]')!;
    const exile = document.querySelector<HTMLElement>('[data-drop-zone="exile"]')!;
    graveyard.getBoundingClientRect = vi.fn(() => rect(20, 420, 80, 112));
    graveyard.setPointerCapture = vi.fn();
    document.elementFromPoint = vi.fn(() => exile);
    fireEvent.pointerDown(graveyard, { button: 0, pointerId: 21, clientX: 60, clientY: 476 });
    fireEvent.pointerMove(graveyard, { pointerId: 21, clientX: 140, clientY: 476 });
    fireEvent.pointerUp(graveyard, { pointerId: 21, clientX: 140, clientY: 476 });
    expect(exile).toHaveTextContent("Sol Ring");

    const hand = document.querySelector<HTMLElement>('[data-drop-zone="hand"]')!;
    exile.getBoundingClientRect = vi.fn(() => rect(120, 420, 80, 112));
    exile.setPointerCapture = vi.fn();
    document.elementFromPoint = vi.fn(() => hand);
    fireEvent.pointerDown(exile, { button: 0, pointerId: 22, clientX: 160, clientY: 476 });
    fireEvent.pointerMove(exile, { pointerId: 22, clientX: 500, clientY: 700 });
    fireEvent.pointerUp(exile, { pointerId: 22, clientX: 500, clientY: 700 });
    expect(within(hand).getByRole("button", { name: "Sol Ring" })).toBeInTheDocument();
  });

  it("keeps scry views fixed when a shown card leaves the library", () => {
    render(<CommanderBoard players={players} startingLife={40} lobbyName="Commander Night" onLeave={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Look / Scry X" }));
    const prompt = screen.getByRole("dialog", { name: "Look at top cards" });
    fireEvent.change(within(prompt).getByLabelText("Number of cards"), { target: { value: "3" } });
    fireEvent.click(within(prompt).getByRole("button", { name: "Confirm" }));

    const viewer = screen.getByRole("dialog", { name: "Library cards" });
    expect(within(viewer).getAllByRole("button", { name: /Sol Ring|Forest/ })).toHaveLength(3);
    fireEvent.contextMenu(within(viewer).getByRole("button", { name: "Sol Ring" }), { clientX: 500, clientY: 300 });
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "Graveyard / Sacrifice" }));
    expect(within(viewer).getAllByRole("button", { name: "Forest" })).toHaveLength(2);
  });

  it("moves cards through the stack and exposes the extended tabletop actions", () => {
    renderGame();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Sol Ring" }), { clientX: 500, clientY: 300 });
    let menu = screen.getByRole("menu");
    expect(within(menu).getByRole("button", { name: "Clone / create copy" })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "Set annotation" })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "Set named counter…" })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("button", { name: "Move to stack" }));

    const stack = document.querySelector<HTMLElement>('[data-drop-zone="stack"]')!;
    const card = within(stack).getByRole("button", { name: "Sol Ring" });
    fireEvent.contextMenu(card, { clientX: 500, clientY: 300 });
    menu = screen.getByRole("menu");
    fireEvent.click(within(menu).getByRole("button", { name: "Turn face down" }));
    expect(within(stack).getByAltText("Face-down card")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "attackers" }));
    expect(document.querySelector(".turn-status i")).toHaveTextContent("attackers");
  });

  it("uses in-game dialogs and allows annotations and named counters to be removed", () => {
    renderGame();
    let card = screen.getByRole("button", { name: "Sol Ring" });
    fireEvent.contextMenu(card, { clientX: 500, clientY: 300 });
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "Set annotation" }));
    let dialog = screen.getByRole("dialog", { name: "Card annotation" });
    fireEvent.change(within(dialog).getByLabelText("Annotation"), { target: { value: "Mana rock for combo turn" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(screen.getAllByText(/Mana rock for combo turn/)).toHaveLength(2);

    card = screen.getByRole("button", { name: "Sol Ring" });
    fireEvent.contextMenu(card, { clientX: 500, clientY: 300 });
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "Set named counter…" }));
    dialog = screen.getByRole("dialog", { name: "Set named counter" });
    fireEvent.change(within(dialog).getByLabelText("Counter name"), { target: { value: "charge" } });
    fireEvent.change(within(dialog).getByLabelText("Amount"), { target: { value: "3" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    card = screen.getByRole("button", { name: "Sol Ring" });
    fireEvent.contextMenu(card, { clientX: 500, clientY: 300 });
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("charge")).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("button", { name: "Remove" }));
    expect(within(menu).queryByText("charge")).toBeNull();
  });

  it("sends table chat through the synchronized action log", () => {
    renderGame();
    fireEvent.change(screen.getByLabelText("Game chat message"), { target: { value: "Pass priority" } });
    fireEvent.click(screen.getByRole("button", { name: "Send game message" }));
    expect(document.querySelector(".game-log")).toHaveTextContent("You: Pass priority");
  });
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}
