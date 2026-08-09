import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  for (let index = 0; index < 4; index++) users.push(await request("/register", "", { email: `player${index}@test.invalid`, username: `player${index}`, password: "playtest123", displayName: `Player ${index}` }));
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
  await assert.rejects(request(`/games/${lobby.id}/actions`, users[1].token, { action: { type: "NEXT_PHASE" } }), /Only the active player/);
  await request(`/games/${lobby.id}/actions`, users[1].token, { action: { type: "TAP_CARD", cardId: `${users[0].user.id}-card-0` } });
  const events = await request(`/games/${lobby.id}/actions?after=0`, users[1].token);
  assert.deepEqual(events.map((event) => event.action.type), ["DRAW_CARD", "TAP_CARD"]);
  const honor = await request(`/games/${lobby.id}/honor`, users[1].token, { targetUserId: users[0].user.id });
  assert.equal(honor.honor, 1);
  await assert.rejects(request(`/games/${lobby.id}/honor`, users[1].token, { targetUserId: users[0].user.id }), /already awarded/);
  const leaderboard = await request("/leaderboard", users[0].token);
  assert.equal(leaderboard[0].id, users[0].user.id);
  console.log("NovaTable server multiplayer flow passed");
} finally {
  process.kill();
  rmSync(data, { recursive: true, force: true });
}
