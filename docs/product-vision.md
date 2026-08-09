# Product vision

## Working idea

NovaTable should feel like a contemporary multiplayer workspace built for a
card table, not like a desktop database tool with a board attached.

The design principles are:

1. **The table is the product.** Joining a game should take seconds and the
   battlefield should remain visually dominant.
2. **Intent is visible.** Priority, phase, selections, targets, and recent
   actions should be understandable without reading a chat log.
3. **Fast for experts, safe for newcomers.** Every core action gets a direct
   manipulation gesture, a discoverable menu action, and a shortcut.
4. **No hidden game engine.** Like Cockatrice, NovaTable is a virtual tabletop,
   not an automated rules judge. Players retain control, while the client
   makes common actions fluid and reversible.
5. **One identity, no server UX.** Accounts, friends and lobbies belong to
   NovaTable; transport and room infrastructure stay invisible.
6. **Accessible by default.** Keyboard control, scalable UI, contrast themes,
   reduced motion, and non-color status cues are core requirements.

## Product surfaces

- Home: recent decks, friends, active rooms, and one-click resume
- Deck studio: fast search, visual curve and probability tools, import/export
- Lobby: human-readable room cards, robust filters, party presence
- Table: spatial play, clear phases/priority, action timeline, reversible input
- Replay studio: seekable event timeline, annotations, shareable moments
- Settings: profile, appearance, shortcuts, storage, accessibility

## First milestone

The first milestone is a complete four-player Commander flow backed by
structured actions. It supports:

- zones and card movement
- tap/untap, counters, life, draw, and phase/priority control
- persistent local account/session and a modern home
- private/public lobby creation, codes, friends and development players
- Commander deck import, selection, Ready and Start
- four players, 40 life, commanders, public/hidden zones and an action log

The current vertical slice implements this flow locally. Real multiplayer is
the next transport step; it must preserve the same UI and action model.
