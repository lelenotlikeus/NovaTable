import type { CommanderGameAction } from "../domain/commander/types";
import type { Deck, Lobby, LobbyFormat, UserProfile } from "../domain/platform/types";
import * as local from "./localPlatform";
import { remoteApi, remoteApiEnabled } from "./remoteApi";

const post = <T>(path: string, body: object) => remoteApi<T>(path, { method: "POST", body: JSON.stringify(body) });

export async function onlinePublicLobbies() {
  return remoteApiEnabled ? remoteApi<Lobby[]>("/lobbies") : local.publicLobbies();
}

export async function onlineLobby(lobbyId: string) {
  return remoteApiEnabled ? remoteApi<Lobby>(`/lobbies/${lobbyId}`) : local.findLobbyById(lobbyId);
}

export async function onlineFindLobby(code: string): Promise<Lobby> {
  const lobby = remoteApiEnabled ? await remoteApi<Lobby>(`/lobbies/code/${encodeURIComponent(code.trim().toUpperCase())}`) : local.findLobby(code);
  if (!lobby) throw new Error("Lobby code not found.");
  return lobby;
}

export async function onlineCreateLobby(user: UserProfile, input: {
  name: string; format: LobbyFormat; privacy: "public" | "private"; maxPlayers: number;
  spectatorsAllowed: boolean; startingLife: number; password: string; description: string; bracket: 1 | 2 | 3 | 4 | 5;
}) {
  return remoteApiEnabled ? post<Lobby>("/lobbies", input) : local.createLobby(user, input);
}

export async function onlineJoinLobby(lobbyId: string, user: UserProfile, password = "") {
  return remoteApiEnabled ? post<Lobby>(`/lobbies/${lobbyId}/actions`, { action: "join", password }) : local.joinLobby(lobbyId, user, password);
}

export async function onlineLobbyAction(lobbyId: string, action: string, data: object = {}) {
  if (remoteApiEnabled) return post<Lobby>(`/lobbies/${lobbyId}/actions`, { action, ...data });
  switch (action) {
    case "add-bot": return local.addDevelopmentPlayer(lobbyId);
    case "deck": return local.setLobbyDeck(lobbyId, String((data as { userId: string }).userId), (data as { deck: Deck }).deck);
    case "ready": return local.setReady(lobbyId, String((data as { userId: string }).userId), Boolean((data as { ready: boolean }).ready));
    case "message": return local.postLobbyMessage(lobbyId, String((data as { author: string }).author), String((data as { text: string }).text));
    case "settings": return local.updateLobbySettings(lobbyId, String((data as { hostId: string }).hostId), (data as { patch: Parameters<typeof local.updateLobbySettings>[2] }).patch);
    case "kick": return local.kickLobbyPlayer(lobbyId, String((data as { hostId: string }).hostId), String((data as { playerId: string }).playerId));
    case "start": return local.startLobby(lobbyId, String((data as { hostId: string }).hostId));
    default: throw new Error("Unknown lobby action.");
  }
}

export async function onlineLeaveLobby(lobbyId: string, userId: string) {
  if (remoteApiEnabled) await post(`/lobbies/${lobbyId}/actions`, { action: "leave" });
  else local.leaveLobby(lobbyId, userId);
}

export async function sendGameAction(gameId: string, action: CommanderGameAction, clientActionId?: string) {
  return post<{ sequence: number }>(`/games/${gameId}/actions`, { action, clientActionId });
}

export async function gameActions(gameId: string, after: number) {
  return remoteApi<Array<{ sequence: number; action: CommanderGameAction; clientActionId?: string }>>(`/games/${gameId}/actions?after=${after}`);
}

export async function submitHonor(gameId: string, targetUserId: string) {
  return remoteApiEnabled ? post<{ honor: number }>(`/games/${gameId}/honor`, { targetUserId }) : { honor: 0 };
}

export async function honorLeaderboard() {
  return remoteApiEnabled ? remoteApi<UserProfile[]>("/leaderboard") : [];
}

export { remoteApiEnabled };
