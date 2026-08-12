import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  Bell, Camera, Check, ChevronRight, Copy, Crown, DoorOpen, Gamepad2, Home,
  Library, LockKeyhole, LogOut, MessageCircle, Plus, Search, Send,
  Settings, Shield, Sparkles, Trash2, UserPlus, Users, X, Minus, Save, Moon, Sun
} from "lucide-react";
import { CardArtworkPicker, CommanderArtwork } from "../cards/CardArtwork";
import { FullscreenButton } from "../shell/FullscreenButton";
import type { GameSetupPlayer } from "../../domain/commander/types";
import type { Deck, DeckCardEntry, Lobby, LobbyFormat, UserProfile } from "../../domain/platform/types";
import { getCardByName, searchCardDatabase, type CardRecord } from "../../infrastructure/cardDatabase";
import {
  answerFriendRequest, decksFor, deleteDeck, friendSnapshot, invitationsFor,
  inviteFriendToLobby, parseDeckList, saveDeck, searchUsers, sendFriendRequest,
  updateDeck, updateProfile
} from "../../infrastructure/localPlatform";
import {
  onlineCreateLobby, onlineFindLobby, onlineJoinLobby, onlineLeaveLobby,
  onlineLobby, onlineLobbyAction, onlinePublicLobbies, honorLeaderboard
} from "../../infrastructure/remoteLobby";

type View = "home" | "friends" | "lobbies" | "decks" | "profile" | "create";

export function PlatformApp({
  user,
  onLogout,
  onUserUpdated,
  onStartGame
}: {
  user: UserProfile;
  onLogout: () => void;
  onUserUpdated: (user: UserProfile) => void;
  onStartGame: (players: GameSetupPlayer[], startingLife: number, lobbyName: string, gameId: string, seed: number) => void;
}) {
  const [view, setView] = useState<View>("home");
  const [activeLobby, setActiveLobby] = useState<Lobby | null>(null);
  const [revision, setRevision] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const refresh = () => setRevision((value) => value + 1);
  const decks = useMemo(() => decksFor(user.id), [user.id, revision]);

  useEffect(() => {
    if (!activeLobby) return;
    let active = true; let busy = false;
    const refreshLobby = async () => {
      if (busy) return; busy = true;
      try { const lobby = await onlineLobby(activeLobby.id); if (active && lobby) setActiveLobby(lobby); }
      catch { /* the next poll retries transient failures */ }
      finally { busy = false; }
    };
    const timer = window.setInterval(() => void refreshLobby(), 800);
    return () => { active = false; window.clearInterval(timer); };
  }, [activeLobby?.id]);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 2600);
  }

  if (activeLobby) {
    return (
      <>
        <LobbyRoom
          user={user}
          lobby={activeLobby}
          decks={decks}
          onLobby={setActiveLobby}
          onNotify={notify}
          onLeave={() => { void onlineLeaveLobby(activeLobby.id, user.id); setActiveLobby(null); setView("home"); refresh(); }}
          onStart={async (lobby) => {
            const localDeck = decks.find((deck) => deck.id === lobby.players.find((player) => player.userId === user.id)?.deckId) ?? decks[0];
            const names = new Set(lobby.players.flatMap((player) => [player.commander ?? localDeck?.commander ?? "", ...(player.cards?.length ? player.cards : localDeck?.cards ?? []).map((card) => card.name)]).filter(Boolean));
            const records = new Map(await Promise.all([...names].map(async (name) => [name.toLowerCase(), await getCardByName(name)] as const)));
            const players: GameSetupPlayer[] = lobby.players.map((player) => ({
              id: player.userId,
              name: player.displayName,
              avatar: player.avatar,
              avatarImage: player.avatarImage,
              accentColor: player.accentColor,
              commander: player.commander ?? localDeck?.commander ?? "Unknown Commander",
              commanderManaCost: records.get((player.commander ?? localDeck?.commander ?? "").toLowerCase())?.manaCost,
              manaColors: records.get((player.commander ?? localDeck?.commander ?? "").toLowerCase())?.colorIdentity?.filter((color) => "WUBRG".includes(color)) as GameSetupPlayer["manaColors"],
              cards: (player.cards?.length ? player.cards : localDeck?.cards ?? []).map((card) => ({ ...card, manaCost: records.get(card.name.toLowerCase())?.manaCost ?? "" })),
              local: player.userId === user.id
            }));
            onStartGame(players, lobby.startingLife, lobby.name, lobby.id, lobby.gameSeed ?? 1);
          }}
        />
        {toast && <div className="toast"><Check size={14} />{toast}</div>}
      </>
    );
  }

  return (
    <div className="platform-shell" style={{ "--nt-green": user.accentColor ?? "#62e6bb" } as React.CSSProperties}>
      <aside className="app-sidebar">
        <div className="brand-lockup"><img src="/novatable-logo.svg" alt="" /><strong>NovaTable</strong></div>
        <nav>
          <NavItem icon={<Home />} label="Home" active={view === "home"} onClick={() => setView("home")} />
          <NavItem icon={<Users />} label="Friends" active={view === "friends"} onClick={() => setView("friends")} />
          <NavItem icon={<DoorOpen />} label="Lobbies" active={view === "lobbies" || view === "create"} onClick={() => setView("lobbies")} />
          <NavItem icon={<Library />} label="Decks" active={view === "decks"} onClick={() => setView("decks")} />
          <NavItem icon={<Settings />} label="Profile & Settings" active={view === "profile"} onClick={() => setView("profile")} />
        </nav>
        <div className="sidebar-account">
          <Avatar user={user} /><div><strong>{user.displayName}</strong><span>@{user.username} · Online</span></div>
          <button onClick={onLogout} aria-label="Logout"><LogOut size={15} /></button>
        </div>
      </aside>
      <main className="platform-main">
        <header className="platform-topbar">
          <div><span className="presence-dot" /><span>NovaTable services</span></div>
          <div className="platform-window-actions"><FullscreenButton /><button aria-label="Notifications"><Bell size={17} /></button></div>
        </header>
        {view === "home" && <HomeView user={user} decks={decks} revision={revision} onCreate={() => setView("create")} onJoin={setActiveLobby} onBrowse={() => setView("lobbies")} onNotify={notify} />}
        {view === "friends" && <FriendsView user={user} revision={revision} refresh={refresh} onNotify={notify} />}
        {view === "lobbies" && <LobbiesView user={user} onCreate={() => setView("create")} onJoin={setActiveLobby} onNotify={notify} />}
        {view === "decks" && <DecksView user={user} decks={decks} onSaved={() => { refresh(); notify("Commander deck imported"); }} />}
        {view === "profile" && <ProfileView user={user} onLogout={onLogout} onUpdated={onUserUpdated} />}
        {view === "create" && <CreateLobbyView user={user} onCancel={() => setView("lobbies")} onCreated={setActiveLobby} />}
      </main>
      {toast && <div className="toast"><Check size={14} />{toast}</div>}
    </div>
  );
}

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return <button className={active ? "is-active" : ""} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function Avatar({ user }: { user: Pick<UserProfile, "avatar" | "displayName" | "avatarImage" | "accentColor"> }) {
  return <span className={`avatar ${user.avatarImage ? "has-image" : ""}`} title={user.displayName} style={{ borderColor: user.accentColor }}>{user.avatarImage ? <img src={user.avatarImage} alt="" /> : user.avatar}</span>;
}

