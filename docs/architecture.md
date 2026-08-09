# Architecture

## Boundaries

```text
React presentation
      |
platform API + application commands
      |
deterministic game domain  <----> replay/event log
      |
transport port
  |                    |
local MVP store   native authoritative backend
```

The UI deals only in accounts, friends, lobbies, decks and structured game
actions. The current local platform module implements that contract with
localStorage; a real backend can replace it without exposing transport choices
to players.

## Frontend

- `src/domain`: framework-free state, actions, events, selectors, tests
- `src/features`: product-level experiences such as table, decks, and lobby
- `src/components`: reusable interface primitives
- `src/app`: routing, providers, top-level composition

The Commander table uses a pure reducer with actions such as `DRAW_CARD`,
`MOVE_CARD`, `TAP_CARD`, `CHANGE_LIFE`, `CREATE_TOKEN`, `SHUFFLE_LIBRARY`,
`NEXT_PHASE` and `NEXT_TURN`. Multiplayer messages and replay frames will use
the same event boundary.

## Native shell

Tauri owns:

- native authoritative networking and reconnect policy
- SQLite persistence and migrations
- secure credential storage
- file system import/export
- automatic updates and desktop integration

Only narrow typed commands and event streams cross the Tauri boundary.

## Testing strategy

- domain: reducer and protocol translation unit tests
- UI: interaction tests against accessible labels and visible behavior
- protocol: event serialization and server validation fixtures
- end-to-end: account → lobby → four-player Commander flow
- visual: stable screenshots for key table sizes and accessibility themes

## Decision records to add

- ADR-001: GPL-2.0-only licensing and attribution
- ADR-002: Tauri 2 rather than Electron or a Qt rewrite
- ADR-003: native multiplayer event protocol
- ADR-004: authoritative event stream and optimistic interactions
