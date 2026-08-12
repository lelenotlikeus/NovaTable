import {
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useReducer,
  useRef,
  useState
} from "react";
import {
  Archive, ChevronRight, CircleDot, CopyPlus, Eye, Hand, Layers3,
  Minus, Plus, RotateCcw, Shuffle, Skull, Sparkles, X, Dices, Coins, Send
} from "lucide-react";
import {
  cardTextShortcuts,
  cardsInZone,
  commanderGameReducer,
  createCommanderGame
} from "../../domain/commander/game";
import {
  commanderPhases,
  type CommanderCardState,
  type CommanderArrow,
  type CommanderGameAction,
  type CommanderGameState,
  type CommanderTarget,
  type CommanderZone,
  type GameSetupPlayer,
  type ManaColor
} from "../../domain/commander/types";
import { CardArtworkPicker, useCardRecord } from "../cards/CardArtwork";
import { FullscreenButton } from "../shell/FullscreenButton";
import { gameActions, remoteApiEnabled, sendGameAction, submitHonor } from "../../infrastructure/remoteLobby";

interface CardDrag {
  cardId: string;
  pointerId: number;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  centerOffsetX: number;
  centerOffsetY: number;
  started: boolean;
}

interface CardMenuState { cardId: string; x: number; y: number }
interface ZoneMenuState { zone: "library" | "hand" | "graveyard" | "exile"; x: number; y: number }
interface ViewedZoneState { playerId: string; zone: ZoneMenuState["zone"]; cardIds?: string[] }
interface ArrowDraft { from: CommanderTarget; pointerId: number; startX: number; startY: number; clientX: number; clientY: number; started: boolean }
interface GamePromptField { key: string; label: string; value?: string; type?: "text" | "number"; min?: number; max?: number; multiline?: boolean; required?: boolean; options?: Array<{ value: string; label: string }> }
interface GamePromptConfig { title: string; description?: string; fields: GamePromptField[]; onSubmit: (values: Record<string, string>) => void }

function contextMenuStyle(position: { x: number; y: number }, preferredHeight: number): CSSProperties {
  const top = Math.max(8, Math.min(position.y, window.innerHeight - preferredHeight));
  return {
    left: Math.max(8, Math.min(position.x, window.innerWidth - 250)),
    top,
    maxHeight: Math.max(160, window.innerHeight - top - 8)
  };
}

function battlefieldPlacement(card: CommanderCardState, battlefield: CommanderCardState[], fallback: readonly [number, number] = [50, 50]): readonly [number, number, number] {
  const target = card.attachedTo ? battlefield.find((candidate) => candidate.id === card.attachedTo) : null;
  if (!target) return [card.battlefieldX ?? fallback[0], card.battlefieldY ?? fallback[1], card.zIndex * 10 + 10];
  const index = battlefield.filter((candidate) => candidate.attachedTo === target.id).sort((a, b) => a.order - b.order).findIndex((candidate) => candidate.id === card.id);
  return [clamp((target.battlefieldX ?? 50) + 5 + Math.max(0, index) * 3, 8, 92), clamp((target.battlefieldY ?? 50) + 7 + Math.max(0, index) * 3, 8, 92), target.zIndex * 10 + 9 - Math.max(0, index)];
}