function HomeView({ user, decks, revision, onCreate, onJoin, onBrowse, onNotify }: {
  user: UserProfile; decks: Deck[]; revision: number; onCreate: () => void;
  onJoin: (lobby: Lobby) => void; onBrowse: () => void; onNotify: (message: string) => void;
}) {
  const [code, setCode] = useState(""); const [password, setPassword] = useState("");
  const [lobbies, setLobbies] = useState<Lobby[]>([]);
  const [leaders, setLeaders] = useState<UserProfile[]>([]);
  const social = useMemo(() => friendSnapshot(user.id), [user.id, revision]);
  const invites = useMemo(() => invitationsFor(user.id), [user.id, revision]);
  useEffect(() => { let active = true; void onlinePublicLobbies().then((value) => { if (active) setLobbies(value.slice(0, 3)); }).catch(() => {}); return () => { active = false; }; }, [revision]);
  useEffect(() => { let active = true; void honorLeaderboard().then((value) => { if (active) setLeaders(value.slice(0, 5)); }).catch(() => {}); return () => { active = false; }; }, [revision]);
  async function joinByCode(event: FormEvent) {
    event.preventDefault();
    try { const lobby = await onlineFindLobby(code); onJoin(await onlineJoinLobby(lobby.id, user, password)); }
    catch (error) { onNotify(error instanceof Error ? error.message : String(error)); }
  }
  return <div className="page-content">
    <section className="home-hero">
      <div><span className="kicker">Good evening, {user.displayName}</span><h1>Bring the pod together.</h1><p>Create a private Commander table or find players already waiting.</p>
        <div className="hero-actions"><button className="primary-button" onClick={onCreate}><Plus size={17} />Create Lobby</button><button className="secondary-button" onClick={onBrowse}><DoorOpen size={17} />Join Lobby</button></div>
      </div>
      <div className="hero-orbit"><i>40</i><span>COMMANDER<br />READY</span></div>
    </section>
    <section className="quick-join card-panel"><div><span className="panel-icon"><LockKeyhole size={16} /></span><div><strong>Have a private lobby code?</strong><p>Jump directly into your friend's room.</p></div></div><form onSubmit={joinByCode}><input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="LOBBY CODE" maxLength={6} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="PASSWORD (OPTIONAL)" /><button>Join <ChevronRight size={14} /></button></form></section>
    <div className="home-grid">
      <section className="card-panel section-card"><SectionTitle title="Friends online" action="View all" /><div className="people-list">
        {social.friends.filter((friend) => friend.presence !== "offline").length ? social.friends.filter((friend) => friend.presence !== "offline").map((friend) => <PersonRow key={friend.id} user={friend} />) : <EmptyMini text="Online friends will appear here." />}
      </div></section>
      <section className="card-panel section-card"><SectionTitle title="Invites" action={`${invites.length} pending`} />{invites.length ? invites.map(({ invite, lobby, from }) => <button className="invite-row" key={invite.id} onClick={() => void onlineJoinLobby(lobby.id, user).then(onJoin).catch((error) => onNotify(error instanceof Error ? error.message : String(error)))}><Avatar user={from} /><div><strong>{from.displayName} invited you</strong><span>{lobby.name} · {lobby.format}</span></div><ChevronRight size={15} /></button>) : <EmptyMini text="Lobby invites will appear here." />}</section>
      <section className="card-panel section-card home-wide"><SectionTitle title="Public lobbies" action="Browse all" /><div className="compact-lobbies">{lobbies.map((lobby) => <LobbyRow key={lobby.id} lobby={lobby} onJoin={() => void onlineJoinLobby(lobby.id, user).then(onJoin).catch((error) => onNotify(error instanceof Error ? error.message : String(error)))} />)}</div></section>
      <section className="card-panel section-card"><SectionTitle title="Recent decks" action="Deck library" />{decks.slice(-3).map((deck) => <div className="deck-mini" key={deck.id}><CommanderArtwork name={deck.commander} compact /><div><strong>{deck.name}</strong><small>{deck.commander}</small></div></div>)}</section>
      <section className="card-panel section-card"><SectionTitle title="Honor leaderboard" action="Community votes" />{leaders.map((leader, index) => <div className="honor-row" key={leader.id}><b>{index + 1}</b><PersonRow user={leader} /><strong>{leader.honor ?? 0}</strong></div>)}{!leaders.length && <EmptyMini text="Honor votes will appear after completed games." />}</section>
    </div>
  </div>;
}

