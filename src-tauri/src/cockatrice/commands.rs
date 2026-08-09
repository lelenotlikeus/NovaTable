use std::collections::BTreeMap;

use super::protocol::wire::{
    CommandActivate, CommandContainer, CommandJoinGame, CommandJoinRoom, CommandLeaveRoom,
    CommandListRooms, CommandLogin, CommandPing, CommandRegister, CommandRequestPasswordSalt,
    CommandRoomSay, Response, RoomCommand, SessionCommand,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingCommandKind {
    Ping,
    Login,
    ListRooms,
    JoinRoom,
    LeaveRoom,
    RoomSay,
    JoinGame,
    Register,
    Activate,
    RequestPasswordSalt,
}

#[derive(Debug)]
pub struct CommandTracker {
    next_id: u64,
    pending: BTreeMap<u64, PendingCommandKind>,
}

impl Default for CommandTracker {
    fn default() -> Self {
        Self {
            next_id: 1,
            pending: BTreeMap::new(),
        }
    }
}

impl CommandTracker {
    pub fn prepare_ping(&mut self) -> CommandContainer {
        self.prepare(
            PendingCommandKind::Ping,
            SessionCommand {
                ping: Some(CommandPing {}),
                ..Default::default()
            },
        )
    }

    pub fn prepare_list_rooms(&mut self) -> CommandContainer {
        self.prepare(
            PendingCommandKind::ListRooms,
            SessionCommand {
                list_rooms: Some(CommandListRooms {}),
                ..Default::default()
            },
        )
    }

    pub fn prepare_join_room(&mut self, room_id: u32) -> CommandContainer {
        self.prepare(
            PendingCommandKind::JoinRoom,
            SessionCommand {
                join_room: Some(CommandJoinRoom {
                    room_id: Some(room_id),
                }),
                ..Default::default()
            },
        )
    }

    pub fn prepare_leave_room(&mut self, room_id: u32) -> CommandContainer {
        let command_id = self.allocate_id(PendingCommandKind::LeaveRoom);
        CommandContainer {
            cmd_id: Some(command_id),
            room_id: Some(room_id),
            room_command: vec![RoomCommand {
                leave_room: Some(CommandLeaveRoom {}),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    pub fn prepare_room_say(&mut self, room_id: u32, message: String) -> CommandContainer {
        let command_id = self.allocate_id(PendingCommandKind::RoomSay);
        CommandContainer {
            cmd_id: Some(command_id),
            room_id: Some(room_id),
            room_command: vec![RoomCommand {
                room_say: Some(CommandRoomSay {
                    message: Some(message),
                }),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    pub fn prepare_join_game(
        &mut self,
        room_id: u32,
        game_id: i32,
        password: String,
        spectator: bool,
    ) -> CommandContainer {
        let command_id = self.allocate_id(PendingCommandKind::JoinGame);
        CommandContainer {
            cmd_id: Some(command_id),
            room_id: Some(room_id),
            room_command: vec![RoomCommand {
                join_game: Some(CommandJoinGame {
                    game_id: Some(game_id),
                    password: Some(password),
                    spectator: Some(spectator),
                    override_restrictions: Some(false),
                    join_as_judge: Some(false),
                }),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    pub fn prepare_login(
        &mut self,
        user_name: String,
        password: Option<String>,
        hashed_password: Option<String>,
        client_id: String,
        client_version: String,
        client_features: Vec<String>,
    ) -> CommandContainer {
        self.prepare(
            PendingCommandKind::Login,
            SessionCommand {
                login: Some(CommandLogin {
                    user_name: Some(user_name),
                    password,
                    client_id: Some(client_id),
                    client_version: Some(client_version),
                    client_features,
                    hashed_password,
                }),
                ..Default::default()
            },
        )
    }

    pub fn prepare_request_password_salt(&mut self, user_name: String) -> CommandContainer {
        self.prepare(
            PendingCommandKind::RequestPasswordSalt,
            SessionCommand {
                request_password_salt: Some(CommandRequestPasswordSalt { user_name }),
                ..Default::default()
            },
        )
    }

    pub fn prepare_register(&mut self, registration: CommandRegister) -> CommandContainer {
        self.prepare(
            PendingCommandKind::Register,
            SessionCommand {
                register: Some(registration),
                ..Default::default()
            },
        )
    }

    pub fn prepare_activate(
        &mut self,
        user_name: String,
        token: String,
        client_id: String,
    ) -> CommandContainer {
        self.prepare(
            PendingCommandKind::Activate,
            SessionCommand {
                activate: Some(CommandActivate {
                    user_name,
                    token,
                    client_id: Some(client_id),
                }),
                ..Default::default()
            },
        )
    }

    pub fn resolve(&mut self, response: &Response) -> Option<PendingCommandKind> {
        response
            .cmd_id
            .and_then(|command_id| self.pending.remove(&command_id))
    }

    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    fn prepare(&mut self, kind: PendingCommandKind, command: SessionCommand) -> CommandContainer {
        let command_id = self.allocate_id(kind);

        CommandContainer {
            cmd_id: Some(command_id),
            session_command: vec![command],
            ..Default::default()
        }
    }

    fn allocate_id(&mut self, kind: PendingCommandKind) -> u64 {
        let command_id = self.next_id;
        self.next_id = self.next_id.checked_add(1).unwrap_or(1);
        self.pending.insert(command_id, kind);
        command_id
    }
}

#[cfg(test)]
mod tests {
    use prost::Message;

    use super::*;

    #[test]
    fn allocates_monotonic_ids_and_preserves_extension_tags() {
        let mut tracker = CommandTracker::default();
        let ping = tracker.prepare_ping();
        let rooms = tracker.prepare_list_rooms();

        assert_eq!(ping.cmd_id, Some(1));
        assert_eq!(rooms.cmd_id, Some(2));
        assert_eq!(tracker.pending_count(), 2);

        let decoded = CommandContainer::decode(ping.encode_to_vec().as_slice()).unwrap();
        assert!(decoded.session_command[0].ping.is_some());
    }

    #[test]
    fn resolves_a_response_to_the_originating_command() {
        let mut tracker = CommandTracker::default();
        let command = tracker.prepare_login(
            "Nova".into(),
            None,
            Some("salt-and-hash".into()),
            "fixture-client".into(),
            "NovaTable 0.1".into(),
            vec!["feature-set".into()],
        );

        let resolved = tracker.resolve(&Response {
            cmd_id: command.cmd_id,
            response_code: Some(1),
            ..Default::default()
        });

        assert_eq!(resolved, Some(PendingCommandKind::Login));
        assert_eq!(tracker.pending_count(), 0);
    }

    #[test]
    fn ignores_unknown_or_uncorrelated_responses() {
        let mut tracker = CommandTracker::default();
        assert_eq!(
            tracker.resolve(&Response {
                cmd_id: Some(999),
                response_code: Some(1),
                ..Default::default()
            }),
            None
        );
    }

    #[test]
    fn prepares_the_password_salt_extension() {
        let mut tracker = CommandTracker::default();
        let command = tracker.prepare_request_password_salt("Nova".into());
        let decoded = CommandContainer::decode(command.encode_to_vec().as_slice()).unwrap();

        assert_eq!(
            decoded.session_command[0]
                .request_password_salt
                .as_ref()
                .map(|request| request.user_name.as_str()),
            Some("Nova")
        );
        assert_eq!(command.cmd_id, Some(1));
    }

    #[test]
    fn decodes_reference_response_codes_as_plain_int32() {
        // cmd_id = 1, response_code = 22 (RespRegistrationRequired).
        // This is intentionally not sint32/zig-zag encoded.
        let response = Response::decode([0x08, 0x01, 0x10, 0x16].as_slice()).unwrap();
        assert_eq!(response.cmd_id, Some(1));
        assert_eq!(response.response_code, Some(22));
    }
}