export function CommanderBoard({
  players,
  startingLife,
  lobbyName,
  gameId,
  seed,
  onLeave
}: {
  players: GameSetupPlayer[];
  startingLife: number;
  lobbyName: string;
  gameId?: string;
  seed?: number;
  onLeave: () => void;
}) {
  const [state, dispatch] = useReducer(
    commanderGameReducer,
    undefined,
    () => createCommanderGame(players, startingLife, seed)
  );
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  const [pinnedCardId, setPinnedCardId] = useState<string | null>(null);
  const [cardMenu, setCardMenu] = useState<CardMenuState | null>(null);
  const [zoneMenu, setZoneMenu] = useState<ZoneMenuState | null>(null);
  const [viewedZone, setViewedZone] = useState<ViewedZoneState | null>(null);
  const [gamePrompt, setGamePrompt] = useState<GamePromptConfig | null>(null);
  const [artworkCardId, setArtworkCardId] = useState<string | null>(null);
  const [dragVisual, setDragVisual] = useState<CardDrag | null>(null);
  const [arrowDraft, setArrowDraft] = useState<ArrowDraft | null>(null);
  const [dropZone, setDropZone] = useState<CommanderZone | null>(null);
  const [chatMessage, setChatMessage] = useState("");
  const [honorOpen, setHonorOpen] = useState(false);
  const battlefieldRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<CardDrag | null>(null);
  const arrowRef = useRef<ArrowDraft | null>(null);
  const suppressClickUntil = useRef(0);
  const suppressContextUntil = useRef(0);
  const gameSequence = useRef(0);
  const optimisticActions = useRef(new Set<string>());
  const localId = state.localPlayerId;
  const opponents = state.playerOrder.filter((id) => id !== localId);
  const nextPlayerId = state.playerOrder[(state.playerOrder.indexOf(state.activePlayerId) + 1) % state.playerOrder.length];
  const canAdvancePhase = state.phase !== "end" || nextPlayerId === localId;
  const localLibrary = cardsInZone(state, localId, "library");
  const localHand = cardsInZone(state, localId, "hand");
  const localBattlefield = cardsInZone(state, localId, "battlefield");
  const battlefieldCards = Object.values(state.cards).filter((card) => card.zone === "battlefield");
  const localGraveyard = cardsInZone(state, localId, "graveyard");
  const localExile = cardsInZone(state, localId, "exile");
  const stackCards = Object.values(state.cards).filter((card) => card.zone === "stack").sort((a, b) => a.order - b.order);
  const localCommander = state.cards[state.players[localId].commanderCardId];
  const previewCardId = hoveredCardId ?? pinnedCardId;
  const previewCard = previewCardId ? state.cards[previewCardId] ?? null : null;

  useEffect(() => {
    function dismiss(event: globalThis.PointerEvent) {
      if (!(event.target as HTMLElement | null)?.closest(".card-context-menu, .zone-context-menu")) {
        setCardMenu(null);
        setZoneMenu(null);
      }
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") { setCardMenu(null); setZoneMenu(null); setViewedZone(null); setGamePrompt(null); }
    }
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", escape);
    };
  }, []);

  useEffect(() => {
    if (!gameId || !remoteApiEnabled) return;
    let busy = false;
    const receive = async () => {
      if (busy) return; busy = true;
      try {
        const events = await gameActions(gameId, gameSequence.current);
        for (const event of events) {
          if (!event.clientActionId || !optimisticActions.current.delete(event.clientActionId)) dispatch(event.action);
          gameSequence.current = Math.max(gameSequence.current, event.sequence);
        }
      } catch { /* the next poll retries transient failures */ }
      finally { busy = false; }
    };
    void receive();
    const timer = window.setInterval(() => void receive(), 140);
    return () => { window.clearInterval(timer); };
  }, [gameId]);

  function action(value: CommanderGameAction) {
    if (!gameId || !remoteApiEnabled) return dispatch(value);
    const clientActionId = globalThis.crypto?.randomUUID?.() ?? `action-${Date.now()}-${Math.random()}`;
    const optimistic = value.type !== "NEXT_PHASE" && value.type !== "NEXT_TURN" && value.type !== "SET_PHASE";
    if (optimistic) { optimisticActions.current.add(clientActionId); dispatch(value); }
    void sendGameAction(gameId, value, clientActionId).catch(() => optimisticActions.current.delete(clientActionId));
  }

  function startDrag(card: CommanderCardState, event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || card.controllerId !== localId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const drag: CardDrag = {
      cardId: card.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      centerOffsetX: event.clientX - (bounds.left + bounds.width / 2),
      centerOffsetY: event.clientY - (bounds.top + bounds.height / 2),
      started: false
    };
    dragRef.current = drag;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLElement>) {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const started = current.started || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 4;
    const next = { ...current, clientX: event.clientX, clientY: event.clientY, started };
    dragRef.current = next;
    if (started) {
      event.preventDefault();
      setCardMenu(null);
      setDragVisual(next);
      setDropZone(dropZoneAt(event.clientX, event.clientY));
    }
  }

  function finishDrag(event: PointerEvent<HTMLElement>) {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragVisual(null);
    setDropZone(null);
    if (!current.started) return;
    event.preventDefault();
    suppressClickUntil.current = Date.now() + 120;
    const zone = dropZoneAt(event.clientX, event.clientY);
    const card = state.cards[current.cardId];
    if (!zone || !card || (zone === "commander" && card.id !== state.players[card.ownerId].commanderCardId)) return;
    if (zone === "battlefield" && battlefieldRef.current) {
      const bounds = battlefieldRef.current.getBoundingClientRect();
      const cardBounds = event.currentTarget.getBoundingClientRect();
      const centerX = event.clientX - current.centerOffsetX;
      const centerY = event.clientY - current.centerOffsetY;
      const marginX = Math.min(45, (cardBounds.width / 2 / bounds.width) * 100);
      const marginY = Math.min(45, (cardBounds.height / 2 / bounds.height) * 100);
      const x = clamp(((centerX - bounds.left) / bounds.width) * 100, marginX, 100 - marginX);
      const y = clamp(((centerY - bounds.top) / bounds.height) * 100, marginY, 100 - marginY);
      const zIndex = Math.max(0, ...localBattlefield.map((permanent) => permanent.zIndex)) + 1;
      action({ type: "MOVE_CARD", cardId: card.id, zone, x: roundCoordinate(x), y: roundCoordinate(y), zIndex, manaCost: card.manaCost });
    } else {
      action({ type: "MOVE_CARD", cardId: card.id, zone, manaCost: card.manaCost });
    }
  }

  function cancelDrag() {
    dragRef.current = null;
    setDragVisual(null);
    setDropZone(null);
  }

  function dropZoneAt(x: number, y: number): CommanderZone | null {
    const target = document.elementFromPoint(x, y) as HTMLElement | null;
    return (target?.closest<HTMLElement>("[data-drop-zone]")?.dataset.dropZone as CommanderZone | undefined) ?? null;
  }

  function showContext(card: CommanderCardState, event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    if (Date.now() < suppressContextUntil.current) return;
    setPinnedCardId(card.id);
    setCardMenu({ cardId: card.id, x: event.clientX, y: event.clientY });
  }

  function activateCard(card: CommanderCardState) {
    if (Date.now() < suppressClickUntil.current) return;
    setPinnedCardId((current) => current === card.id ? null : card.id);
  }

  function playAtCenter(card: CommanderCardState) {
    const offset = (localBattlefield.length % 5) * 4;
    const zIndex = Math.max(0, ...localBattlefield.map((permanent) => permanent.zIndex)) + 1;
    action({ type: "MOVE_CARD", cardId: card.id, zone: "battlefield", x: 42 + offset, y: 52, zIndex, manaCost: card.manaCost });
  }

  function lookAtTop() {
    if (!localLibrary.length) return;
    setGamePrompt({ title: "Look at top cards", description: "Use this for scry, surveil and manual library effects.", fields: [{ key: "count", label: "Number of cards", value: "1", type: "number", min: 1, max: localLibrary.length }], onSubmit: ({ count }) => setViewedZone({ playerId: localId, zone: "library", cardIds: localLibrary.slice(0, Number(count)).map((card) => card.id) }) });
  }

  function millCards() {
    setGamePrompt({ title: "Mill cards", fields: [{ key: "count", label: "Number of cards", value: "1", type: "number", min: 1, max: localLibrary.length }], onSubmit: ({ count }) => action({ type: "MILL", playerId: localId, count: Number(count) }) });
  }

  function drawCards() {
    setGamePrompt({ title: "Draw cards", fields: [{ key: "count", label: "Number of cards", value: "1", type: "number", min: 1, max: localLibrary.length }], onSubmit: ({ count }) => action({ type: "DRAW_CARD", playerId: localId, count: Number(count) }) });
  }

  function mulligan() {
    setGamePrompt({ title: "Take a mulligan", description: "Return your hand, shuffle, then draw the chosen amount.", fields: [{ key: "count", label: "New hand size", value: String(localHand.length), type: "number", min: 1, max: localLibrary.length + localHand.length }], onSubmit: ({ count }) => action({ type: "MULLIGAN", playerId: localId, seed: Date.now(), count: Number(count) }) });
  }

  function createCustomToken() {
    setGamePrompt({ title: "Create token", description: "Leave power/toughness empty for Treasure, Clue, Food and other noncreature tokens.", fields: [{ key: "name", label: "Token name", value: "Treasure" }, { key: "count", label: "Amount", value: "1", type: "number", min: 1, max: 20 }, { key: "stats", label: "Power / toughness", value: "", required: false }], onSubmit: ({ name, count, stats }) => { const match = stats.trim().match(/^(-?\d+)\s*\/\s*(-?\d+)$/); action({ type: "CREATE_TOKEN", playerId: localId, name: name.trim(), count: Number(count), power: match ? Number(match[1]) : null, toughness: match ? Number(match[2]) : null }); } });
  }

  function rollDie() {
    setGamePrompt({ title: "Roll a die", fields: [{ key: "sides", label: "Number of sides", value: "20", type: "number", min: 2, max: 1000 }], onSubmit: ({ sides: value }) => { const sides = Number(value); action({ type: "ROLL_DIE", playerId: localId, sides, result: Math.floor(Math.random() * sides) + 1 }); } });
  }

  function startArrow(event: PointerEvent<HTMLElement>) {
    if (event.button !== 2) return;
    const from = arrowTarget(event.target as HTMLElement);
    if (!from) return;
    event.preventDefault();
    const draft = { from, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, clientX: event.clientX, clientY: event.clientY, started: false };
    arrowRef.current = draft;
    setArrowDraft(draft);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveArrow(event: PointerEvent<HTMLElement>) {
    const current = arrowRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const next = { ...current, clientX: event.clientX, clientY: event.clientY, started: current.started || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 5 };
    arrowRef.current = next;
    setArrowDraft(next);
    if (next.started) event.preventDefault();
  }

  function finishArrow(event: PointerEvent<HTMLElement>) {
    const current = arrowRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    arrowRef.current = null;
    setArrowDraft(null);
    if (!current.started) return;
    event.preventDefault();
    suppressContextUntil.current = Date.now() + 180;
    const to = arrowTarget(document.elementFromPoint(event.clientX, event.clientY));
    if (!to || targetKey(current.from) === targetKey(to)) return;
    action({ type: "ADD_ARROW", arrow: { id: globalThis.crypto?.randomUUID?.() ?? `arrow-${Date.now()}-${Math.random()}`, from: current.from, to } });
  }

  function cancelArrow() { arrowRef.current = null; setArrowDraft(null); }

  const dragInteractions = (card: CommanderCardState) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => startDrag(card, event),
    onPointerMove: moveDrag,
    onPointerUp: finishDrag,
    onPointerCancel: cancelDrag
  });

  const cardInteractions = (card: CommanderCardState) => ({
    onHover: (hovered: boolean) => setHoveredCardId(hovered ? card.id : (current) => current === card.id ? null : current),
    onClick: () => activateCard(card),
    onContext: (event: MouseEvent<HTMLElement>) => showContext(card, event),
    ...dragInteractions(card)
  });

  const viewedCards = viewedZone ? (() => {
    const cards = cardsInZone(state, viewedZone.playerId, viewedZone.zone);
    const ordered = viewedZone.zone === "graveyard" || viewedZone.zone === "exile" ? [...cards].reverse() : cards;
    return viewedZone.cardIds ? viewedZone.cardIds.map((id) => state.cards[id]).filter((card): card is CommanderCardState => Boolean(card && card.zone === viewedZone.zone)) : ordered;
  })() : [];

  return <main className={`commander-screen ${dragVisual?.started ? "is-dragging-card" : ""} ${arrowDraft?.started ? "is-drawing-arrow" : ""}`} style={{ "--nt-green": state.players[localId].accentColor ?? "#62e6bb" } as CSSProperties} onPointerDown={startArrow} onPointerMove={moveArrow} onPointerUp={finishArrow} onPointerCancel={cancelArrow} onContextMenu={(event) => event.preventDefault()}>
    <header className="game-topbar">
      <div><img className="brand-logo" src="/novatable-logo.svg" alt="NovaTable" /><div><strong>{lobbyName}</strong><span>Commander · 4 players</span></div></div>
      <div className="turn-status"><span>Turn {state.turn}</span><strong>{state.players[state.activePlayerId].name}</strong><i>{state.phase.replace("-", " ")}</i></div>
      <div className="game-window-actions"><FullscreenButton /><button className="secondary-button" onClick={() => gameId && remoteApiEnabled ? setHonorOpen(true) : onLeave()}><X size={16} />Leave game</button></div>
    </header>

    <section className="commander-table">
      <div className="opponents-grid">
        {opponents.map((playerId) => <OpponentBoard key={playerId} state={state} playerId={playerId} dispatch={action} onHover={setHoveredCardId} onContext={showContext} onViewZone={(zone) => setViewedZone({ playerId, zone })} />)}
      </div>

      <div className={`shared-center ${stackCards.length ? "has-stack" : ""}`}>
        <div className={`stack-tray ${dropZone === "stack" ? "is-drop-target" : ""}`} data-drop-zone="stack"><span>Stack {stackCards.length || ""}</span>{stackCards.map((card) => <CommanderCard key={card.id} card={card} selected={pinnedCardId === card.id} compact dragging={dragVisual?.started && dragVisual.cardId === card.id} {...(card.ownerId === localId ? cardInteractions(card) : { onHover: (hovered: boolean) => setHoveredCardId(hovered ? card.id : null) })} />)}</div>
        <div className="phase-track">{commanderPhases.map((phase) => <button className={state.phase === phase ? "is-current" : ""} disabled={state.activePlayerId !== localId} key={phase} onClick={() => action({ type: "SET_PHASE", phase })}>{phase.replaceAll("-", " ")}</button>)}</div>
      </div>

      <section className="local-board">
        <PlayerHud state={state} playerId={localId} dispatch={action} local />
        <div className="local-playmat">
          <div className="local-zones">
            <ZoneButton icon={<Layers3 />} label="Library" count={localLibrary.length} zone="library" active={dropZone === "library"} topCard={localLibrary[0]} onHover={setHoveredCardId} {...(localLibrary[0] ? dragInteractions(localLibrary[0]) : {})} onClick={() => { if (Date.now() >= suppressClickUntil.current) action({ type: "DRAW_CARD", playerId: localId }); }} onContext={(event) => { event.preventDefault(); setCardMenu(null); setZoneMenu({ zone: "library", x: event.clientX, y: event.clientY }); }} />
            <ZoneButton icon={<Archive />} label="Graveyard" count={localGraveyard.length} zone="graveyard" active={dropZone === "graveyard"} topCard={localGraveyard.at(-1)} onHover={setHoveredCardId} {...(localGraveyard.length ? dragInteractions(localGraveyard.at(-1)!) : {})} onClick={() => { if (Date.now() >= suppressClickUntil.current) setViewedZone({ playerId: localId, zone: "graveyard" }); }} onContext={(event) => { event.preventDefault(); setCardMenu(null); setZoneMenu({ zone: "graveyard", x: event.clientX, y: event.clientY }); }} />
            <ZoneButton icon={<Eye />} label="Exile" count={localExile.length} zone="exile" active={dropZone === "exile"} topCard={localExile.at(-1)} onHover={setHoveredCardId} {...(localExile.length ? dragInteractions(localExile.at(-1)!) : {})} onClick={() => { if (Date.now() >= suppressClickUntil.current) setViewedZone({ playerId: localId, zone: "exile" }); }} onContext={(event) => { event.preventDefault(); setCardMenu(null); setZoneMenu({ zone: "exile", x: event.clientX, y: event.clientY }); }} />
            <div className={`commander-zone ${dropZone === "commander" ? "is-drop-target" : ""}`} data-drop-zone="commander">
              <small>Commander <span className="tax-control"><button onClick={() => action({ type: "CHANGE_COMMANDER_TAX", playerId: localId, delta: -1 })}>−</button><b>Tax {state.players[localId].commanderTax}</b><button onClick={() => action({ type: "CHANGE_COMMANDER_TAX", playerId: localId, delta: 1 })}>+</button></span></small>
              {localCommander.zone === "commander" && <CommanderCard card={localCommander} selected={pinnedCardId === localCommander.id} dragging={dragVisual?.started && dragVisual.cardId === localCommander.id} {...cardInteractions(localCommander)} onDouble={() => playAtCenter(localCommander)} />}
              {localCommander.zone !== "commander" && <span className="empty-command-zone">Command zone</span>}
            </div>
          </div>
          <div ref={battlefieldRef} className={`battlefield-drop ${dropZone === "battlefield" ? "is-drop-target" : ""}`} data-drop-zone="battlefield">
            {!localBattlefield.length && <span>Drag a card here — the battlefield is freely positionable</span>}
            {localBattlefield.map((card) => <CommanderCard key={card.id} card={card} selected={pinnedCardId === card.id} dragging={dragVisual?.started && dragVisual.cardId === card.id} freePosition={battlefieldPlacement(card, localBattlefield)} {...cardInteractions(card)} onDouble={() => action({ type: card.tapped ? "UNTAP_CARD" : "TAP_CARD", cardId: card.id })} />)}
          </div>
        </div>
        <div className={`local-hand ${dropZone === "hand" ? "is-drop-target" : ""}`} data-drop-zone="hand" onContextMenu={(event) => { if ((event.target as HTMLElement).closest("[data-card-id]")) return; event.preventDefault(); setCardMenu(null); setZoneMenu({ zone: "hand", x: event.clientX, y: event.clientY }); }}>
          <span>Your hand <b>{localHand.length}</b></span>
          <div>{localHand.map((card) => <CommanderCard key={card.id} card={card} selected={pinnedCardId === card.id} dragging={dragVisual?.started && dragVisual.cardId === card.id} hand {...cardInteractions(card)} onDouble={() => playAtCenter(card)} />)}</div>
        </div>
      </section>
    </section>

    <aside className="game-actions">
      <CardPreview card={previewCard} canPeek={previewCard?.ownerId === localId} pinned={Boolean(pinnedCardId && previewCardId === pinnedCardId)} onUnpin={() => setPinnedCardId(null)} />
      <section className="table-tools">
        <header>Quick actions</header>
        <div><button onClick={drawCards}><Hand size={15} />Draw X</button><button onClick={createCustomToken}><CopyPlus size={15} />Create token</button><button onClick={millCards}><Skull size={15} />Mill X</button><button onClick={lookAtTop}><Eye size={15} />Look / Scry X</button><button onClick={() => action({ type: "SHUFFLE_LIBRARY", playerId: localId, seed: Date.now() })}><Shuffle size={15} />Shuffle</button><button onClick={mulligan}><RotateCcw size={15} />Mulligan</button><button onClick={() => action({ type: "UNTAP_ALL", playerId: localId })}><Sparkles size={15} />Untap all</button><button onClick={rollDie}><Dices size={15} />Roll die</button><button onClick={() => action({ type: "FLIP_COIN", playerId: localId, result: Math.random() < .5 ? "heads" : "tails" })}><Coins size={15} />Flip coin</button><button onClick={() => action({ type: "CLEAR_ARROWS" })}><X size={15} />Clear arrows</button><button className="next-phase" disabled={!canAdvancePhase} title={state.phase === "end" ? nextPlayerId === localId ? "Claim your turn" : `Waiting for ${state.players[nextPlayerId].name} to claim the next turn` : "Advance the table to the next phase"} onClick={() => action({ type: "NEXT_PHASE" })}>{state.phase === "end" && nextPlayerId === localId ? "Start your turn" : "Next phase"} <ChevronRight size={16} /></button></div>
      </section>
      <section className="game-log"><header><CircleDot size={14} /><strong>Game log & chat</strong></header><div>{[...state.log].reverse().slice(0, 30).map((entry) => <p key={entry.id}>{entry.message}</p>)}</div><form onSubmit={(event) => { event.preventDefault(); action({ type: "CHAT_MESSAGE", playerId: localId, text: chatMessage }); setChatMessage(""); }}><input aria-label="Game chat message" value={chatMessage} onChange={(event) => setChatMessage(event.target.value)} placeholder="Message the table" maxLength={500} /><button aria-label="Send game message"><Send size={13} /></button></form></section>
    </aside>

    {cardMenu && state.cards[cardMenu.cardId] && <CardContextMenu card={state.cards[cardMenu.cardId]} battlefield={battlefieldCards} players={state.players} isCommander={state.players[state.cards[cardMenu.cardId].ownerId].commanderCardId === cardMenu.cardId} dispatch={action} position={cardMenu} onPrompt={setGamePrompt} onChooseArtwork={() => { setArtworkCardId(cardMenu.cardId); setCardMenu(null); }} onClose={() => setCardMenu(null)} />}
    {zoneMenu && <ZoneContextMenu zone={zoneMenu.zone} count={cardsInZone(state, localId, zoneMenu.zone).length} topCard={zoneMenu.zone === "library" ? localLibrary[0] : cardsInZone(state, localId, zoneMenu.zone).at(-1)} playerId={localId} dispatch={action} position={zoneMenu} onPrompt={setGamePrompt} onView={() => { setViewedZone({ playerId: localId, zone: zoneMenu.zone }); setZoneMenu(null); }} onClose={() => setZoneMenu(null)} />}
    {viewedZone && <aside className="zone-browser" role="dialog" aria-label={`${zoneLabel(viewedZone.zone)} cards`}>
      <header><div><span className="kicker">{viewedZone.playerId === localId ? "Your cards" : state.players[viewedZone.playerId].name}</span><strong>{viewedZone.cardIds ? `Top ${viewedZone.cardIds.length} · ` : ""}{zoneLabel(viewedZone.zone)}</strong><small>{viewedCards.length} card{viewedCards.length === 1 ? "" : "s"} · {viewedZone.playerId === localId ? "drag or right-click any card" : "public zone"}</small></div><button onClick={() => setViewedZone(null)} aria-label="Close zone viewer"><X size={17} /></button></header>
      <div>{viewedCards.map((card) => <CommanderCard key={card.id} card={card} selected={pinnedCardId === card.id} dragging={dragVisual?.started && dragVisual.cardId === card.id} {...(viewedZone.playerId === localId ? cardInteractions(card) : { onHover: (hovered: boolean) => setHoveredCardId(hovered ? card.id : null) })} />)}{!viewedCards.length && <p>This zone is empty.</p>}</div>
    </aside>}
    {dragVisual?.started && state.cards[dragVisual.cardId] && <div className="drag-card-preview" style={{ left: dragVisual.clientX - dragVisual.centerOffsetX, top: dragVisual.clientY - dragVisual.centerOffsetY }}><CommanderCard card={state.cards[dragVisual.cardId].zone === "library" && !state.cards[dragVisual.cardId].revealed ? { ...state.cards[dragVisual.cardId], faceDown: true } : state.cards[dragVisual.cardId]} selected={false} previewOnly /></div>}
    {artworkCardId && state.cards[artworkCardId] && <CardArtworkPicker cardName={state.cards[artworkCardId].name} onSelect={(printing) => action({ type: "SET_CARD_ARTWORK", cardId: artworkCardId, artworkUrl: printing?.imageUrl ?? null, backArtworkUrl: printing?.otherFaceImageUrl })} onClose={() => setArtworkCardId(null)} />}
    {gamePrompt && <GamePromptModal config={gamePrompt} onClose={() => setGamePrompt(null)} />}
    {honorOpen && <div className="game-prompt-backdrop" role="presentation"><section className="game-prompt honor-prompt" role="dialog" aria-modal="true" aria-label="Award Honor"><header><div><span className="kicker">End of game</span><strong>Award Honor</strong><p>Who made this game especially enjoyable? You cannot vote for yourself.</p></div></header><section>{state.playerOrder.filter((playerId) => playerId !== localId && !playerId.startsWith("bot-")).map((playerId) => <button key={playerId} onClick={() => { void submitHonor(gameId!, playerId).finally(onLeave); }}><span className="avatar">{state.players[playerId].avatar}</span><strong>{state.players[playerId].name}</strong><small>Give +1 Honor</small></button>)}</section><footer><button className="secondary-button" onClick={onLeave}>Skip and leave</button></footer></section></div>}
    <ArrowLayer arrows={state.arrows} attachments={Object.values(state.cards).filter((card) => card.attachedTo).map((card) => ({ id: `attachment-${card.id}`, from: { kind: "card", id: card.id }, to: { kind: "card", id: card.attachedTo! } }))} draft={arrowDraft} onRemove={(arrowId) => action({ type: "REMOVE_ARROW", arrowId })} />
  </main>;
}

