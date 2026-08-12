import { createServer } from "node:http";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const port = Number(process.env.PORT || 4747);
const dataDir = process.env.NOVATABLE_DATA || join(process.cwd(), "data");
const publicDir = process.env.NOVATABLE_PUBLIC || join(process.cwd(), "public");
const dataFile = join(dataDir, "novatable.json");
mkdirSync(dataDir, { recursive: true });

let data = existsSync(dataFile)
  ? JSON.parse(readFileSync(dataFile, "utf8"))
  : { accounts: [], sessions: {}, lobbies: [], games: {} };

function save() {
  const temporary = `${dataFile}.tmp`;
  writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
  renameSync(temporary, dataFile);
}

function send(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  response.end(JSON.stringify(body));
}

function body(request) {
  return new Promise((resolve, reject) => {
    let value = "";
    request.on("data", (chunk) => {
      value += chunk;
      if (value.length > 2_000_000) request.destroy(new Error("Request too large"));
    });
    request.on("end", () => {
      try { resolve(value ? JSON.parse(value) : {}); } catch { reject(new Error("Invalid JSON")); }
    });
    request.on("error", reject);
  });
}

function sessionUser(request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const userId = token && data.sessions[token];
  return data.accounts.find((account) => account.user.id === userId)?.user ?? null;
}

function passwordHash(password, salt) {
  return scryptSync(password, salt, 64).toString("hex");
}

function safeLobby(lobby) {
  return { ...structuredClone(lobby), password: lobby.password ? "__protected__" : "" };
}

function player(user, host = false) {
  return {
    id: `seat-${randomUUID()}`, userId: user.id, username: user.username,
    displayName: user.displayName, avatar: user.avatar, avatarImage: user.avatarImage,
    accentColor: user.accentColor, deckId: null, deckName: null, commander: null,
    cards: [], ready: false, host, bot: false
  };
}

function lobbyAction(lobby, user, input) {
  switch (input.action) {
    case "join":
      if (lobby.password && lobby.password !== String(input.password || "")) throw new Error("Lobby password is incorrect.");
      if (!lobby.players.some((candidate) => candidate.userId === user.id)) {
        if (lobby.status !== "waiting") throw new Error("This game has already started.");
        if (lobby.players.length >= lobby.maxPlayers) throw new Error("This lobby is full.");
        lobby.players.push(player(user));
      }
      break;
    case "leave":
      if (lobby.hostId === user.id) data.lobbies = data.lobbies.filter((candidate) => candidate.id !== lobby.id);
      else lobby.players = lobby.players.filter((candidate) => candidate.userId !== user.id);
      break;
    case "add-bot": {
      if (lobby.hostId !== user.id) throw new Error("Only the host can add development players.");
      if (lobby.players.length >= lobby.maxPlayers) throw new Error("Every player slot is occupied.");
      const index = lobby.players.length;
      const names = ["Mira Vale", "Orin", "Nia"];
      const commanders = ["Muldrotha, the Gravetide", "Isshin, Two Heavens as One", "Lathril, Blade of the Elves"];
      const name = names[Math.max(0, index - 1)] || `Player ${index + 1}`;
      lobby.players.push({ id: `seat-${randomUUID()}`, userId: `bot-${index}`, username: name.toLowerCase().replaceAll(" ", ""), displayName: name,
        avatar: name.slice(0, 2).toUpperCase(), deckId: `bot-deck-${index}`, deckName: `${name}'s Commander deck`,
        commander: commanders[Math.max(0, index - 1)] || "Atraxa, Praetors' Voice", cards: [], ready: true, host: false, bot: true });
      break;
    }
    case "deck": {
      const seat = lobby.players.find((candidate) => candidate.userId === user.id);
      const deck = input.deck;
      if (!seat || !deck?.id || !deck.commander || !Array.isArray(deck.cards)) throw new Error("Invalid deck selection.");
      seat.deckId = String(deck.id); seat.deckName = String(deck.name).slice(0, 80); seat.commander = String(deck.commander).slice(0, 120);
      seat.cards = deck.cards.slice(0, 200).map((card) => ({ name: String(card.name).slice(0, 120), quantity: Math.max(1, Math.min(99, Number(card.quantity) || 1)) }));
      seat.ready = false;
      break;
    }
    case "ready": {
      const seat = lobby.players.find((candidate) => candidate.userId === user.id);
      if (!seat?.deckId) throw new Error("Choose a deck before becoming ready.");
      seat.ready = Boolean(input.ready);
      break;
    }
    case "message": {
      if (!lobby.players.some((candidate) => candidate.userId === user.id)) throw new Error("You are not in this lobby.");
      const text = String(input.text || "").trim().slice(0, 500);
      if (text) lobby.messages.push({ id: `message-${randomUUID()}`, author: user.displayName, text, createdAt: Date.now() });
      lobby.messages = lobby.messages.slice(-100);
      break;
    }
    case "settings":
      if (lobby.hostId !== user.id) throw new Error("Only the host can change lobby settings.");
      for (const key of ["name", "privacy", "startingLife", "spectatorsAllowed", "description", "bracket"]) if (key in (input.patch || {})) lobby[key] = input.patch[key];
      break;
    case "kick":
      if (lobby.hostId !== user.id) throw new Error("Only the host can remove players.");
      lobby.players = lobby.players.filter((candidate) => candidate.id !== input.playerId || candidate.host);
      break;
    case "start":
      if (lobby.hostId !== user.id) throw new Error("Only the host can start the game.");
      if (lobby.players.length !== lobby.maxPlayers || lobby.players.some((candidate) => !candidate.ready)) throw new Error("Fill every seat and make sure every player is ready.");
      lobby.status = "in-game";
      lobby.gameSeed = randomBytes(4).readUInt32LE() || 1;
      data.games[lobby.id] = { sequence: 0, actions: [], activePlayerId: lobby.players[0].userId, phaseIndex: 0 };
      break;
    default: throw new Error("Unknown lobby action.");
  }
}