function FriendsView({ user, revision, refresh, onNotify }: { user: UserProfile; revision: number; refresh: () => void; onNotify: (message: string) => void }) {
  const [query, setQuery] = useState("");
  const social = useMemo(() => friendSnapshot(user.id), [user.id, revision]);
  const results = useMemo(() => searchUsers(query, user.id), [query, user.id, revision]);
  return <div className="page-content"><PageHeading kicker="Social" title="Friends" subtitle="Find players once, then invite them to every game." />
    <div className="social-layout"><section className="card-panel social-search"><label><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by username" /></label>{results.map((result) => <div className="friend-result" key={result.id}><PersonRow user={result} /><button onClick={() => { sendFriendRequest(user.id, result.id); onNotify(`Friend request sent to @${result.username}`); setQuery(""); refresh(); }}><UserPlus size={14} />Add</button></div>)}</section>
      <section className="card-panel"><SectionTitle title="Requests" action={`${social.requests.length}`} />{social.requests.map(({ friendship, user: sender }) => <div className="request-row" key={friendship.id}><PersonRow user={sender} /><div><button onClick={() => { answerFriendRequest(friendship.id, true); refresh(); }}>Accept</button><button onClick={() => { answerFriendRequest(friendship.id, false); refresh(); }}><X size={13} /></button></div></div>)}{!social.requests.length && <EmptyMini text="No pending requests." />}</section>
      <section className="card-panel friends-list"><SectionTitle title="Your friends" action={`${social.friends.length}`} />{social.friends.map((friend) => <PersonRow key={friend.id} user={friend} />)}{!social.friends.length && <EmptyMini text="Your accepted friends will appear here." />}</section>
    </div></div>;
}

function LobbiesView({ user, onCreate, onJoin, onNotify }: { user: UserProfile; onCreate: () => void; onJoin: (lobby: Lobby) => void; onNotify: (message: string) => void }) {
  const [code, setCode] = useState(""); const [password, setPassword] = useState(""); const [lobbies, setLobbies] = useState<Lobby[]>([]);
  useEffect(() => { let active = true; const load = () => void onlinePublicLobbies().then((value) => { if (active) setLobbies(value); }).catch(() => {}); load(); const timer = window.setInterval(load, 2000); return () => { active = false; window.clearInterval(timer); }; }, []);
  async function submit(event: FormEvent) { event.preventDefault(); try { const lobby = await onlineFindLobby(code); onJoin(await onlineJoinLobby(lobby.id, user, password)); } catch (error) { onNotify(error instanceof Error ? error.message : String(error)); } }
  return <div className="page-content"><div className="heading-actions"><PageHeading kicker="Multiplayer" title="Lobby browser" subtitle="Public tables and direct private-code entry." /><button className="primary-button" onClick={onCreate}><Plus size={16} />Create Lobby</button></div>
    <form className="lobby-code-bar card-panel" onSubmit={submit}><LockKeyhole size={16} /><input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="Enter private lobby code" maxLength={6} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password (optional)" /><button>Join by code</button></form>
    <div className="lobby-browser">{lobbies.map((lobby) => <LobbyCard key={lobby.id} lobby={lobby} onJoin={() => void onlineJoinLobby(lobby.id, user).then(onJoin).catch((error) => onNotify(error instanceof Error ? error.message : String(error)))} />)}</div>
  </div>;
}