function OpponentBoard({ state, playerId, dispatch, onHover, onContext, onViewZone }: { state: CommanderGameState; playerId: string; dispatch: (action: CommanderGameAction) => void; onHover: (cardId: string | null) => void; onContext: (card: CommanderCardState, event: MouseEvent<HTMLElement>) => void; onViewZone: (zone: "graveyard" | "exile") => void }) {
  const player = state.players[playerId];
  const battlefield = cardsInZone(state, playerId, "battlefield");
  const commander = state.cards[player.commanderCardId];
  const hand = cardsInZone(state, playerId, "hand");
  const library = cardsInZone(state, playerId, "library");
  const graveyard = cardsInZone(state, playerId, "graveyard");
  const exile = cardsInZone(state, playerId, "exile");
  const revealedLibraryTop = library[0]?.revealed ? library[0] : null;
  const revealedHand = hand.filter((card) => card.revealed);
  return <section className={`opponent-board ${state.activePlayerId === playerId ? "is-active" : ""}`}>
    <PlayerHud state={state} playerId={playerId} dispatch={dispatch} />
    <aside className="opponent-zones">
      <div className="opponent-commander">{commander.zone === "commander" && <CommanderCard card={commander} selected={false} compact onHover={(hovered) => onHover(hovered ? commander.id : null)} onContext={(event) => onContext(commander, event)} />}<span>Tax {player.commanderTax}</span></div>
      <button title={revealedLibraryTop?.name ?? "Library"} onMouseEnter={() => revealedLibraryTop && onHover(revealedLibraryTop.id)} onMouseLeave={() => revealedLibraryTop && onHover(null)}><Layers3 size={15} /><span>Library</span><strong>{library.length}</strong>{revealedLibraryTop && <b>{revealedLibraryTop.name}</b>}</button>
      <button onClick={() => onViewZone("graveyard")}><Archive size={15} /><span>Graveyard</span><strong>{graveyard.length}</strong></button>
      <button onClick={() => onViewZone("exile")}><Eye size={15} /><span>Exile</span><strong>{exile.length}</strong></button>
    </aside>
    <div className="opponent-public">
      <div className="opponent-battlefield">{!battlefield.length && <span className="opponent-battlefield-empty">Battlefield</span>}{battlefield.map((card, index) => <CommanderCard key={card.id} card={card} selected={false} compact freePosition={battlefieldPlacement(card, battlefield, [18 + index * 18, 50])} onHover={(hovered) => onHover(hovered ? card.id : null)} onContext={(event) => onContext(card, event)} onDouble={() => dispatch({ type: card.tapped ? "UNTAP_CARD" : "TAP_CARD", cardId: card.id })} />)}<div className="opponent-hand-count" title={revealedHand.length ? `${hand.length} cards · revealed: ${revealedHand.map((card) => card.name).join(", ")}` : `${hand.length} cards in hand`} onMouseEnter={() => revealedHand.length && onHover(revealedHand.at(-1)!.id)} onMouseLeave={() => revealedHand.length && onHover(null)}><Hand size={14} /><span>Hand</span><strong>{hand.length}</strong>{revealedHand.length > 0 && <b>{revealedHand.length} shown</b>}</div></div>
    </div>
  </section>;
}

