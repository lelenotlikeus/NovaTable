import { beforeEach, describe, expect, it } from "vitest";
import { currentUser, decksFor, deleteDeck, publicLobbies, registerAccount, resetLocalPlatformForTests, saveDeck, searchUsers, updateDeck, updateProfile } from "./localPlatform";

describe("local deck persistence", () => {
  beforeEach(() => resetLocalPlatformForTests());

  it("updates, merges and deletes an owned deck", async () => {
    const user = await registerAccount({ email: "owner@example.test", username: "owner", password: "password123", displayName: "Owner" });
    expect(decksFor(user.id)).toEqual([]);
    const deck = saveDeck({ ownerId: user.id, name: "Test", commander: "Atraxa, Praetors' Voice", list: "1 Sol Ring" });
    const updated = updateDeck(deck.id, user.id, { name: "Updated", commander: deck.commander, cards: [{ name: "Sol Ring", quantity: 1 }, { name: "sol ring", quantity: 2 }] });
    expect(updated.cards).toEqual([{ name: "Sol Ring", quantity: 3 }]);
    deleteDeck(deck.id, user.id);
    expect(decksFor(user.id)).toEqual([]);
  });

  it("persists the account interface theme", async () => {
    const user = await registerAccount({ email: "theme@example.test", username: "theme", password: "password123", displayName: "Theme" });
    const updated = updateProfile(user.id, { displayName: user.displayName, accentColor: "#62e6bb", bio: "", theme: "light" });
    expect(updated.theme).toBe("light");
    expect(currentUser()?.theme).toBe("light");
  });

  it("removes legacy mock users and lobbies", () => {
    localStorage.setItem("novatable.platform.v1", JSON.stringify({
      accounts: [], decks: [],
      directory: [{ id: "demo-mira", username: "mira", displayName: "Mira", email: "", avatar: "MI", presence: "online" }],
      friendships: [{ id: "friend", fromId: "demo-mira", toId: "user", status: "pending" }],
      lobbies: [{ id: "public-commander", hostId: "demo-mira" }], invites: []
    }));
    expect(publicLobbies()).toEqual([]);
    expect(searchUsers("mira", "user")).toEqual([]);
  });
});