function staticFile(pathname, response) {
  if (!existsSync(publicDir)) return false;
  const relative = pathname === "/" ? "index.html" : normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  let file = join(publicDir, relative);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(publicDir, "index.html");
  if (!existsSync(file)) return false;
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
  response.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
  response.end(readFileSync(file));
  return true;
}

createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") return send(response, 204, {});
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/api/health") return send(response, 200, { status: "ok" });

    if (request.method === "POST" && url.pathname === "/api/register") {
      const input = await body(request); const email = String(input.email || "").trim().toLowerCase(); const username = String(input.username || "").trim().toLowerCase();
      if (!email || !username || String(input.password || "").length < 8 || !String(input.displayName || "").trim()) throw new Error("Complete every field; the password must contain at least 8 characters.");
      if (data.accounts.some((account) => account.user.email === email)) throw new Error("An account already uses this email.");
      if (data.accounts.some((account) => account.user.username === username)) throw new Error("This username is already taken.");
      const salt = randomBytes(16).toString("hex");
      const user = { id: `user-${randomUUID()}`, email, username, displayName: String(input.displayName).trim().slice(0, 40), avatar: String(input.displayName).trim().slice(0, 2).toUpperCase(), presence: "online", theme: "dark" };
      data.accounts.push({ user, salt, passwordHash: passwordHash(String(input.password), salt), createdAt: Date.now() });
      const token = randomBytes(32).toString("hex"); data.sessions[token] = user.id; save();
      return send(response, 201, { user, token });
    }

    if (request.method === "POST" && url.pathname === "/api/login") {
      const input = await body(request); const identity = String(input.identity || "").trim().toLowerCase();
      const account = data.accounts.find((candidate) => candidate.user.email === identity || candidate.user.username === identity);
      if (!account) throw new Error("Email/username or password is incorrect.");
      const actual = Buffer.from(passwordHash(String(input.password || ""), account.salt), "hex"); const expected = Buffer.from(account.passwordHash, "hex");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Email/username or password is incorrect.");
      const token = randomBytes(32).toString("hex"); data.sessions[token] = account.user.id; save();
      return send(response, 200, { user: account.user, token });
    }

    const user = sessionUser(request);
    if (url.pathname.startsWith("/api/") && !user) return send(response, 401, { error: "Please log in again." });

    if (request.method === "GET" && url.pathname === "/api/leaderboard") {
      const users = data.accounts.map((account) => account.user).sort((a, b) => (b.honor || 0) - (a.honor || 0)).slice(0, 20);
      return send(response, 200, users);
    }

    if (request.method === "POST" && url.pathname === "/api/profile") {
      const input = await body(request); const displayName = String(input.displayName || "").trim().slice(0, 40);
      if (!displayName) throw new Error("Display name is required.");
      Object.assign(user, {
        displayName, avatar: displayName.slice(0, 2).toUpperCase(),
        avatarImage: String(input.avatarImage || "").slice(0, 500_000) || undefined,
        accentColor: /^#[0-9a-f]{6}$/i.test(String(input.accentColor || "")) ? input.accentColor : "#62e6bb",
        bio: String(input.bio || "").trim().slice(0, 240), theme: input.theme === "light" ? "light" : "dark"
      });
      save(); return send(response, 200, { user });
    }

    if (request.method === "GET" && url.pathname === "/api/lobbies") return send(response, 200, data.lobbies.filter((lobby) => lobby.privacy === "public" && lobby.status === "waiting").map(safeLobby));
    if (request.method === "GET" && parts[0] === "api" && parts[1] === "lobbies" && parts[2] === "code") {
      const lobby = data.lobbies.find((candidate) => candidate.code === String(parts[3] || "").toUpperCase());
      return lobby ? send(response, 200, safeLobby(lobby)) : send(response, 404, { error: "Lobby code not found." });
    }
    if (request.method === "GET" && parts[0] === "api" && parts[1] === "lobbies" && parts.length === 3) {
      const lobby = data.lobbies.find((candidate) => candidate.id === parts[2]);
      return lobby ? send(response, 200, safeLobby(lobby)) : send(response, 404, { error: "Lobby no longer exists." });
    }
    if (request.method === "POST" && url.pathname === "/api/lobbies") {
      const input = await body(request);
      if (!String(input.name || "").trim()) throw new Error("Lobby name is required.");
      const lobby = { id: `lobby-${randomUUID()}`, code: randomBytes(4).toString("hex").slice(0, 6).toUpperCase(), name: String(input.name).trim().slice(0, 80), hostId: user.id,
        format: String(input.format || "Commander"), privacy: input.privacy === "public" ? "public" : "private", maxPlayers: Math.max(2, Math.min(4, Number(input.maxPlayers) || 4)),
        spectatorsAllowed: Boolean(input.spectatorsAllowed), startingLife: Math.max(1, Number(input.startingLife) || 40), password: String(input.password || "").slice(0, 80),
        description: String(input.description || "").trim().slice(0, 300), bracket: Math.max(1, Math.min(5, Number(input.bracket) || 3)), tags: [input.format === "Commander" ? "Commander" : "Constructed", `Bracket ${Math.max(1, Math.min(5, Number(input.bracket) || 3))}`, input.privacy === "private" ? "Invite only" : "Open"],
        status: "waiting", players: [player(user, true)], messages: [{ id: `message-${randomUUID()}`, author: "NovaTable", text: "Lobby created. Choose a deck and ready up.", createdAt: Date.now() }], createdAt: Date.now() };
      data.lobbies.push(lobby); save(); return send(response, 201, safeLobby(lobby));
    }
    if (request.method === "POST" && parts[0] === "api" && parts[1] === "lobbies" && parts[3] === "actions") {
      const lobby = data.lobbies.find((candidate) => candidate.id === parts[2]);
      if (!lobby) return send(response, 404, { error: "Lobby no longer exists." });
      lobbyAction(lobby, user, await body(request)); save(); return send(response, 200, safeLobby(lobby));
    }
    if (request.method === "POST" && parts[0] === "api" && parts[1] === "games" && parts[3] === "honor") {
      const lobby = data.lobbies.find((candidate) => candidate.id === parts[2]);
      if (!lobby?.players.some((candidate) => candidate.userId === user.id)) return send(response, 403, { error: "You are not in this game." });
      const input = await body(request); const targetUserId = String(input.targetUserId || "");
      if (!targetUserId || targetUserId === user.id || !lobby.players.some((candidate) => candidate.userId === targetUserId)) throw new Error("Choose another player from this game.");
      const target = data.accounts.find((account) => account.user.id === targetUserId); if (!target) throw new Error("Development players cannot receive Honor.");
      const game = data.games[parts[2]] ||= { sequence: 0, actions: [] }; game.honorVotes ||= {};
      if (game.honorVotes[user.id]) throw new Error("You already awarded Honor for this game.");
      game.honorVotes[user.id] = targetUserId; target.user.honor = (target.user.honor || 0) + 1; save();
      return send(response, 201, { honor: target.user.honor });
    }
    if (parts[0] === "api" && parts[1] === "games" && parts[3] === "actions") {
      const lobby = data.lobbies.find((candidate) => candidate.id === parts[2]);
      if (!lobby?.players.some((candidate) => candidate.userId === user.id)) return send(response, 403, { error: "You are not in this game." });
      const game = data.games[parts[2]] ||= { sequence: 0, actions: [] };
      if (request.method === "GET") return send(response, 200, game.actions.filter((event) => event.sequence > Number(url.searchParams.get("after") || 0)));
      if (request.method === "POST") {
        const input = await body(request); if (!input.action?.type) throw new Error("Invalid game action.");
        const selfOnly = new Set(["DRAW_CARD", "MOVE_ZONE_CARDS", "UNTAP_ALL", "CHANGE_LIFE", "CHANGE_POISON", "CHANGE_COMMANDER_TAX", "CHANGE_COMMANDER_DAMAGE", "CHANGE_MANA", "CREATE_TOKEN", "ROLL_DIE", "FLIP_COIN", "CHAT_MESSAGE", "SHUFFLE_LIBRARY", "MILL", "MULLIGAN"]);
        if (selfOnly.has(input.action.type) && input.action.playerId !== user.id) return send(response, 403, { error: "You may only change your own player state." });
        const turnActions = new Set(["SET_PHASE", "NEXT_PHASE", "NEXT_TURN"]);
        game.activePlayerId ||= lobby.players[0].userId; game.phaseIndex ||= 0;
        if (turnActions.has(input.action.type) && game.activePlayerId !== user.id) return send(response, 403, { error: "Only the active player can advance the turn." });
        const phases = ["untap", "upkeep", "draw", "main-1", "begin-combat", "attackers", "blockers", "combat-damage", "end-combat", "main-2", "end"];
        if (input.action.type === "SET_PHASE") game.phaseIndex = Math.max(0, phases.indexOf(input.action.phase));
        if (input.action.type === "NEXT_PHASE" && ++game.phaseIndex >= phases.length) {
          game.phaseIndex = 0;
          const activeIndex = lobby.players.findIndex((candidate) => candidate.userId === game.activePlayerId);
          game.activePlayerId = lobby.players[(activeIndex + 1) % lobby.players.length].userId;
        }
        if (input.action.type === "NEXT_TURN") {
          game.phaseIndex = 0;
          const activeIndex = lobby.players.findIndex((candidate) => candidate.userId === game.activePlayerId);
          game.activePlayerId = lobby.players[(activeIndex + 1) % lobby.players.length].userId;
        }
        const event = { sequence: ++game.sequence, action: input.action }; game.actions.push(event); game.actions = game.actions.slice(-5000); save();
        return send(response, 201, { sequence: event.sequence });
      }
    }
    if (!url.pathname.startsWith("/api/") && staticFile(url.pathname, response)) return;
    send(response, 404, { error: "Not found." });
  } catch (error) {
    send(response, 400, { error: error instanceof Error ? error.message : "Request failed." });
  }
}).listen(port, process.env.HOST || "127.0.0.1", () => console.log(`NovaTable listening on ${port}`));
