# Final Cockatrice functional audit

NovaTable uses Cockatrice only as a checklist for a permissive tabletop. The
server-selection UX, per-server identities and desktop-era layout are removed.

## Ready for Commander beta

- Four visible player boards, hand, library, battlefield, graveyard, exile,
  command zone and a collapsible stack.
- Manual draw (games begin with zero cards in hand), draw X, mulligan, mill,
  shuffle, scry/library view and drag between public/private zones.
- Free normalized battlefield positioning, 90° tap/untap, face-down cards,
  counters, named counters, temporary P/T, annotations, attachments and clones.
- Tokens (including common Oracle-text shortcuts), card printing selection,
  hover preview and original Magic card back for hidden cards.
- Life, poison, commander tax/damage, phases, turns, dice, coin flips, chat,
  targeting arrows and per-arrow removal.
- Global account authentication, passworded public/private lobbies, Ready/Start,
  correct per-player deck transfer and ordered cross-client action sync.

## Deliberately after the first beta

- Spectator sessions, reconnect/replay and game history.
- Sideboards and between-game best-of-three handling (not required for the
  Commander vertical slice).
- Multi-card selection, undo-draw, reveal-random-card and partial-library
  shuffles; all equivalent game states remain achievable with existing manual
  zone tools.
- Server-backed friends/invites and cross-device deck storage. Lobby codes are
  the supported beta invitation path; decks remain on the player's device.
- Matchmaking, ranking, rules enforcement and automatic priority are outside
  the tabletop-simulator scope.