function CreateLobbyView({ user, onCancel, onCreated }: { user: UserProfile; onCancel: () => void; onCreated: (lobby: Lobby) => void }) {
  const [name, setName] = useState("Commander Night"); const [format, setFormat] = useState<LobbyFormat>("Commander");
  const [privacy, setPrivacy] = useState<"public" | "private">("private"); const [maxPlayers, setMaxPlayers] = useState(4);
  const [spectators, setSpectators] = useState(true); const [startingLife, setStartingLife] = useState(40);
  const [bracket, setBracket] = useState<1 | 2 | 3 | 4 | 5>(3);
  const [password, setPassword] = useState(""); const [description, setDescription] = useState("Casual Commander with friends");
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) { event.preventDefault(); try { onCreated(await onlineCreateLobby(user, { name, format, privacy, maxPlayers, spectatorsAllowed: spectators, startingLife, password, description, bracket })); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }
  return <div className="page-content create-page"><button className="text-button" onClick={onCancel}>← Back to lobbies</button><PageHeading kicker="New multiplayer room" title="Create a lobby" subtitle="Set the table now; everything can stay manual once the game starts." />
    <form className="create-lobby card-panel" onSubmit={submit}><div className="form-grid"><label className="wide">Lobby name<input value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Format<select value={format} onChange={(event) => { const next = event.target.value as LobbyFormat; setFormat(next); if (next === "Commander") { setMaxPlayers(4); setStartingLife(40); } }}><option>Commander</option><option>Standard</option><option>Modern</option><option>Legacy</option><option>Vintage</option><option>Pauper</option><option>Custom</option></select></label><label>Commander bracket<select value={bracket} onChange={(event) => setBracket(Number(event.target.value) as 1 | 2 | 3 | 4 | 5)}><option value={1}>1 · Exhibition</option><option value={2}>2 · Core</option><option value={3}>3 · Upgraded</option><option value={4}>4 · Optimized</option><option value={5}>5 · cEDH</option></select></label><label>Privacy<select value={privacy} onChange={(event) => setPrivacy(event.target.value as "public" | "private")}><option value="private">Private</option><option value="public">Public</option></select></label><label>Max players<select value={maxPlayers} onChange={(event) => setMaxPlayers(Number(event.target.value))}><option value={2}>2</option><option value={3}>3</option><option value={4}>4</option></select></label><label>Starting life<input type="number" min={1} value={startingLife} onChange={(event) => setStartingLife(Number(event.target.value))} /></label><label>Password <small>optional</small><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><label className="toggle-label">Spectators allowed<input type="checkbox" checked={spectators} onChange={(event) => setSpectators(event.target.checked)} /></label><label className="wide">Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label></div>{error && <div className="inline-error">{error}</div>}<footer><button type="button" className="secondary-button" onClick={onCancel}>Cancel</button><button className="primary-button"><Sparkles size={16} />Create Lobby</button></footer></form>
  </div>;
}