function PlayerHud({ state, playerId, dispatch, local = false }: { state: CommanderGameState; playerId: string; dispatch: (action: CommanderGameAction) => void; local?: boolean }) {
  const player = state.players[playerId];
  return <header className={`player-hud ${local ? "is-local" : ""}`} data-player-target={playerId}><span className={`avatar ${player.avatarImage ? "has-image" : ""}`} style={{ borderColor: player.accentColor }}>{player.avatarImage ? <img src={player.avatarImage} alt="" /> : player.avatar}</span><div className="player-hud__name"><div><strong>{player.name}</strong><ManaPool playerId={playerId} colors={player.manaColors} pool={player.manaPool} editable={local} dispatch={dispatch} /></div><span>{state.activePlayerId === playerId ? "Active player" : local ? "You" : "Connected"}</span></div><div className={`life-stepper ${local ? "" : "is-readonly"}`}>{local && <button aria-label="Lose one life" onClick={() => dispatch({ type: "CHANGE_LIFE", playerId, delta: -1 })}><Minus size={13} /></button>}<strong>{player.life}</strong>{local && <button aria-label="Gain one life" onClick={() => dispatch({ type: "CHANGE_LIFE", playerId, delta: 1 })}><Plus size={13} /></button>}<span>Life</span></div><div className="poison-stepper"><Skull size={13} /><button onClick={() => dispatch({ type: "CHANGE_POISON", playerId, delta: -1 })}>−</button><strong>{player.poison}</strong><button onClick={() => dispatch({ type: "CHANGE_POISON", playerId, delta: 1 })}>+</button></div><div className="damage-strip">{Object.entries(player.commanderDamage).map(([sourceId, value]) => <span key={sourceId} title={`Commander damage from ${state.players[sourceId].name}`}><button aria-label={`Remove commander damage from ${state.players[sourceId].name}`} onClick={() => dispatch({ type: "CHANGE_COMMANDER_DAMAGE", playerId, sourcePlayerId: sourceId, delta: -1 })}>−</button><b><i className="damage-source" style={{ borderColor: state.players[sourceId].accentColor }}>{state.players[sourceId].avatar}</i>{value}</b><button aria-label={`Add commander damage from ${state.players[sourceId].name}`} onClick={() => dispatch({ type: "CHANGE_COMMANDER_DAMAGE", playerId, sourcePlayerId: sourceId, delta: 1 })}>+</button></span>)}</div></header>;
}

