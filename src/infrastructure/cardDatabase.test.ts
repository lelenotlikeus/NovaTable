import { beforeEach, describe, expect, it } from "vitest";
import { cardRecordFromScryfall, getCardByName, searchCardDatabase, setPreferredCardPrinting, type CardPrinting } from "./cardDatabase";

const printing: CardPrinting = {
  name: "Sol Ring", nameLower: "sol ring", manaCost: "{1}", typeLine: "Artifact",
  oracleText: "Add {C}{C}.", power: null, toughness: null,
  imageUrl: "https://cards.example/sol-ring.jpg", printingId: "printing-1",
  setCode: "CMM", setName: "Commander Masters", collectorNumber: "396",
  releasedAt: "2023-08-04", artist: "Mike Bierek"
};

describe("card artwork preferences", () => {
  beforeEach(() => localStorage.clear());

  it("uses and clears the selected printing globally by card name", async () => {
    setPreferredCardPrinting("Sol Ring", printing);
    expect(await getCardByName("sol ring")).toMatchObject({ printingId: "printing-1", setCode: "CMM" });
    setPreferredCardPrinting("Sol Ring", null);
    expect(await getCardByName("Sol Ring")).toBeNull();
  });

  it("selects the requested face artwork for double-faced tokens", () => {
    const treasure = cardRecordFromScryfall({
      name: "Dinosaur // Treasure",
      card_faces: [
        { name: "Dinosaur", type_line: "Token Creature — Dinosaur", image_uris: { normal: "dinosaur.jpg" } },
        { name: "Treasure", type_line: "Token Artifact — Treasure", image_uris: { normal: "treasure.jpg" } }
      ]
    }, "Treasure");
    expect(treasure).toMatchObject({ name: "Treasure", nameLower: "treasure", imageUrl: "treasure.jpg", typeLine: "Token Artifact — Treasure", otherFaceName: "Dinosaur", otherFaceImageUrl: "dinosaur.jpg" });
  });

  it("prefers large Scryfall artwork", () => {
    const card = cardRecordFromScryfall({ name: "Sol Ring", image_uris: { normal: "normal.jpg", large: "large.jpg" } });
    expect(card.imageUrl).toBe("large.jpg");
  });

  it("does not search an uninstalled local catalog", async () => {
    expect(await searchCardDatabase("sol")).toEqual([]);
  });
});