function DecksView({ user, decks, onSaved }: { user: UserProfile; decks: Deck[]; onSaved: () => void }) {
  const [name, setName] = useState("My Commander Deck"); const [commander, setCommander] = useState("");
  const [list, setList] = useState("1 Sol Ring\n1 Arcane Signet\n1 Command Tower\n1 Swords to Plowshares"); const [error, setError] = useState<string | null>(null);
  const [artworkName, setArtworkName] = useState<string | null>(null);
  const [selectedDeckId, setSelectedDeckId] = useState<string | null>(null);
  const selectedDeck = decks.find((deck) => deck.id === selectedDeckId);
  function submit(event: FormEvent) { event.preventDefault(); try { saveDeck({ ownerId: user.id, name, commander, list }); setError(null); onSaved(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }
  if (selectedDeck) return <DeckEditor key={selectedDeck.id} deck={selectedDeck} userId={user.id} onBack={() => setSelectedDeckId(null)} onArtwork={setArtworkName} onChanged={onSaved} onDeleted={() => { setSelectedDeckId(null); onSaved(); }} artworkName={artworkName} onCloseArtwork={() => setArtworkName(null)} />;
  return <div className="page-content"><PageHeading kicker="Collection" title="Commander decks" subtitle="Open a deck to inspect and edit every card." /><div className="decks-layout"><section className="deck-library">{decks.map((deck) => <article className="deck-card card-panel" key={deck.id} role="button" tabIndex={0} onClick={() => setSelectedDeckId(deck.id)} onKeyDown={(event) => { if (event.key === "Enter") setSelectedDeckId(deck.id); }}><button className="deck-art" onClick={(event) => { event.stopPropagation(); setArtworkName(deck.commander); }} title="Choose commander artwork"><CommanderArtwork name={deck.commander} /><span className="deck-art-action">Change artwork</span></button><div><span>{deck.format}</span><h3>{deck.name}</h3><p>{deck.commander}</p><small>{deck.cards.reduce((sum, card) => sum + card.quantity, 0) + 1} cards</small><b>Open deck →</b></div></article>)}</section><form className="deck-import card-panel" onSubmit={submit}><SectionTitle title="Import deck list" action="Text / Moxfield export" /><label>Deck name<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>Commander<input value={commander} onChange={(event) => setCommander(event.target.value)} placeholder="Atraxa, Praetors' Voice" /></label><label>Card list<textarea value={list} onChange={(event) => setList(event.target.value)} rows={12} /></label>{error && <div className="inline-error">{error}</div>}<button className="primary-button"><Plus size={15} />Import Commander deck</button></form></div>{artworkName && <CardArtworkPicker cardName={artworkName} onClose={() => setArtworkName(null)} />}</div>;
}

function DeckEditor({ deck, userId, onBack, onArtwork, onChanged, onDeleted, artworkName, onCloseArtwork }: { deck: Deck; userId: string; onBack: () => void; onArtwork: (name: string) => void; onChanged: () => void; onDeleted: () => void; artworkName: string | null; onCloseArtwork: () => void }) {
  const [name, setName] = useState(deck.name); const [commander, setCommander] = useState(deck.commander);
  const [cards, setCards] = useState<DeckCardEntry[]>(deck.cards.map((card) => ({ ...card })));
  const [newCard, setNewCard] = useState(""); const [newQuantity, setNewQuantity] = useState(1); const [bulk, setBulk] = useState("");
  const [searchResults, setSearchResults] = useState<CardRecord[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => void searchCardDatabase(newCard).then((results) => { if (active) setSearchResults(results); }), 160);
    return () => { active = false; window.clearTimeout(timeout); };
  }, [newCard]);
  function adjust(index: number, delta: number) { setCards((current) => current.flatMap((card, cardIndex) => cardIndex === index ? card.quantity + delta > 0 ? [{ ...card, quantity: card.quantity + delta }] : [] : [card])); }
  function addCard(event: FormEvent) { event.preventDefault(); if (!newCard.trim()) return; setCards((current) => mergeDeckEntries([...current, { name: newCard, quantity: newQuantity }])); setNewCard(""); setNewQuantity(1); }
  function addBulk() { try { setCards((current) => mergeDeckEntries([...current, ...parseDeckList(bulk)])); setBulk(""); setMessage("Cards added"); } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); } }
  function save() { try { updateDeck(deck.id, userId, { name, commander, cards }); onChanged(); setMessage("Deck saved"); } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); } }
  function removeDeck() { try { deleteDeck(deck.id, userId); onDeleted(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); } }
  const total = cards.reduce((sum, card) => sum + card.quantity, 0) + 1;
  return <div className="page-content deck-editor-page"><button className="text-button" onClick={onBack}>← Back to decks</button><div className="deck-editor-heading"><button className="deck-editor-cover" onClick={() => onArtwork(commander)}><CommanderArtwork name={commander} /><span>Choose artwork</span></button><div><span className="kicker">Commander deck · {total} cards</span><input aria-label="Deck name" value={name} onChange={(event) => setName(event.target.value)} /><label>Commander<input aria-label="Commander" value={commander} onChange={(event) => setCommander(event.target.value)} /></label></div><div><button className="secondary-button delete-deck" onClick={() => setConfirmDelete(true)}><Trash2 size={15} />Delete deck</button><button className="primary-button" onClick={save}><Save size={15} />Save changes</button></div></div>
    <div className="deck-editor-layout"><section className="deck-card-list card-panel"><header><div><strong>Deck cards</strong><span>{cards.length} unique · {total - 1} main deck</span></div></header><div>{cards.map((card, index) => <article className="deck-entry" key={`${card.name}-${index}`}><button className="deck-entry-art" onClick={() => onArtwork(card.name)} title={`Choose artwork for ${card.name}`} aria-label={`Choose artwork for ${card.name}`}><CommanderArtwork name={card.name} compact /></button><div><strong>{card.name}</strong><small>{card.quantity} copies</small></div><div className="deck-quantity"><button aria-label={`Remove one ${card.name}`} onClick={() => adjust(index, -1)}><Minus size={14} /></button><b>{card.quantity}</b><button aria-label={`Add one ${card.name}`} onClick={() => adjust(index, 1)}><Plus size={14} /></button></div><button className="remove-card" aria-label={`Remove ${card.name}`} onClick={() => setCards((current) => current.filter((_, cardIndex) => cardIndex !== index))}><Trash2 size={14} /></button></article>)}</div></section>
      <aside className="deck-edit-tools"><form className="card-panel deck-database-search" onSubmit={addCard}><SectionTitle title="Card database" action="Search & add" /><label>Card name<input value={newCard} onChange={(event) => setNewCard(event.target.value)} placeholder="Start typing, e.g. Sol Ring" /></label>{searchResults.length > 0 && <div className="deck-search-results">{searchResults.map((card) => <button type="button" key={card.nameLower} onClick={() => { setCards((current) => mergeDeckEntries([...current, { name: card.name, quantity: newQuantity }])); setNewCard(""); }}><CommanderArtwork name={card.name} compact /><span><strong>{card.name}</strong><small>{card.typeLine}</small></span><Plus size={14} /></button>)}</div>}<label>Quantity<input type="number" min={1} max={99} value={newQuantity} onChange={(event) => setNewQuantity(Number(event.target.value))} /></label><button className="primary-button"><Plus size={14} />Add exact name</button></form><section className="card-panel"><SectionTitle title="Add from text" action="Moxfield / Archidekt" /><textarea aria-label="Cards to add" value={bulk} onChange={(event) => setBulk(event.target.value)} rows={9} placeholder={"1 Arcane Signet\n1 Command Tower"} /><button className="secondary-button" onClick={addBulk}><Plus size={14} />Add list to deck</button></section>{message && <div className={message === "Deck saved" || message === "Cards added" ? "profile-saved" : "inline-error"}>{message}</div>}</aside>
    </div>{artworkName && <CardArtworkPicker cardName={artworkName} onClose={onCloseArtwork} />}{confirmDelete && <div className="game-prompt-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) setConfirmDelete(false); }}><section className="game-prompt" role="dialog" aria-modal="true" aria-label="Delete deck"><header><div><span className="kicker">Confirm action</span><strong>Delete {deck.name}?</strong><p>This cannot be undone.</p></div><button onClick={() => setConfirmDelete(false)} aria-label="Close dialog"><X size={17} /></button></header><footer><button className="secondary-button" onClick={() => setConfirmDelete(false)}>Cancel</button><button className="primary-button delete-deck" onClick={removeDeck}>Delete deck</button></footer></section></div>}</div>;
}