function ManaPool({ playerId, colors, pool, editable, dispatch }: { playerId: string; colors: ManaColor[]; pool: Record<ManaColor, number>; editable: boolean; dispatch: (action: CommanderGameAction) => void }) {
  return <div className="mana-pool" aria-label="Mana pool">{colors.map((color) => <span className={`mana-${color.toLowerCase()}`} key={color}>{editable && <button className="mana-remove" aria-label={`Remove ${color} mana`} onClick={() => dispatch({ type: "CHANGE_MANA", playerId, color, delta: -1 })}>−</button>}<img src={`https://svgs.scryfall.io/card-symbols/${color}.svg`} alt={`${color} mana`} /><b>{pool[color]}</b>{editable && <button className="mana-add" aria-label={`Add ${color} mana`} onClick={() => dispatch({ type: "CHANGE_MANA", playerId, color, delta: 1 })}>+</button>}</span>)}</div>;
}

function ZoneButton({ icon, label, count, zone, active, topCard, onHover, onClick, onContext, onPointerDown, onPointerMove, onPointerUp, onPointerCancel }: { icon: React.ReactNode; label: string; count: number; zone: CommanderZone; active: boolean; topCard?: CommanderCardState; onHover?: (cardId: string | null) => void; onClick?: () => void; onContext?: (event: MouseEvent<HTMLButtonElement>) => void } & Pick<CommanderCardProps, "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel">) {
  const record = useCardRecord(topCard?.name ?? "");
  const visibleTop = zone !== "library" || topCard?.revealed;
  return <button type="button" className={`commander-zone-button zone-${zone} ${active ? "is-drop-target" : ""}`} data-drop-zone={zone} onClick={onClick} onContextMenu={onContext} onMouseEnter={() => visibleTop && topCard && onHover?.(topCard.id)} onMouseLeave={() => visibleTop && topCard && onHover?.(null)} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} title={zone === "library" ? "Library — drag the top card, click to draw, right-click for actions" : `${label} — drag the top card, click to view, right-click for actions`}>
    <span className="zone-pile">{visibleTop && topCard ? record?.imageUrl ? <img src={record.imageUrl} alt={topCard.name} /> : <em>{topCard.name}</em> : zone === "library" ? <img src="/magic-card-back.png" alt="Magic card back" /> : icon}<strong>{count}</strong></span>
    <span className="zone-label">{label}</span>
  </button>;
}

