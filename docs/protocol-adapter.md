# Cockatrice protocol adapter

## Implemented

The Rust backend can open raw TCP, WebSocket, or secure WebSocket connections
to a Servatrice-compatible endpoint, decode `ServerMessage` values, and return
`Event_ServerIdentification` to the UI. Raw TCP sends the legacy empty
`CommandContainer`; WebSockets use binary messages on `/servatrice`.

The implementation lives in:

- `src-tauri/proto/cockatrice_wire.proto`
- `src-tauri/src/cockatrice/framing.rs`
- `src-tauri/src/cockatrice/connection.rs`
- `src-tauri/src/cockatrice/commands.rs`
- `src-tauri/src/cockatrice/password.rs`

The Tauri commands exposed to the frontend are:

- `probe_cockatrice`
- `cockatrice_connection_status`
- `connect_cockatrice`
- `disconnect_cockatrice`
- `login_cockatrice`
- `register_cockatrice_account`
- `activate_cockatrice_account`
- `list_cockatrice_rooms`
- `join_cockatrice_room`
- `leave_cockatrice_room`
- `cockatrice_live_room`
- `send_cockatrice_room_message`
- `cockatrice_protocol_self_test`

No credentials are requested or sent by the server probe. Once a persistent
session is open, login accepts either a guest name or an account name and
password. Passwords stay in memory only for the active request and are never
persisted by NovaTable.

The connection command keeps the negotiated transport alive, sends protocol
ping commands every 15 seconds, correlates their responses, and closes the
session after 45 seconds without incoming traffic. Disconnect is explicit and
graceful for both TCP and WebSocket transports.

The self-test starts a one-shot Servatrice-compatible fixture on a random
loopback port, performs framing, identification, password-salt negotiation and
a registered hashed login, then closes it. It does not require an installed
Servatrice server or internet access.

## Public server verification

NovaTable defaults to the Cockatrice public server **Rooster Ranges** using
`wss://server.cockatrice.us:443/servatrice`. On 2026-07-31 the complete Rust
adapter was verified against that endpoint: certificate validation,
WebSocket upgrade, protocol-v14 identification, server name, and password-hash
capability all succeeded. Port 4748 is Cockatrice's reference default but was
not reachable from the development network; WSS 443 was reachable and avoids
that firewall restriction.

Rooster Ranges returns response 22 for guest login, meaning registration is
required. The startup UI therefore disables Guest for this preset and offers
Login, Create account, or Activate. Custom servers retain guest mode.

## Authentication

Account login follows the reference client exactly:

1. request `Command_RequestPasswordSalt` for the user name
2. hash the UTF-8 bytes of `salt + password` with SHA-512
3. hash the resulting digest 999 more times
4. send `salt + Base64(final digest)` in `hashed_password`

The implementation is pinned by Cockatrice's own regression vector. An empty
salt means the name is unknown but guest access is allowed, so NovaTable
retries without any password field. Servers without password-hash support may
receive a legacy plaintext password only over certificate-validated WSS;
account login over TCP or WS is rejected before a login command is sent.

Account registration uses `Command_Register`. NovaTable generates a fresh
16-character salt and sends the same iterated hash format when supported.
Legacy plaintext registration is blocked outside WSS. Responses distinguish
immediately active accounts from accounts requiring email activation.

Email activation uses `Command_Activate` at session-command tag 1017 with the
user name, emailed token, and client ID. Response 31 completes activation;
response 32 is reported as an invalid or expired code. After a successful
activation, the UI automatically performs the normal password-hash login.
Activate remains a first-class startup choice so the code can also be entered
after restarting NovaTable.

## Wire rules verified against the reference

- Raw TCP messages use a four-byte unsigned big-endian payload length.
- The current Cockatrice/Servatrice protocol version is 14.
- A raw TCP client begins identification with an empty framed
  `CommandContainer`.
- Server traffic is wrapped in `ServerMessage`.
- Responses correlate to commands through `Response.cmd_id`.
- Automatic transport follows Cockatrice: port 443 uses WSS; ports 80, 4748,
  and 8080 use WS; other ports use raw TCP.
- Explicit TCP, WS, and WSS selection can override the automatic convention.
- WSS validates certificates against the operating-system trust store.
- Old v14 servers may emit a 60-byte XML preamble before the first frame.

## Proto2 extensions

Cockatrice uses Proto2 extensions to model command and event variants.
Protobuf extension fields use the same tag/value wire encoding as ordinary
fields. NovaTable therefore defines a small boundary schema with ordinary
fields at the original extension numbers—for example server identification at
tag 500 and login at tag 1001.

This gives us:

- deterministic generated Rust types
- no dependency on extension-aware objects in the React/domain layers
- forward compatibility, because unknown fields are ignored
- incremental schema growth rather than importing the entire historical model

Every mapped field number must be verified against the pinned Cockatrice
reference before it is added.

## Test coverage

Rust tests cover:

- big-endian encoding
- fragmented and coalesced frames
- legacy XML preamble handling
- maximum-frame rejection
- command ID allocation and response correlation
- a complete local TCP identification handshake against a fixture server
- a complete local WebSocket handshake, including the `/servatrice` path
- automatic and explicit transport selection
- the built-in loopback self-test
- persistent session creation and explicit shutdown
- Cockatrice's official password-hash regression vector
- complete salt request and hashed account login over a local fixture
- guest login without password fields
- refusal of legacy plaintext login before any command is sent
- authenticated `Command_ListRooms` and typed `Event_ListRooms` decoding
- hashed registration command and accepted/activation-required responses
- activation-token command and accepted response
- joined-room snapshot decoding for games/users plus contextual leave command
- live room join/leave, game-list and chat event decoding plus room messages

The frontend test suite also verifies the browser/desktop boundary and the
diagnostic panel's failure messaging.

## Next implementation step

The next network milestone adds:

1. create/join game flows
2. game-event translation into the NovaTable domain model
3. reconnect policy with explicit backoff and session recovery
