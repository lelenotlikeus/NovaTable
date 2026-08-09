import { beforeEach, describe, expect, it } from "vitest";
import { currentUser, decksFor, deleteDeck, registerAccount, resetLocalPlatformForTests, updateDeck, updateProfile } from "./localPlatform";

describe("local deck persistence", () => {
  beforeEach(() => resetLocalPlatformForTests());

  it("updates, merges and deletes an owned deck", async () => {
    const user = await registerAccount({ email: "owner@example.test", username: "owner", password: "password123", displayName: "Owner" });
    const deck = decksFor(user.id)[0];
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
});