function ZoneContextMenu({ zone, count, topCard, playerId, dispatch, position, onPrompt, onView, onClose }: { zone: ZoneMenuState["zone"]; count: number; topCard?: CommanderCardState; playerId: string; dispatch: (action: CommanderGameAction) => void; position: ZoneMenuState; onPrompt: (prompt: GamePromptConfig) => void; onView: () => void; onClose: () => void }) {
  const style = contextMenuStyle(position, 360);
  function run(action: CommanderGameAction) { dispatch(action); onClose(); }
  function ask(title: string, submit: (amount: number) => void) {
    onPrompt({ title, fields: [{ key: "count", label: "Number of cards", value: "1", type: "number", min: 1, max: 100 }], onSubmit: ({ count: value }) => submit(Number(value)) });
    onClose();
  }
  function moveTop(target: CommanderZone, placement?: "top" | "bottom") {
    if (topCard) run({ type: "MOVE_CARD", cardId: topCard.id, zone: target, placement });
  }
  return <aside className="card-context-menu zone-context-menu" style={style} role="menu" aria-label={`${zoneLabel(zone)} actions`}>
    <header><span>{zoneLabel(zone)}</span><small>{count} card{count === 1 ? "" : "s"}</small></header>
    <button onClick={onView}>View {zoneLabel(zone).toLocaleLowerCase()}<Eye size={13} /></button>
    {zone === "library" && <>
      <button onClick={() => run({ type: "DRAW_CARD", playerId })}>Draw 1</button>
      <button onClick={() => ask("Draw cards", (amount) => dispatch({ type: "DRAW_CARD", playerId, count: amount }))}>Draw X</button>
      <button onClick={() => run({ type: "SHUFFLE_LIBRARY", playerId, seed: Date.now() })}>Shuffle library<Shuffle size={13} /></button>
      <button onClick={() => run({ type: "MILL", playerId, count: 1 })}>Mill 1</button>
      <button onClick={() => ask("Mill cards", (amount) => dispatch({ type: "MILL", playerId, count: amount }))}>Mill X</button>
      {topCard && <><button onClick={() => run({ type: topCard.revealed ? "HIDE_CARD" : "REVEAL_CARD", cardId: topCard.id })}>{topCard.revealed ? "Hide top card" : "Reveal top card"}</button><button onClick={() => moveTop("battlefield")}>Play top card</button><button onClick={() => moveTop("graveyard")}>Top card to graveyard</button><button onClick={() => moveTop("exile")}>Top card to exile</button><button onClick={() => moveTop("library", "bottom")}>Top card to bottom</button></>}
    </>}
    {zone !== "library" && topCard && <>
      <button onClick={() => moveTop("hand")}>Top card to hand</button>
      <button onClick={() => moveTop("battlefield")}>Top card to battlefield</button>
      <button onClick={() => moveTop("library", "top")}>Top card on library</button>
      <button onClick={() => moveTop("library", "bottom")}>Top card under library</button>
      <button onClick={() => moveTop(zone === "graveyard" ? "exile" : "graveyard")}>Top card to {zone === "graveyard" ? "exile" : "graveyard"}</button>
    </>}
    {zone !== "library" && count > 0 && <section className="zone-bulk-actions"><span>Whole zone</span><button onClick={() => run({ type: "MOVE_ZONE_CARDS", playerId, from: zone, zone: "library", placement: "top" })}>All on top of library</button><button onClick={() => run({ type: "MOVE_ZONE_CARDS", playerId, from: zone, zone: "library", placement: "bottom" })}>All under library</button>{zone !== "hand" && <button onClick={() => run({ type: "MOVE_ZONE_CARDS", playerId, from: zone, zone: "hand" })}>All to hand</button>}{zone !== "graveyard" && <button onClick={() => run({ type: "MOVE_ZONE_CARDS", playerId, from: zone, zone: "graveyard" })}>All to graveyard</button>}{zone !== "exile" && <button onClick={() => run({ type: "MOVE_ZONE_CARDS", playerId, from: zone, zone: "exile" })}>All to exile</button>}</section>}
  </aside>;
}

function zoneLabel(zone: ZoneMenuState["zone"]) {
  return zone === "library" ? "Library" : zone === "hand" ? "Hand" : zone === "graveyard" ? "Graveyard" : "Exile";
}