function ProfileView({ user, onLogout, onUpdated }: { user: UserProfile; onLogout: () => void; onUpdated: (user: UserProfile) => void }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [avatarImage, setAvatarImage] = useState(user.avatarImage);
  const [accentColor, setAccentColor] = useState(user.accentColor ?? "#62e6bb");
  const [bio, setBio] = useState(user.bio ?? "");
  const [theme, setTheme] = useState<"dark" | "light">(user.theme ?? "dark");
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    return () => { document.documentElement.dataset.theme = user.theme ?? "dark"; };
  }, [theme, user.theme]);
  async function chooseAvatar(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    try { setAvatarImage(await resizeAvatar(file)); setMessage(null); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    try { onUpdated(updateProfile(user.id, { displayName, avatarImage, accentColor, bio, theme })); setMessage("Profile saved"); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); }
  }
  const preview = { ...user, displayName, avatar: displayName.slice(0, 2).toUpperCase(), avatarImage, accentColor };
  return <div className="page-content"><PageHeading kicker="Account" title="Profile & Settings" subtitle="Customize how other players see you across NovaTable." />
    <section className="profile-card card-panel"><Avatar user={preview} /><div><h2>{displayName || user.displayName}</h2><p>@{user.username} · Honor {user.honor ?? 0}</p><span>{user.email}</span><code>User ID · {user.id}</code></div><button className="secondary-button" onClick={onLogout}><LogOut size={15} />Logout</button></section>
    <form className="profile-customization card-panel" onSubmit={save}><header><Shield size={19} /><div><strong>Profile customization</strong><p>These settings are stored with your global NovaTable identity.</p></div></header><div className="profile-settings-grid">
      <section className="avatar-editor"><Avatar user={preview} /><label className="secondary-button"><Camera size={15} />Upload photo<input aria-label="Profile photo" type="file" accept="image/*" onChange={chooseAvatar} /></label>{avatarImage && <button type="button" onClick={() => setAvatarImage(undefined)}><Trash2 size={14} />Remove photo</button>}</section>
      <div className="profile-fields"><label>Display name<input value={displayName} maxLength={40} onChange={(event) => setDisplayName(event.target.value)} /></label><label>Bio<textarea value={bio} maxLength={240} rows={4} onChange={(event) => setBio(event.target.value)} placeholder="Tell your pod something about you…" /></label><fieldset className="theme-picker"><legend>Interface theme</legend><button type="button" className={theme === "dark" ? "is-selected" : ""} onClick={() => setTheme("dark")}><Moon size={17} /><span><strong>Dark</strong><small>Default NovaTable theme</small></span></button><button type="button" className={theme === "light" ? "is-selected" : ""} onClick={() => setTheme("light")}><Sun size={17} /><span><strong>Light</strong><small>High-contrast daylight theme</small></span></button></fieldset><label className="accent-picker">Interface accent<input aria-label="Interface accent" type="color" value={accentColor} onChange={(event) => setAccentColor(event.target.value)} /><span>{accentColor}</span></label></div>
    </div>{message && <div className={message === "Profile saved" ? "profile-saved" : "inline-error"}>{message}</div>}<footer><button className="primary-button"><Sparkles size={15} />Save profile</button></footer></form>
    <small className="fan-content-notice">NovaTable is unofficial Fan Content permitted under the Wizards Fan Content Policy. Not approved or endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. © Wizards of the Coast LLC.</small>
  </div>;
}

