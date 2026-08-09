import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { currentUser, decksFor, resetLocalPlatformForTests } from "../infrastructure/localPlatform";
import { App } from "./App";

describe("NovaTable vertical slice", () => {
  beforeEach(() => resetLocalPlatformForTests());

  it("goes from account creation to a playable four-player Commander board", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "mage@example.test" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "tablemage" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Table Mage" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText("Bring the pod together.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /create lobby/i }));
    fireEvent.click(screen.getByRole("button", { name: /create lobby/i }));

    expect(await screen.findByRole("heading", { name: "Commander Night" })).toBeInTheDocument();
    for (let index = 0; index < 3; index++) {
      fireEvent.click(screen.getAllByRole("button", { name: /add dev player/i })[0]);
    }
    fireEvent.change(screen.getByLabelText("Your deck"), {
      target: { value: screen.getByLabelText<HTMLSelectElement>("Your deck").options[1].value }
    });
    fireEvent.click(screen.getByRole("button", { name: "Set Ready" }));
    const start = screen.getByRole("button", { name: /start game/i });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);

    expect(await screen.findByText("Commander · 4 players")).toBeInTheDocument();
    expect(screen.getAllByText("40")).toHaveLength(4);
    expect(document.querySelector(".local-hand > span")).toHaveTextContent("Your hand 0");
    fireEvent.click(screen.getByRole("button", { name: "Draw 7" }));
    expect(document.querySelector(".local-hand > span")).toHaveTextContent("Your hand 7");
    fireEvent.click(screen.getByRole("button", { name: "Draw" }));
    expect(document.querySelector(".local-hand > span")).toHaveTextContent("Your hand 8");
  });

  it("persists profile identity and interface personalization", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "profile@example.test" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "profilemage" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Profile Mage" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    expect(await screen.findByText("Bring the pod together.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /profile & settings/i }));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Nova Planeswalker" } });
    fireEvent.change(screen.getByLabelText("Bio"), { target: { value: "Commander player" } });
    fireEvent.change(screen.getByLabelText("Interface accent"), { target: { value: "#ff7755" } });
    fireEvent.click(screen.getByRole("button", { name: /save profile/i }));

    expect(await screen.findByText("Profile saved")).toBeInTheDocument();
    expect(currentUser()).toMatchObject({ displayName: "Nova Planeswalker", bio: "Commander player", accentColor: "#ff7755" });
  });

  it("opens a saved deck and persists card-level edits", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "deck@example.test" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "deckmage" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Deck Mage" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    expect(await screen.findByText("Bring the pod together.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Decks" }));
    fireEvent.click(screen.getByText("Arcane Coalition").closest(".deck-card")!);
    expect(screen.getByText("Deck cards")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Deck name"), { target: { value: "Edited Coalition" } });
    fireEvent.change(screen.getByLabelText("Cards to add"), { target: { value: "2 Lightning Bolt" } });
    fireEvent.click(screen.getByRole("button", { name: /add list to deck/i }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const user = currentUser()!;
    expect(decksFor(user.id)[0]).toMatchObject({ name: "Edited Coalition" });
    expect(decksFor(user.id)[0].cards).toContainEqual({ name: "Lightning Bolt", quantity: 2 });
  });
});
