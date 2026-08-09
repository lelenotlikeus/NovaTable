# Cockatrice compatibility map

Reference snapshot:

- repository: `Cockatrice/cockatrice`
- commit: `6766b0af89cec6c2bfbad1b344ee148f5e782d8a`
- source license: GPL-2.0

The local reference checkout is kept at
`C:\Users\ggisk\Progetti\cockatrice-reference` and is not part of this
repository.

## What the reference establishes

Cockatrice separates the Qt client, Servatrice server, Oracle card database
tool, shared libraries, and a Proto2 protocol library. The wire model has:

- `CommandContainer` envelopes keyed by `cmd_id`
- session, room, game, moderator, and admin command groups
- immediate `Response` envelopes correlated through `cmd_id`
- asynchronous session, room, and game events
- game contexts for command attribution
- server-authoritative zone/card state

## Compatibility phases

### Phase 1 — fixtures and framing

- [x] add a minimal attributed Proto2 wire schema for identification and
  session commands
- [x] generate Rust types in `build.rs` with a vendored `protoc`
- [x] implement the big-endian, length-prefixed TCP framing used by the
  reference client
- [x] handle fragmented/coalesced frames and the legacy v14 XML preamble
- [x] add encode/decode, framing, and local end-to-end server fixtures
- [x] correlate responses with monotonic `cmd_id` values
- [x] add WebSocket/WSS on `/servatrice`, with operating-system certificate
  roots for WSS
- [x] provide automatic Cockatrice-compatible port selection plus explicit
  TCP/WS/WSS overrides

### Phase 2 — account and lobby

- [x] server identification and protocol-version compatibility probe
- [x] persistent transport session, explicit disconnect, ping keepalive, and
  inactivity timeout
- [x] capture server password-hash capability during identification
- [x] guest and account login, password-salt exchange, SHA-512 compatibility,
  response-code translation, and plaintext transport policy
- [x] account registration, email-token activation, and automatic login for
  both immediately active and newly activated accounts
- [x] typed room-list request/event decoding and initial live lobby
- [x] join/leave room context, initial users, and game-list snapshot
- [x] live room presence, game-list refresh events, and room chat
- [ ] reconnect policy
- game listing and create/join flows

### Phase 3 — table

- translate `GameEventContainer` into NovaTable domain events
- implement zone dumps and reconciliation
- movement, tap/flip, counters, tokens, arrows, phases, draw, mulligan
- spectators, judge actions, sideboarding, concession

### Phase 4 — ecosystem

- remote deck storage
- replays and replay codes
- moderation affordances
- card-art rules and server-specific capabilities

## Compatibility rule

Generated protocol types stop at the native adapter. React components and the
domain reducer depend only on NovaTable types. Unknown extension fields and
new server features must degrade gracefully and be recorded for diagnostics.