function LobbyRoom({ user, lobby, decks, onLobby, onNotify, onLeave, onStart }: { user: UserProfile; lobby: Lobby; decks: Deck[]; onLobby: (lobby: Lobby) => void; onNotify: (message: string) => void; onLeave: () => void; onStart: (lobby: Lobby) => void | Promise<void> }) {
  const [message, setMessage] = useState(""); const [settingsOpen, setSettingsOpen] = useState(false); const [enteredGame, setEnteredGame] = useState(false);
  const local = lobby.players.find((player) => player.userId === user.id)!; const host = lobby.hostId === user.id;
  const social = friendSnapshot(user.id); const canStart = lobby.format === "Commander" && lobby.maxPlayers === 4 && lobby.players.length === 4 && lobby.players.every((player) => player.ready);
  const slots = Array.from({ length: lobby.maxPlayers }, (_, index) => lobby.players[index] ?? null);
  useEffect(() => { if (lobby.status === "in-game" && !enteredGame) { setEnteredGame(true); void onStart(lobby); } }, [enteredGame, lobby, onStart]);
  async function attempt(action: () => Promise<Lobby>) { try { onLobby(await action()); } catch (error) { onNotify(error instanceof Error ? error.message : String(error)); } }
  function chat(event: FormEvent) { event.preventDefault(); if (!message.trim()) return; void attempt(() => onlineLobbyAction(lobby.id, "message", { author: user.displayName, text: message })); setMessage(""); }
  return <main className="lobby-room-screen"><header className="lobby-room-top"><div className="brand-lockup"><img src="/novatable-logo.svg" alt="" /><strong>NovaTable</strong></div><div><span className="kicker">Private multiplayer lobby</span><h1>{lobby.name}</h1></div><div className="lobby-window-actions"><FullscreenButton /><button className="secondary-button" onClick={onLeave}><LogOut size={15} />Leave Lobby</button></div></header>
      <div className="lobby-room-body"><section className="lobby-stage"><div className="lobby-summary card-panel"><div><span className="privacy-badge"><LockKeyhole size={12} />{lobby.privacy}</span><strong>{lobby.format}</strong><span>Bracket {lobby.bracket ?? 3} · {lobby.players.length} / {lobby.maxPlayers} players</span></div><div className="lobby-code"><span>Lobby code</span><strong>{lobby.code}</strong><button onClick={() => { void navigator.clipboard?.writeText(lobby.code); onNotify("Lobby code copied"); }} aria-label="Copy lobby code"><Copy size={14} /></button></div></div>
      <div className="player-slots">{slots.map((player, index) => player ? <article className={`player-slot card-panel ${player.ready ? "is-ready" : ""}`} key={player.id}><Avatar user={player} /><div><div className="seat-name"><strong>{player.displayName}</strong>{player.host && <span><Crown size={11} />Host</span>}{player.bot && <small>DEV</small>}</div><p>@{player.username}</p><div className="seat-deck"><Library size={14} /><span>{player.deckName ?? "No deck selected"}</span></div><div className="seat-commander">{player.commander ?? "Choose a Commander deck"}</div></div><span className="ready-state">{player.ready ? <><Check size={13} />Ready</> : "Not ready"}</span>{host && !player.host && <button className="seat-kick" aria-label={`Kick ${player.displayName}`} onClick={() => void attempt(() => onlineLobbyAction(lobby.id, "kick", { hostId: user.id, playerId: player.id }))}><X size={13} /></button>}</article> : <article className="player-slot player-slot--empty card-panel" key={index}><span>{index + 1}</span><div><strong>Open player slot</strong><p>Invite a friend or add a development player.</p></div>{host && <button onClick={() => void attempt(() => onlineLobbyAction(lobby.id, "add-bot"))}><Plus size={14} />Add dev player</button>}</article>)}</div>
      <section className="lobby-controls card-panel"><div><label>Your deck<select value={local.deckId ?? ""} onChange={(event) => { const deck = decks.find((candidate) => candidate.id === event.target.value); if (deck) void attempt(() => onlineLobbyAction(lobby.id, "deck", { userId: user.id, deck })); }}><option value="">Choose a deck…</option>{decks.map((deck) => <option key={deck.id} value={deck.id}>{deck.name} — {deck.commander}</option>)}</select></label><button className={local.ready ? "ready-button is-ready" : "ready-button"} onClick={() => void attempt(() => onlineLobbyAction(lobby.id, "ready", { userId: user.id, ready: !local.ready }))}>{local.ready ? <><Check size={15} />Ready</> : "Set Ready"}</button></div><div><button className="secondary-button" onClick={() => { const friend = social.friends[0]; if (!friend) return onNotify("Accept a friend request first, or use dev players"); inviteFriendToLobby(lobby.id, user.id, friend.id); onNotify(`Invite sent to ${friend.displayName}`); }}><UserPlus size={15} />Invite Friends</button>{host && <button className="secondary-button" onClick={() => setSettingsOpen(!settingsOpen)}><Settings size={15} />Lobby Settings</button>}<button className="start-game-button" disabled={!canStart || !host} onClick={() => void attempt(async () => { const started = await onlineLobbyAction(lobby.id, "start", { hostId: user.id }); setEnteredGame(true); void onStart(started); return started; })}><Gamepad2 size={17} />Start Game</button></div>{!canStart && <small>Commander start requires four occupied seats and every player Ready.</small>}</section>
      {settingsOpen && host && <section className="lobby-settings card-panel"><label>Lobby name<input value={lobby.name} onChange={(event) => void attempt(() => onlineLobbyAction(lobby.id, "settings", { hostId: user.id, patch: { name: event.target.value } }))} /></label><label>Starting life<input type="number" value={lobby.startingLife} onChange={(event) => void attempt(() => onlineLobbyAction(lobby.id, "settings", { hostId: user.id, patch: { startingLife: Number(event.target.value) } }))} /></label><label>Bracket<select value={lobby.bracket ?? 3} onChange={(event) => void attempt(() => onlineLobbyAction(lobby.id, "settings", { hostId: user.id, patch: { bracket: Number(event.target.value) } }))}><option value={1}>1 · Exhibition</option><option value={2}>2 · Core</option><option value={3}>3 · Upgraded</option><option value={4}>4 · Optimized</option><option value={5}>5 · cEDH</option></select></label><label>Privacy<select value={lobby.privacy} onChange={(event) => void attempt(() => onlineLobbyAction(lobby.id, "settings", { hostId: user.id, patch: { privacy: event.target.value as "public" | "private" } }))}><option value="private">Private</option><option value="public">Public</option></select></label></section>}
      </section><aside className="lobby-chat card-panel"><div><MessageCircle size={16} /><strong>Lobby chat</strong></div><section>{lobby.messages.map((entry) => <article key={entry.id}><strong>{entry.author}</strong><p>{entry.text}</p></article>)}</section><form onSubmit={chat}><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Message the lobby" /><button aria-label="Send lobby message"><Send size={14} /></button></form></aside></div>
  </main>;
}