interface CommanderCardProps {
  card: CommanderCardState;
  selected: boolean;
  dragging?: boolean;
  compact?: boolean;
  hand?: boolean;
  previewOnly?: boolean;
  freePosition?: readonly [number, number, number?];
  onHover?: (hovered: boolean) => void;
  onClick?: () => void;
  onDouble?: () => void;
  onContext?: (event: MouseEvent<HTMLElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove?: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp?: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel?: () => void;
}

function CommanderCard({ card, selected, dragging = false, compact = false, hand = false, previewOnly = false, freePosition, onHover, onClick, onDouble, onContext, onPointerDown, onPointerMove, onPointerUp, onPointerCancel }: CommanderCardProps) {
  const record = useCardRecord(card.name);
  const imageUrl = card.transformed ? card.backArtworkUrl ?? record?.otherFaceImageUrl : card.artworkUrl ?? record?.imageUrl;
  const basePower = card.power ?? numericStat(record?.power);
  const baseToughness = card.toughness ?? numericStat(record?.toughness);
  const style = {
    "--card-a": card.palette[0],
    "--card-b": card.palette[1],
    "--card-rotation": `${card.rotation}deg`,
    ...(freePosition ? { left: `${freePosition[0]}%`, top: `${freePosition[1]}%`, zIndex: freePosition[2] ?? card.zIndex + 2 } : {})
  } as CSSProperties;
  return <article
    className={`commander-card-shell ${compact ? "is-compact" : ""} ${hand ? "is-hand-card" : ""} ${card.attachedTo ? "is-attached" : ""} ${selected ? "is-selected" : ""} ${dragging ? "is-dragging" : ""} ${freePosition ? "is-free" : ""} ${previewOnly ? "is-preview-only" : ""}`}
    style={style}
    data-card-id={card.id}
    onMouseEnter={() => onHover?.(true)}
    onMouseLeave={() => onHover?.(false)}
    onClick={onClick}
    onDoubleClick={onDouble}
    onContextMenu={onContext}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerCancel={onPointerCancel}
    onKeyDown={(event) => { if (event.key === "Enter") onClick?.(); }}
    tabIndex={previewOnly ? -1 : 0}
    role="button"
    aria-label={`${card.name}${card.tapped ? ", tapped" : ""}`}
  >
    <div className={`commander-card ${card.tapped ? "is-tapped" : ""}`}>
      {card.faceDown ? <img className="commander-card__image" src="/magic-card-back.png" alt="Face-down card" draggable={false} /> : imageUrl ? <img className="commander-card__image" src={imageUrl} alt={card.transformed ? record?.otherFaceName ?? card.name : card.name} draggable={false} /> : <><div className="commander-card__name">{card.name}</div><div className="commander-card__art"><i /><span>{card.token ? "TOKEN" : card.zone === "commander" ? "COMMANDER" : "MAGIC"}</span></div><div className="commander-card__type">{record?.typeLine || fallbackType(card)}</div></>}
      {card.counters > 0 && <b className="card-counters">+1/+1 ×{card.counters}</b>}
      {Object.keys(card.namedCounters).length > 0 && <span className="card-markers">{Object.entries(card.namedCounters).map(([name, value]) => `${name} ${value}`).join(" · ")}</span>}
      {card.annotation && <span className="card-note" title={card.annotation}>✎ {card.annotation}</span>}
      {card.attachedTo && <span className="card-attachment" title="Attached">↳</span>}
      {basePower !== null && baseToughness !== null && (card.token || card.counters > 0 || card.powerModifier !== 0 || card.toughnessModifier !== 0) && <b className="card-stats">{basePower + card.powerModifier + card.counters}/{baseToughness + card.toughnessModifier + card.counters}</b>}
    </div>
  </article>;
}

function CardPreview({ card, canPeek, pinned, onUnpin }: { card: CommanderCardState | null; canPeek: boolean; pinned: boolean; onUnpin: () => void }) {
  const record = useCardRecord(card?.name ?? "");
  const imageUrl = card?.transformed ? card.backArtworkUrl ?? record?.otherFaceImageUrl : card?.artworkUrl ?? record?.imageUrl;
  return <section className="card-preview-panel">
    <header><div><span>Card preview</span>{card && <strong>{card.name}</strong>}</div>{pinned && <button onClick={onUnpin} title="Unpin preview"><X size={15} /></button>}</header>
    <div className="card-preview-stage">
      {card ? card.faceDown && !canPeek ? <img src="/magic-card-back.png" alt="Face-down card" /> : imageUrl ? <img src={imageUrl} alt={card.transformed ? record?.otherFaceName ?? card.name : card.name} /> : <div className="card-preview-fallback" style={{ "--card-a": card.palette[0], "--card-b": card.palette[1] } as CSSProperties}><strong>{card.name}</strong><span>{record?.manaCost}</span><i /> <b>{record?.typeLine || fallbackType(card)}</b><p>{record?.oracleText || "Card artwork becomes available after installing the card library."}</p></div> : <div className="card-preview-empty"><img src="/magic-card-back.png" alt="Magic card back" /><p>Hover a visible card to preview it</p><small>Click a card to pin it here</small></div>}
    </div>
    {card && <footer><span>{record?.typeLine || fallbackType(card)}</span>{record?.manaCost && <b>{record.manaCost}</b>}{card.annotation && <em>✎ {card.annotation}</em>}</footer>}
  </section>;
}

function CardContextMenu({ card, battlefield, players, isCommander, dispatch, position, onPrompt, onChooseArtwork, onClose }: { card: CommanderCardState; battlefield: CommanderCardState[]; players: CommanderGameState["players"]; isCommander: boolean; dispatch: (action: CommanderGameAction) => void; position: CardMenuState; onPrompt: (prompt: GamePromptConfig) => void; onChooseArtwork: () => void; onClose: () => void }) {
  const record = useCardRecord(card.name);
  const basePower = card.power ?? numericStat(record?.power);
  const baseToughness = card.toughness ?? numericStat(record?.toughness);
  const shortcuts = cardTextShortcuts(record?.oracleText ?? "");
  const style = contextMenuStyle(position, 440);
  function run(action: CommanderGameAction) {
    dispatch(action.type === "MOVE_CARD" && (action.zone === "battlefield" || action.zone === "stack") ? { ...action, manaCost: card.manaCost } : action);
    onClose();
  }
  function runShortcut(shortcut: ReturnType<typeof cardTextShortcuts>[number]) {
    if (shortcut.kind === "token") run({ type: "CREATE_TOKEN", playerId: card.ownerId, name: shortcut.name, count: shortcut.count, power: shortcut.power, toughness: shortcut.toughness });
    else if (shortcut.kind === "draw") run({ type: "DRAW_CARD", playerId: card.ownerId, count: shortcut.count });
    else if (shortcut.kind === "mill") run({ type: "MILL", playerId: card.ownerId, count: shortcut.count });
    else if (shortcut.kind === "life") run({ type: "CHANGE_LIFE", playerId: card.ownerId, delta: shortcut.amount });
    else run({ type: "ADD_COUNTER", cardId: card.id, delta: 1 });
  }
  function setPowerToughness() {
    if (basePower === null || baseToughness === null) return;
    onPrompt({ title: "Set power / toughness", description: card.name, fields: [{ key: "power", label: "Displayed power", value: String(basePower + card.powerModifier + card.counters), type: "number" }, { key: "toughness", label: "Displayed toughness", value: String(baseToughness + card.toughnessModifier + card.counters), type: "number" }], onSubmit: ({ power: powerValue, toughness: toughnessValue }) => { const power = Number(powerValue); const toughness = Number(toughnessValue); dispatch({ type: "SET_POWER_TOUGHNESS", cardId: card.id, powerModifier: power - basePower - card.counters, toughnessModifier: toughness - baseToughness - card.counters }); } });
    onClose();
  }
  function setNamedCounter() {
    onPrompt({ title: "Set named counter", description: "Use 0 to remove the counter.", fields: [{ key: "name", label: "Counter name", value: "charge" }, { key: "value", label: "Amount", value: "1", type: "number", min: 0 }], onSubmit: ({ name, value }) => dispatch({ type: "SET_NAMED_COUNTER", cardId: card.id, name, value: Number(value) }) });
    onClose();
  }
  function setCounters() {
    onPrompt({ title: "Set +1/+1 counters", description: card.name, fields: [{ key: "value", label: "Amount", value: String(card.counters), type: "number", min: 0 }], onSubmit: ({ value }) => dispatch({ type: "ADD_COUNTER", cardId: card.id, delta: Number(value) - card.counters }) });
    onClose();
  }
  function giveControl() {
    onPrompt({ title: "Give control", description: card.name, fields: [{ key: "playerId", label: "New controller", options: Object.values(players).filter((player) => player.id !== card.controllerId).map((player) => ({ value: player.id, label: player.name })) }], onSubmit: ({ playerId }) => dispatch({ type: "CHANGE_CONTROLLER", cardId: card.id, playerId }) });
    onClose();
  }
  function attach() {
    const targets = battlefield.filter((candidate) => candidate.id !== card.id);
    if (!targets.length) return;
    onPrompt({ title: "Attach card", description: card.name, fields: [{ key: "target", label: "Attach to", options: targets.map((target) => ({ value: target.id, label: target.name })) }], onSubmit: ({ target }) => dispatch({ type: "ATTACH_CARD", cardId: card.id, targetCardId: target }) });
    onClose();
  }
  return <aside className="card-context-menu" style={style} role="menu">
    <header><span>{card.name}</span><small>{card.zone}{card.annotation ? ` · ${card.annotation}` : ""}</small></header>
    {shortcuts.length > 0 && <section className="card-text-actions"><span>From card text</span>{shortcuts.map((shortcut, index) => <button key={`${shortcut.kind}-${shortcut.label}-${index}`} onClick={() => runShortcut(shortcut)}>{shortcut.label}<CopyPlus size={12} /></button>)}</section>}
    {card.zone === "battlefield" && <button onClick={() => run({ type: card.tapped ? "UNTAP_CARD" : "TAP_CARD", cardId: card.id })}>{card.tapped ? "Untap" : "Tap"}<kbd>2× click</kbd></button>}
    {card.zone !== "battlefield" && <button onClick={() => run({ type: "MOVE_CARD", cardId: card.id, zone: "battlefield", x: 50, y: 50 })}>Move to battlefield</button>}
    {card.zone !== "stack" && <button onClick={() => run({ type: "MOVE_CARD", cardId: card.id, zone: "stack" })}>Move to stack</button>}
    <button onClick={() => run({ type: "MOVE_CARD", cardId: card.id, zone: "hand" })}>Move to hand</button>
    <button onClick={() => run({ type: "MOVE_CARD", cardId: card.id, zone: "graveyard" })}>Graveyard / Sacrifice</button>
    <button onClick={() => run({ type: "MOVE_CARD", cardId: card.id, zone: "exile" })}>Exile</button>
    <button onClick={() => run({ type: "MOVE_CARD", cardId: card.id, zone: "library", placement: "top" })}>Top of library</button>
    <button onClick={() => run({ type: "MOVE_CARD", cardId: card.id, zone: "library", placement: "bottom" })}>Bottom of library</button>
    {isCommander && card.zone !== "commander" && <button onClick={() => run({ type: "MOVE_CARD", cardId: card.id, zone: "commander" })}>Return to command zone</button>}
    <button onClick={() => run({ type: "TOGGLE_FACE_DOWN", cardId: card.id })}>{card.faceDown ? "Turn face up" : "Turn face down"}</button>
    {record?.otherFaceImageUrl && <button onClick={() => run({ type: "TOGGLE_TRANSFORM", cardId: card.id })}>{card.transformed ? `Show front · ${card.name}` : `Transform · ${record.otherFaceName ?? "back face"}`}</button>}
    <button onClick={() => run({ type: "CLONE_CARD", cardId: card.id })}>Clone / create copy</button>
    {card.zone === "battlefield" && <button onClick={card.attachedTo ? () => run({ type: "ATTACH_CARD", cardId: card.id, targetCardId: null }) : attach}>{card.attachedTo ? "Unattach" : "Attach to…"}</button>}
    {card.zone === "battlefield" && <button onClick={giveControl}>Give control to…</button>}
    <button onClick={() => { onPrompt({ title: "Card annotation", description: card.name, fields: [{ key: "annotation", label: "Annotation", value: card.annotation, multiline: true, required: false }], onSubmit: ({ annotation }) => dispatch({ type: "SET_ANNOTATION", cardId: card.id, annotation }) }); onClose(); }}>Set annotation</button>
    <button onClick={() => run({ type: card.revealed ? "HIDE_CARD" : "REVEAL_CARD", cardId: card.id })}>{card.revealed ? "Hide" : "Reveal"}</button>
    <button onClick={onChooseArtwork}>Choose artwork / edition</button>
    <div className="context-counter"><span>Counters</span><button onClick={() => dispatch({ type: "ADD_COUNTER", cardId: card.id, delta: -1 })}><Minus size={13} /></button><b>{card.counters}</b><button onClick={() => dispatch({ type: "ADD_COUNTER", cardId: card.id, delta: 1 })}><Plus size={13} /></button></div>
    <button onClick={setCounters}>Set +1/+1 counters…</button>
    <button onClick={setNamedCounter}>Set named counter…</button>
    {Object.entries(card.namedCounters).map(([name, value]) => <div className="named-counter-control" key={name}><span>{name}</span><button onClick={() => dispatch({ type: "SET_NAMED_COUNTER", cardId: card.id, name, value: value - 1 })}>−</button><b>{value}</b><button onClick={() => dispatch({ type: "SET_NAMED_COUNTER", cardId: card.id, name, value: value + 1 })}>+</button><button className="remove" onClick={() => dispatch({ type: "SET_NAMED_COUNTER", cardId: card.id, name, value: 0 })}>Remove</button></div>)}
    {basePower !== null && baseToughness !== null && <><div className="context-counter"><span>Temp P/T</span><button onClick={() => dispatch({ type: "MODIFY_POWER_TOUGHNESS", cardId: card.id, power: -1, toughness: 0 })}>P−</button><button onClick={() => dispatch({ type: "MODIFY_POWER_TOUGHNESS", cardId: card.id, power: 1, toughness: 0 })}>P+</button><button onClick={() => dispatch({ type: "MODIFY_POWER_TOUGHNESS", cardId: card.id, power: 0, toughness: -1 })}>T−</button><button onClick={() => dispatch({ type: "MODIFY_POWER_TOUGHNESS", cardId: card.id, power: 0, toughness: 1 })}>T+</button></div><button onClick={setPowerToughness}>Set power / toughness…</button><button onClick={() => run({ type: "RESET_POWER_TOUGHNESS", cardId: card.id })}>Reset power / toughness</button></>}
  </aside>;
}

function GamePromptModal({ config, onClose }: { config: GamePromptConfig; onClose: () => void }) {
  const [values, setValues] = useState(() => Object.fromEntries(config.fields.map((field) => [field.key, field.value ?? field.options?.[0]?.value ?? ""])));
  const [error, setError] = useState("");
  function submit(event: React.FormEvent) {
    event.preventDefault();
    for (const field of config.fields) {
      const value = values[field.key]?.trim() ?? "";
      if (field.required !== false && !value) { setError(`${field.label} is required.`); return; }
      if (field.type === "number" && value) {
        const number = Number(value);
        if (!Number.isFinite(number) || (field.min !== undefined && number < field.min) || (field.max !== undefined && number > field.max)) {
          setError(`${field.label} must be between ${field.min ?? "−∞"} and ${field.max ?? "+∞"}.`); return;
        }
      }
    }
    config.onSubmit(values);
    onClose();
  }
  return <div className="game-prompt-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="game-prompt" role="dialog" aria-modal="true" aria-label={config.title} onSubmit={submit} noValidate>
      <header><div><span className="kicker">Game action</span><strong>{config.title}</strong>{config.description && <p>{config.description}</p>}</div><button type="button" onClick={onClose} aria-label="Close dialog"><X size={17} /></button></header>
      <section>{config.fields.map((field) => <label key={field.key}>{field.label}{field.options ? <select value={values[field.key]} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : field.multiline ? <textarea autoFocus value={values[field.key]} rows={4} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} /> : <input autoFocus={config.fields[0] === field} type={field.type ?? "text"} value={values[field.key]} min={field.min} max={field.max} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} />}</label>)}</section>
      {error && <div className="inline-error">{error}</div>}
      <footer><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button">Confirm</button></footer>
    </form>
  </div>;
}

