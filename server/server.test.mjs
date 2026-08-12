import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 14747;
const data = mkdtempSync(join(tmpdir(), "novatable-server-test-"));
const process = spawn(globalThis.process.execPath, ["server/server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: { ...globalThis.process.env, PORT: String(port), NOVATABLE_DATA: data },
  stdio: "ignore"
});
const base = `http://127.0.0.1:${port}/api`;
const base32Decode = (value) => { const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; const bits = value.split("").map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0")).join(""); return Buffer.from((bits.match(/.{8}/g) || []).map((byte) => parseInt(byte, 2))); };
const totp = (secret) => { const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000))); const hash = createHmac("sha1", base32Decode(secret)).update(counter).digest(); const offset = hash[19] & 15; return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0"); };

async function request(path, token, input) {
  const response = await fetch(`${base}${path}`, {
    method: input ? "POST" : "GET",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(input ? { "Content-Type": "application/json" } : {}) },
    body: input ? JSON.stringify(input) : undefined
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

try {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await request("/health"); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  const users = [];
  const usernames = ["lele", "ale_", "jackomo", "player3"];
  for (let index = 0; index < 4; index++) users.push(await request("/register", "", { email: `player${index}@example.com`, username: usernames[index], password: "playtest123", displayName: `Player ${index}` }));
  assert.equal(users[0].user.badge, "OWNER"); assert.equal(users[1].user.badge, "PIONEER"); assert.equal(users[2].user.badge, "PIONEER");
  const lobby = await request("/lobbies", users[0].token, { name: "Commander Night", format: "Commander", bracket: 3, privacy: "private", maxPlayers: 4, startingLife: 40, spectatorsAllowed: true, password: "pod", description: "test" });
  assert.equal(lobby.bracket, 3);
  for (let index = 1; index < 4; index++) await request(`/lobbies/${lobby.id}/actions`, users[index].token, { action: "join", password: "pod" });
  const deck = { id: "deck", name: "Test", commander: "Atraxa, Praetors' Voice", cards: [{ name: "Sol Ring", quantity: 1 }, { name: "Wastes", quantity: 98 }] };
  for (let index = 0; index < 4; index++) {
    await request(`/lobbies/${lobby.id}/actions`, users[index].token, { action: "deck", deck });
    await request(`/lobbies/${lobby.id}/actions`, users[index].token, { action: "ready", ready: true });
  }
  const started = await request(`/lobbies/${lobby.id}/actions`, users[0].token, { action: "start" });
  assert.equal(started.status, "in-game");
  assert.ok(started.gameSeed);
  await request(`/games/${lobby.id}/actions`, users[0].token, { action: { type: "DRAW_CARD", playerId: users[0].user.id } });
  await request(`/games/${lobby.id}/actions`, users[0].token, { action: { type: "CHANGE_MANA", playerId: users[0].user.id, color: "U", delta: 1 } });
  await assert.rejects(request(`/games/${lobby.id}/actions`, users[1].token, { action: { type: "CHANGE_MANA", playerId: users[0].user.id, color: "U", delta: 1 } }), /own player state/);
  await request(`/games/${lobby.id}/actions`, users[1].token, { action: { type: "TAP_CARD", cardId: `${users[0].user.id}-card-0` } });
  const events = await request(`/games/${lobby.id}/actions?after=0`, users[1].token);
  assert.deepEqual(events.map((event) => event.action.type), ["DRAW_CARD", "CHANGE_MANA", "TAP_CARD"]);
  for (let index = 0; index < 10; index++) await request(`/games/${lobby.id}/actions`, users[2].token, { action: { type: "NEXT_PHASE" } });
  await assert.rejects(request(`/games/${lobby.id}/actions`, users[0].token, { action: { type: "NEXT_PHASE" } }), /Only the next player/);
  await assert.rejects(request(`/games/${lobby.id}/actions`, users[2].token, { action: { type: "NEXT_PHASE" } }), /Only the next player/);
  await request(`/games/${lobby.id}/actions`, users[1].token, { action: { type: "NEXT_PHASE" } });
  const turnEvents = await request(`/games/${lobby.id}/actions?after=3`, users[0].token);
  assert.equal(turnEvents.length, 11);
  const honor = await request(`/games/${lobby.id}/honor`, users[1].token, { targetUserId: users[0].user.id });
  assert.equal(honor.honor, 1);
  await assert.rejects(request(`/games/${lobby.id}/honor`, users[1].token, { targetUserId: users[0].user.id }), /already awarded/);
  const completed = await request(`/games/${lobby.id}/complete`, users[0].token, { winnerUserId: users[1].user.id });
  assert.equal(completed.user.gamesPlayed, 1); assert.equal(completed.user.xp, 100);
  const winner = await request(`/users/${users[1].user.username}`, users[0].token);
  assert.equal(winner.gamesPlayed, 1); assert.equal(winner.gamesWon, 1); assert.equal(winner.xp, 350); assert.equal(winner.level, 2); assert.equal(winner.email, undefined);
  await request("/register", "", { email: "fake@test.invalid", username: "fake", password: "playtest123", displayName: "Fake" });
  const leaderboard = await request("/leaderboard", users[0].token);
  assert.equal(leaderboard[0].id, users[0].user.id);
  assert.ok(!leaderboard.some((entry) => entry.username === "fake")); assert.ok(leaderboard.every((entry) => entry.email === undefined));
  const setup = await request("/account/2fa/setup", users[0].token, { password: "playtest123" }); const code = totp(setup.secret);
  await request("/account/2fa/enable", users[0].token, { password: "playtest123", secret: setup.secret, code });
  assert.equal((await request("/login", "", { identity: "lele", password: "playtest123" })).twoFactorRequired, true);
  const securedLogin = await request("/login", "", { identity: "lele", password: "playtest123", code: totp(setup.secret) }); assert.ok(securedLogin.token);
  await request("/account/email", securedLogin.token, { email: "lele-new@example.com", password: "playtest123" });
  await request("/account/password", securedLogin.token, { currentPassword: "playtest123", newPassword: "new-playtest123" });
  assert.ok((await request("/login", "", { identity: "lele-new@example.com", password: "new-playtest123", code: totp(setup.secret) })).token);
  users[0].token = securedLogin.token;
  const devLobby = await request("/lobbies", users[0].token, { name: "Dev Commander Night", format: "Commander", bracket: 3, privacy: "private", maxPlayers: 4, startingLife: 40, spectatorsAllowed: true, password: "", description: "dev turn test" });
  for (let index = 0; index < 3; index++) await request(`/lobbies/${devLobby.id}/actions`, users[0].token, { action: "add-bot" });
  await request(`/lobbies/${devLobby.id}/actions`, users[0].token, { action: "deck", deck });
  await request(`/lobbies/${devLobby.id}/actions`, users[0].token, { action: "ready", ready: true });
  await request(`/lobbies/${devLobby.id}/actions`, users[0].token, { action: "start" });
  for (let index = 0; index < 22; index++) await request(`/games/${devLobby.id}/actions`, users[0].token, { action: { type: "NEXT_PHASE" } });
  const devTurnEvents = await request(`/games/${devLobby.id}/actions?after=0`, users[0].token);
  assert.equal(devTurnEvents.length, 22);
  console.log("NovaTable server multiplayer flow passed");
} finally {
  process.kill();
  rmSync(data, { recursive: true, force: true });
}