function LobbyCard({ lobby, onJoin }: { lobby: Lobby; onJoin: () => void }) { return <article className="lobby-card card-panel"><div className="lobby-card__art"><Gamepad2 size={23} /></div><div><span>{lobby.status === "waiting" ? "Open" : "In game"}</span><h3>{lobby.name}</h3><p>{lobby.description}</p><div>{lobby.tags.map((tag) => <i key={tag}>{tag}</i>)}</div></div><aside><strong>{lobby.format} · Bracket {lobby.bracket ?? 3}</strong><span>{lobby.players.length} / {lobby.maxPlayers} players</span><button onClick={onJoin}>Join Lobby</button></aside></article>; }
function LobbyRow({ lobby, onJoin }: { lobby: Lobby; onJoin: () => void }) { return <button className="lobby-row" onClick={onJoin}><span><Gamepad2 size={15} /></span><div><strong>{lobby.name}</strong><small>{lobby.format} · Bracket {lobby.bracket ?? 3} · {lobby.tags.filter((tag) => !tag.startsWith("Bracket ")).join(" · ")}</small></div><b>{lobby.players.length}/{lobby.maxPlayers}</b><ChevronRight size={14} /></button>; }
function PersonRow({ user }: { user: UserProfile }) { return <div className="person-row"><Avatar user={user} /><div><strong>{user.displayName}</strong><span>@{user.username}</span></div><i className={`presence presence--${user.presence}`} /></div>; }
function PageHeading({ kicker, title, subtitle }: { kicker: string; title: string; subtitle: string }) { return <div className="page-heading"><span className="kicker">{kicker}</span><h1>{title}</h1><p>{subtitle}</p></div>; }
function SectionTitle({ title, action }: { title: string; action: string }) { return <header className="section-title"><strong>{title}</strong><span>{action}</span></header>; }
function EmptyMini({ text }: { text: string }) { return <div className="empty-mini">{text}</div>; }

function mergeDeckEntries(entries: DeckCardEntry[]) {
  const merged = new Map<string, DeckCardEntry>();
  for (const entry of entries) {
    const name = entry.name.trim(); if (!name || entry.quantity <= 0) continue;
    const key = name.toLocaleLowerCase(); const current = merged.get(key);
    merged.set(key, { name: current?.name ?? name, quantity: (current?.quantity ?? 0) + Math.floor(entry.quantity) });
  }
  return [...merged.values()];
}

function resizeAvatar(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) return Promise.reject(new Error("Choose an image file."));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("This image format is not supported."));
      image.onload = () => {
        const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 256;
        const size = Math.min(image.width, image.height); const x = (image.width - size) / 2; const y = (image.height - size) / 2;
        canvas.getContext("2d")!.drawImage(image, x, y, size, size, 0, 0, 256, 256);
        resolve(canvas.toDataURL("image/jpeg", .86));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