function ArrowLayer({ arrows, attachments, draft, onRemove }: { arrows: CommanderArrow[]; attachments: CommanderArrow[]; draft: ArrowDraft | null; onRemove: (arrowId: string) => void }) {
  const [, refresh] = useState(0);
  useEffect(() => {
    const update = () => refresh((value) => value + 1);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, []);
  return <svg className="table-arrows" aria-label="Game arrows">
    <defs><marker id="novatable-arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
    {arrows.map((arrow) => {
      const from = targetCenter(arrow.from); const to = targetCenter(arrow.to);
      if (!from || !to) return null;
      const path = arrowPath(from, to);
      return <g key={arrow.id}><path className="table-arrow-hit" data-arrow-id={arrow.id} d={path} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onRemove(arrow.id); }} /><path className="table-arrow" d={path} markerEnd="url(#novatable-arrowhead)" /></g>;
    })}
    {attachments.map((arrow) => { const from = targetCenter(arrow.from); const to = targetCenter(arrow.to); return from && to ? <path className="table-attachment" key={arrow.id} d={arrowPath(from, to)} /> : null; })}
    {draft?.started && (() => { const from = targetCenter(draft.from); return from ? <path className="table-arrow is-draft" d={arrowPath(from, { x: draft.clientX, y: draft.clientY })} markerEnd="url(#novatable-arrowhead)" /> : null; })()}
  </svg>;
}

function arrowTarget(element: Element | null): CommanderTarget | null {
  const cardId = element?.closest<HTMLElement>("[data-card-id]")?.dataset.cardId;
  if (cardId) return { kind: "card", id: cardId };
  const playerId = element?.closest<HTMLElement>("[data-player-target]")?.dataset.playerTarget;
  return playerId ? { kind: "player", id: playerId } : null;
}

function targetKey(target: CommanderTarget) { return `${target.kind}:${target.id}`; }

function targetCenter(target: CommanderTarget) {
  const attribute = target.kind === "card" ? "cardId" : "playerTarget";
  const element = [...document.querySelectorAll<HTMLElement>(target.kind === "card" ? "[data-card-id]" : "[data-player-target]")].find((candidate) => candidate.dataset[attribute] === target.id);
  if (!element) return null;
  const bounds = element.getBoundingClientRect();
  return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
}

function arrowPath(from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = to.x - from.x; const dy = to.y - from.y; const distance = Math.max(1, Math.hypot(dx, dy));
  const start = { x: from.x + dx / distance * 18, y: from.y + dy / distance * 18 };
  const end = { x: to.x - dx / distance * 26, y: to.y - dy / distance * 26 };
  const bend = Math.min(55, distance * .1);
  const control = { x: (start.x + end.x) / 2 - dy / distance * bend, y: (start.y + end.y) / 2 + dx / distance * bend };
  return `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
}

function fallbackType(card: CommanderCardState) {
  if (card.token) return card.power !== null ? `Token Creature — ${card.name}` : `Token — ${card.name}`;
  if (card.power !== null) return "Creature";
  return ["Forest", "Island", "Plains", "Mountain", "Swamp", "Wastes", "Command Tower"].includes(card.name) ? "Land" : "Spell";
}

function clamp(value: number, minimum: number, maximum: number) { return Math.max(minimum, Math.min(maximum, value)); }
function numericStat(value: string | null | undefined) { const number = Number(value); return value !== null && value !== undefined && value.trim() !== "" && Number.isFinite(number) ? number : null; }
function roundCoordinate(value: number) { return Math.round(value * 100) / 100; }
