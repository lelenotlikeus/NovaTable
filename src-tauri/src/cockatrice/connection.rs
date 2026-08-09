use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use prost::Message;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tokio::task::JoinHandle;
use tokio::time::{interval, sleep_until, timeout, Instant};
use tokio_tungstenite::tungstenite::{Error as WebSocketError, Message as WebSocketMessage};
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use uuid::Uuid;
use zeroize::Zeroizing;

use super::commands::{CommandTracker, PendingCommandKind};
use super::framing::{encode_frame, FrameDecoder, FrameError};
use super::password::cockatrice_password_hash;
use super::protocol::wire::{
    CommandContainer, CommandRegister, EventGameJoined, EventServerIdentification, Response,
    ResponseLogin, ResponsePasswordSalt, RoomEvent, ServerInfoGame, ServerInfoRoom, ServerInfoUser,
    ServerMessage, SessionEvent,
};

pub const SUPPORTED_PROTOCOL_VERSION: u32 = 14;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
const SESSION_TIMEOUT: Duration = Duration::from_secs(45);
const AUTH_RESPONSE_TIMEOUT: Duration = Duration::from_secs(15);
const ROOM_LIST_TIMEOUT: Duration = Duration::from_secs(10);
const ROOM_ACTION_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransportPreference {
    #[default]
    Auto,
    Tcp,
    Ws,
    Wss,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResolvedTransport {
    Tcp,
    Ws,
    Wss,
}

impl ResolvedTransport {
    fn resolve(preference: TransportPreference, port: u16) -> Self {
        match preference {
            TransportPreference::Tcp => Self::Tcp,
            TransportPreference::Ws => Self::Ws,
            TransportPreference::Wss => Self::Wss,
            TransportPreference::Auto => match port {
                443 => Self::Wss,
                80 | 4748 | 8080 => Self::Ws,
                _ => Self::Tcp,
            },
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Tcp => "tcp",
            Self::Ws => "ws",
            Self::Wss => "wss",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProfile {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub transport: TransportPreference,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub host: String,
    pub port: u16,
    pub transport: String,
    pub server_name: String,
    pub server_version: String,
    pub protocol_version: u32,
    pub supported_protocol_version: u32,
    pub supports_password_hash: bool,
    pub compatible: bool,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSnapshot {
    pub phase: String,
    pub last_error: Option<String>,
    pub last_server: Option<ProbeResult>,
    pub authenticated_user: Option<LoginResult>,
}

impl Default for ConnectionSnapshot {
    fn default() -> Self {
        Self {
            phase: "offline".into(),
            last_error: None,
            last_server: None,
            authenticated_user: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginCredentials {
    pub user_name: String,
    #[serde(default)]
    pub password: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub user_name: String,
    pub user_level: u32,
    pub registered: bool,
    pub server_name: String,
    pub missing_features: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationRequest {
    pub user_name: String,
    pub password: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub country: String,
    #[serde(default)]
    pub real_name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationResult {
    pub user_name: String,
    pub requires_activation: bool,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationRequest {
    pub user_name: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivationResult {
    pub user_name: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoomInfo {
    pub room_id: i32,
    pub name: String,
    pub description: String,
    pub game_count: u32,
    pub player_count: u32,
    pub auto_join: bool,
    pub game_types: Vec<String>,
    pub permission_level: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserSummary {
    pub name: String,
    pub user_level: u32,
    pub registered: bool,
    pub country: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameInfo {
    pub game_id: i32,
    pub room_id: i32,
    pub description: String,
    pub creator_name: String,
    pub with_password: bool,
    pub max_players: u32,
    pub player_count: u32,
    pub spectator_count: u32,
    pub spectators_allowed: bool,
    pub spectators_need_password: bool,
    pub only_registered: bool,
    pub started: bool,
    pub closed: bool,
    pub game_type_ids: Vec<i32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoomSession {
    pub room: RoomInfo,
    pub users: Vec<UserSummary>,
    pub games: Vec<GameInfo>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameSession {
    pub game: GameInfo,
    pub host_id: i32,
    pub player_id: i32,
    pub spectator: bool,
    pub judge: bool,
    pub resuming: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoomMessage {
    pub author: String,
    pub message: String,
    pub kind: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveRoomState {
    pub session: Option<RoomSession>,
    pub messages: Vec<RoomMessage>,
}

struct SessionHandle {
    requests: mpsc::Sender<SessionRequest>,
    task: JoinHandle<()>,
}

enum SessionRequest {
    Login {
        credentials: LoginCredentials,
        reply: oneshot::Sender<Result<LoginResult, String>>,
    },
    Register {
        registration: RegistrationRequest,
        reply: oneshot::Sender<Result<RegistrationResult, String>>,
    },
    Activate {
        activation: ActivationRequest,
        reply: oneshot::Sender<Result<ActivationResult, String>>,
    },
    ListRooms {
        reply: oneshot::Sender<Result<Vec<RoomInfo>, String>>,
    },
    JoinRoom {
        room_id: u32,
        reply: oneshot::Sender<Result<RoomSession, String>>,
    },
    LeaveRoom {
        room_id: u32,
        reply: oneshot::Sender<Result<(), String>>,
    },
    RoomSay {
        room_id: u32,
        message: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    JoinGame {
        room_id: u32,
        game_id: i32,
        password: String,
        spectator: bool,
        reply: oneshot::Sender<Result<GameSession, String>>,
    },
    Shutdown,
}

#[derive(Clone, Default)]
pub struct CockatriceConnectionState {
    inner: Arc<RwLock<ConnectionSnapshot>>,
    session: Arc<Mutex<Option<SessionHandle>>>,
    live_room: Arc<RwLock<LiveRoomState>>,
}

impl CockatriceConnectionState {
    pub async fn set_probing(&self) {
        self.update("probing", None, None, None).await;
    }

    pub async fn set_result(&self, result: ProbeResult) {
        let phase = if result.compatible {
            "reachable"
        } else {
            "incompatible"
        };
        self.update(phase, None, Some(result), None).await;
    }

    pub async fn set_error(&self, error: impl Into<String>) {
        let server = self.inner.read().await.last_server.clone();
        self.update("error", Some(error.into()), server, None).await;
    }

    pub async fn snapshot(&self) -> ConnectionSnapshot {
        self.inner.read().await.clone()
    }

    pub async fn connect(&self, profile: ServerProfile) -> Result<ProbeResult, ConnectionError> {
        self.disconnect().await;
        self.update("connecting", None, None, None).await;

        let (socket, result) = match CockatriceSocket::connect(profile).await {
            Ok(connected) => connected,
            Err(error) => {
                self.set_error(error.to_string()).await;
                return Err(error);
            }
        };

        if !result.compatible {
            self.update("incompatible", None, Some(result.clone()), None)
                .await;
            return Ok(result);
        }

        self.update("connected", None, Some(result.clone()), None)
            .await;
        let (requests, receiver) = mpsc::channel(8);
        let state = self.clone();
        let session_profile = result.clone();
        let task = tokio::spawn(async move {
            run_session(socket, receiver, state, session_profile).await;
        });
        *self.session.lock().await = Some(SessionHandle { requests, task });

        Ok(result)
    }

    pub async fn login(
        &self,
        credentials: LoginCredentials,
    ) -> Result<LoginResult, ConnectionError> {
        let requests = self
            .session
            .lock()
            .await
            .as_ref()
            .map(|handle| handle.requests.clone())
            .ok_or(ConnectionError::NoActiveSession)?;
        let (reply, response) = oneshot::channel();
        requests
            .send(SessionRequest::Login { credentials, reply })
            .await
            .map_err(|_| ConnectionError::SessionClosed)?;

        response
            .await
            .map_err(|_| ConnectionError::SessionClosed)?
            .map_err(ConnectionError::Authentication)
    }

    pub async fn list_rooms(&self) -> Result<Vec<RoomInfo>, ConnectionError> {
        let requests = self
            .session
            .lock()
            .await
            .as_ref()
            .map(|handle| handle.requests.clone())
            .ok_or(ConnectionError::NoActiveSession)?;
        let (reply, response) = oneshot::channel();
        requests
            .send(SessionRequest::ListRooms { reply })
            .await
            .map_err(|_| ConnectionError::SessionClosed)?;

        response
            .await
            .map_err(|_| ConnectionError::SessionClosed)?
            .map_err(ConnectionError::RoomList)
    }

    pub async fn register(
        &self,
        registration: RegistrationRequest,
    ) -> Result<RegistrationResult, ConnectionError> {
        let requests = self
            .session
            .lock()
            .await
            .as_ref()
            .map(|handle| handle.requests.clone())
            .ok_or(ConnectionError::NoActiveSession)?;
        let (reply, response) = oneshot::channel();
        requests
            .send(SessionRequest::Register {
                registration,
                reply,
            })
            .await
            .map_err(|_| ConnectionError::SessionClosed)?;

        response
            .await
            .map_err(|_| ConnectionError::SessionClosed)?
            .map_err(ConnectionError::Registration)
    }

    pub async fn activate(
        &self,
        activation: ActivationRequest,
    ) -> Result<ActivationResult, ConnectionError> {
        let requests = self.session_sender().await?;
        let (reply, response) = oneshot::channel();
        requests
            .send(SessionRequest::Activate { activation, reply })
            .await
            .map_err(|_| ConnectionError::SessionClosed)?;
        response
            .await
            .map_err(|_| ConnectionError::SessionClosed)?
            .map_err(ConnectionError::Activation)
    }

    pub async fn join_room(&self, room_id: u32) -> Result<RoomSession, ConnectionError> {
        let requests = self.session_sender().await?;
        let (reply, response) = oneshot::channel();
        requests
            .send(SessionRequest::JoinRoom { room_id, reply })
            .await
            .map_err(|_| ConnectionError::SessionClosed)?;
        response
            .await
            .map_err(|_| ConnectionError::SessionClosed)?
            .map_err(ConnectionError::Room)
    }

    pub async fn leave_room(&self, room_id: u32) -> Result<(), ConnectionError> {
        let requests = self.session_sender().await?;
        let (reply, response) = oneshot::channel();
        requests
            .send(SessionRequest::LeaveRoom { room_id, reply })
            .await
            .map_err(|_| ConnectionError::SessionClosed)?;
        response
            .await
            .map_err(|_| ConnectionError::SessionClosed)?
            .map_err(ConnectionError::Room)
    }

    pub async fn live_room(&self) -> LiveRoomState {
        self.live_room.read().await.clone()
    }

    pub async fn send_room_message(
        &self,
        room_id: u32,
        message: String,
    ) -> Result<(), ConnectionError> {
        let requests = self.session_sender().await?;
        let (reply, response) = oneshot::channel();
        requests
            .send(SessionRequest::RoomSay {
                room_id,
                message,
                reply,
            })
            .await
            .map_err(|_| ConnectionError::SessionClosed)?;
        response
            .await
            .map_err(|_| ConnectionError::SessionClosed)?
            .map_err(ConnectionError::Room)
    }

    pub async fn join_game(
        &self,
        room_id: u32,
        game_id: i32,
        password: String,
        spectator: bool,
    ) -> Result<GameSession, ConnectionError> {
        if game_id < 0 {
            return Err(ConnectionError::Room("Game ID cannot be negative.".into()));
        }
        let requests = self.session_sender().await?;
        let (reply, response) = oneshot::channel();
        requests
            .send(SessionRequest::JoinGame {
                room_id,
                game_id,
                password,
                spectator,
                reply,
            })
            .await
            .map_err(|_| ConnectionError::SessionClosed)?;
        response
            .await
            .map_err(|_| ConnectionError::SessionClosed)?
            .map_err(ConnectionError::Room)
    }

    async fn session_sender(&self) -> Result<mpsc::Sender<SessionRequest>, ConnectionError> {
        self.session
            .lock()
            .await
            .as_ref()
            .map(|handle| handle.requests.clone())
            .ok_or(ConnectionError::NoActiveSession)
    }

    pub async fn disconnect(&self) {
        if let Some(handle) = self.session.lock().await.take() {
            let _ = handle.requests.send(SessionRequest::Shutdown).await;
            let _ = handle.task.await;
        }

        let previous = self.inner.read().await.last_server.clone();
        *self.live_room.write().await = LiveRoomState::default();
        self.update("offline", None, previous, None).await;
    }

    async fn update(
        &self,
        phase: impl Into<String>,
        last_error: Option<String>,
        last_server: Option<ProbeResult>,
        authenticated_user: Option<LoginResult>,
    ) {
        *self.inner.write().await = ConnectionSnapshot {
            phase: phase.into(),
            last_error,
            last_server,
            authenticated_user,
        };
    }

    async fn set_authenticated(&self, login: LoginResult) {
        let server = self.inner.read().await.last_server.clone();
        self.update("authenticated", None, server, Some(login))
            .await;
    }

    async fn set_live_room(&self, session: Option<RoomSession>) {
        let mut room = self.live_room.write().await;
        room.session = session;
        room.messages.clear();
    }

    async fn apply_room_event(&self, event: RoomEvent) {
        let Some(room_id) = event.room_id else {
            return;
        };
        let mut live = self.live_room.write().await;
        let Some(session) = live.session.as_mut() else {
            return;
        };
        if session.room.room_id != room_id {
            return;
        }

        if let Some(joined) = event.join_room.and_then(|event| event.user_info) {
            let user = user_summary_from_wire(joined);
            session.users.retain(|existing| existing.name != user.name);
            session.users.push(user);
            session
                .users
                .sort_by_key(|user| user.name.to_ascii_lowercase());
        }
        if let Some(name) = event.leave_room.and_then(|event| event.name) {
            session.users.retain(|user| user.name != name);
        }
        if let Some(games) = event.list_games {
            session.games = games
                .game_list
                .into_iter()
                .map(game_info_from_wire)
                .collect();
        }
        if let Some(message) = event.room_say {
            let text = message.message.unwrap_or_default();
            if !text.is_empty() {
                live.messages.push(RoomMessage {
                    author: message.name.unwrap_or_else(|| "Server".into()),
                    message: text,
                    kind: match message.message_type.unwrap_or_default() {
                        1 => "welcome",
                        2 => "history",
                        _ => "user",
                    }
                    .into(),
                    timestamp: message.time_of.unwrap_or_default(),
                });
                if live.messages.len() > 200 {
                    let excess = live.messages.len() - 200;
                    live.messages.drain(..excess);
                }
            }
        }
    }
}

#[derive(Debug, Error)]
pub enum ConnectionError {
    #[error("server host cannot be empty")]
    EmptyHost,
    #[error("connection to {host}:{port} timed out")]
    ConnectTimeout { host: String, port: u16 },
    #[error(
        "could not connect to {host}:{port}. No server is listening at this address; start Servatrice or choose a remote server. System error: {source}"
    )]
    Connect {
        host: String,
        port: u16,
        source: std::io::Error,
    },
    #[error("the server closed the connection before identifying itself")]
    ClosedBeforeIdentification,
    #[error("the server did not identify itself within the connection timeout")]
    IdentificationTimeout,
    #[error("no active server session; connect before logging in")]
    NoActiveSession,
    #[error("the server session closed before the request completed")]
    SessionClosed,
    #[error("{0}")]
    Authentication(String),
    #[error("{0}")]
    RoomList(String),
    #[error("{0}")]
    Registration(String),
    #[error("{0}")]
    Activation(String),
    #[error("{0}")]
    Room(String),
    #[error("WebSocket transport failed: {0}")]
    WebSocket(#[from] WebSocketError),
    #[error("network I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid Cockatrice frame: {0}")]
    Frame(#[from] FrameError),
    #[error("invalid Cockatrice protobuf message: {0}")]
    Protocol(#[from] prost::DecodeError),
    #[error("the built-in protocol self-test failed: {0}")]
    SelfTest(String),
}

enum CockatriceSocket {
    Tcp {
        stream: TcpStream,
        decoder: FrameDecoder,
        pending: VecDeque<Vec<u8>>,
    },
    WebSocket {
        stream: Box<WebSocketStream<MaybeTlsStream<TcpStream>>>,
    },
}

impl CockatriceSocket {
    async fn connect(profile: ServerProfile) -> Result<(Self, ProbeResult), ConnectionError> {
        let host = profile.host.trim().to_string();
        if host.is_empty() {
            return Err(ConnectionError::EmptyHost);
        }

        let transport = ResolvedTransport::resolve(profile.transport, profile.port);
        let started_at = Instant::now();
        let mut socket = match transport {
            ResolvedTransport::Tcp => {
                let mut stream = timeout(
                    CONNECT_TIMEOUT,
                    TcpStream::connect((host.as_str(), profile.port)),
                )
                .await
                .map_err(|_| ConnectionError::ConnectTimeout {
                    host: host.clone(),
                    port: profile.port,
                })?
                .map_err(|source| ConnectionError::Connect {
                    host: host.clone(),
                    port: profile.port,
                    source,
                })?;
                stream.set_nodelay(true)?;

                // Raw TCP clients start the v14 identification handshake with
                // an empty, length-prefixed CommandContainer.
                let handshake = CommandContainer::default().encode_to_vec();
                stream.write_all(&encode_frame(&handshake)?).await?;
                Self::Tcp {
                    stream,
                    decoder: FrameDecoder::default(),
                    pending: VecDeque::new(),
                }
            }
            ResolvedTransport::Ws | ResolvedTransport::Wss => {
                let secure = transport == ResolvedTransport::Wss;
                let scheme = if secure { "wss" } else { "ws" };
                let url_host = if host.contains(':') && !host.starts_with('[') {
                    format!("[{host}]")
                } else {
                    host.clone()
                };
                let url = format!("{scheme}://{url_host}:{}/servatrice", profile.port);
                let websocket = timeout(CONNECT_TIMEOUT, connect_async(&url))
                    .await
                    .map_err(|_| ConnectionError::ConnectTimeout {
                        host: host.clone(),
                        port: profile.port,
                    })?;
                let (stream, _) = match websocket {
                    Ok(connected) => connected,
                    Err(WebSocketError::Io(source)) => {
                        return Err(ConnectionError::Connect {
                            host: host.clone(),
                            port: profile.port,
                            source,
                        });
                    }
                    Err(error) => return Err(ConnectionError::WebSocket(error)),
                };
                Self::WebSocket { stream: Box::new(stream) }
            }
        };

        let deadline = started_at + CONNECT_TIMEOUT;
        let identification = loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(ConnectionError::IdentificationTimeout);
            }

            let message = timeout(remaining, socket.next_server_message())
                .await
                .map_err(|_| ConnectionError::IdentificationTimeout)??;
            if let Some(identification) = message
                .session_event
                .and_then(|event| event.server_identification)
            {
                break identification;
            }
        };

        let result = build_probe_result(host, profile.port, transport, started_at, identification);
        Ok((socket, result))
    }

    async fn send_command(&mut self, command: &CommandContainer) -> Result<(), ConnectionError> {
        let payload = command.encode_to_vec();
        match self {
            Self::Tcp { stream, .. } => {
                stream.write_all(&encode_frame(&payload)?).await?;
            }
            Self::WebSocket { stream, .. } => {
                stream
                    .send(WebSocketMessage::Binary(payload.into()))
                    .await?;
            }
        }
        Ok(())
    }

    async fn next_server_message(&mut self) -> Result<ServerMessage, ConnectionError> {
        match self {
            Self::Tcp {
                stream,
                decoder,
                pending,
            } => loop {
                if let Some(payload) = pending.pop_front() {
                    if payload.is_empty() {
                        continue;
                    }
                    return Ok(ServerMessage::decode(payload.as_slice())?);
                }

                let mut read_buffer = [0_u8; 8192];
                let read = stream.read(&mut read_buffer).await?;
                if read == 0 {
                    return Err(ConnectionError::ClosedBeforeIdentification);
                }
                pending.extend(decoder.push(&read_buffer[..read])?);
            },
            Self::WebSocket { stream, .. } => loop {
                let message = stream
                    .next()
                    .await
                    .ok_or(ConnectionError::ClosedBeforeIdentification)??;
                match message {
                    WebSocketMessage::Binary(payload) => {
                        return Ok(ServerMessage::decode(payload.as_ref())?);
                    }
                    WebSocketMessage::Close(_) => {
                        return Err(ConnectionError::ClosedBeforeIdentification);
                    }
                    WebSocketMessage::Ping(payload) => {
                        stream.send(WebSocketMessage::Pong(payload)).await?;
                    }
                    _ => {}
                }
            },
        }
    }

    async fn close(&mut self) {
        match self {
            Self::Tcp { stream, .. } => {
                let _ = stream.shutdown().await;
            }
            Self::WebSocket { stream, .. } => {
                let _ = stream.close().await;
            }
        }
    }
}

pub async fn probe_server(profile: ServerProfile) -> Result<ProbeResult, ConnectionError> {
    let (mut socket, result) = CockatriceSocket::connect(profile).await?;
    socket.close().await;
    Ok(result)
}

pub async fn run_protocol_self_test() -> Result<ProbeResult, ConnectionError> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let fixture = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await?;
        let handshake = read_fixture_frame(&mut socket).await?;
        if !handshake.is_empty() {
            return Err(ConnectionError::SelfTest(
                "the client handshake was not empty".into(),
            ));
        }

        let message = identification_message("NovaTable protocol fixture", 14);
        socket
            .write_all(&encode_frame(&message.encode_to_vec())?)
            .await?;

        let salt_command =
            CommandContainer::decode(read_fixture_frame(&mut socket).await?.as_slice())?;
        let salt_request = salt_command
            .session_command
            .first()
            .and_then(|command| command.request_password_salt.as_ref())
            .ok_or_else(|| {
                ConnectionError::SelfTest("the client did not request a password salt".into())
            })?;
        if salt_request.user_name != "FixtureUser" {
            return Err(ConnectionError::SelfTest(
                "the salt request contained the wrong user name".into(),
            ));
        }
        write_fixture_response(
            &mut socket,
            Response {
                cmd_id: salt_command.cmd_id,
                response_code: Some(1),
                password_salt: Some(ResponsePasswordSalt {
                    password_salt: Some("saltsaltsaltsalt".into()),
                }),
                ..Default::default()
            },
        )
        .await?;

        let login_command =
            CommandContainer::decode(read_fixture_frame(&mut socket).await?.as_slice())?;
        let login = login_command
            .session_command
            .first()
            .and_then(|command| command.login.as_ref())
            .ok_or_else(|| ConnectionError::SelfTest("the client did not send a login".into()))?;
        let expected_hash = cockatrice_password_hash("password", "saltsaltsaltsalt");
        if login.password.is_some() || login.hashed_password.as_deref() != Some(&expected_hash) {
            return Err(ConnectionError::SelfTest(
                "the client did not send the expected hashed password".into(),
            ));
        }
        write_fixture_response(
            &mut socket,
            Response {
                cmd_id: login_command.cmd_id,
                response_code: Some(1),
                login: Some(ResponseLogin {
                    user_info: Some(ServerInfoUser {
                        name: Some("FixtureUser".into()),
                        user_level: Some(3),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await?;

        let mut closed = [0_u8; 1];
        if socket.read(&mut closed).await? != 0 {
            return Err(ConnectionError::SelfTest(
                "the client sent unexpected data after login".into(),
            ));
        }
        Ok::<(), ConnectionError>(())
    });

    let state = CockatriceConnectionState::default();
    let result = state
        .connect(ServerProfile {
            host: "127.0.0.1".into(),
            port,
            transport: TransportPreference::Tcp,
        })
        .await?;
    let login = state
        .login(LoginCredentials {
            user_name: "FixtureUser".into(),
            password: "password".into(),
        })
        .await?;
    if !login.registered {
        return Err(ConnectionError::SelfTest(
            "the fixture login was not recognized as registered".into(),
        ));
    }
    state.disconnect().await;

    fixture
        .await
        .map_err(|error| ConnectionError::SelfTest(error.to_string()))??;
    Ok(result)
}

async fn read_fixture_frame(socket: &mut TcpStream) -> Result<Vec<u8>, ConnectionError> {
    let mut prefix = [0_u8; 4];
    socket.read_exact(&mut prefix).await?;
    let payload_size = u32::from_be_bytes(prefix) as usize;
    if payload_size > 16 * 1024 * 1024 {
        return Err(ConnectionError::SelfTest(
            "fixture received an oversized frame".into(),
        ));
    }
    let mut payload = vec![0_u8; payload_size];
    socket.read_exact(&mut payload).await?;
    Ok(payload)
}

async fn write_fixture_response(
    socket: &mut TcpStream,
    response: Response,
) -> Result<(), ConnectionError> {
    let message = ServerMessage {
        message_type: Some(0),
        response: Some(response),
        ..Default::default()
    };
    socket
        .write_all(&encode_frame(&message.encode_to_vec())?)
        .await?;
    Ok(())
}

async fn run_session(
    mut socket: CockatriceSocket,
    mut requests: mpsc::Receiver<SessionRequest>,
    state: CockatriceConnectionState,
    server: ProbeResult,
) {
    let mut keepalive = interval(KEEPALIVE_INTERVAL);
    keepalive.tick().await;
    let mut last_received = Instant::now();
    let mut commands = CommandTracker::default();
    let mut login_attempt: Option<LoginAttempt> = None;
    let mut registration_attempt: Option<RegistrationAttempt> = None;
    let mut activation_attempt: Option<ActivationAttempt> = None;
    let mut room_list_attempt: Option<RoomListAttempt> = None;
    let mut join_room_attempt: Option<JoinRoomAttempt> = None;
    let mut leave_room_attempt: Option<LeaveRoomAttempt> = None;
    let mut room_say_attempt: Option<RoomSayAttempt> = None;
    let mut join_game_attempt: Option<JoinGameAttempt> = None;

    loop {
        let auth_deadline = login_attempt
            .as_ref()
            .map(|attempt| attempt.started_at + AUTH_RESPONSE_TIMEOUT)
            .unwrap_or_else(|| Instant::now() + AUTH_RESPONSE_TIMEOUT);
        let room_list_deadline = room_list_attempt
            .as_ref()
            .map(|attempt| attempt.started_at + ROOM_LIST_TIMEOUT)
            .unwrap_or_else(|| Instant::now() + ROOM_LIST_TIMEOUT);
        let registration_deadline = registration_attempt
            .as_ref()
            .map(|attempt| attempt.started_at + AUTH_RESPONSE_TIMEOUT)
            .unwrap_or_else(|| Instant::now() + AUTH_RESPONSE_TIMEOUT);
        let activation_deadline = activation_attempt
            .as_ref()
            .map(|attempt| attempt.started_at + AUTH_RESPONSE_TIMEOUT)
            .unwrap_or_else(|| Instant::now() + AUTH_RESPONSE_TIMEOUT);
        let room_action_deadline = join_room_attempt
            .as_ref()
            .map(|attempt| attempt.started_at + ROOM_ACTION_TIMEOUT)
            .or_else(|| {
                leave_room_attempt
                    .as_ref()
                    .map(|attempt| attempt.started_at + ROOM_ACTION_TIMEOUT)
            })
            .or_else(|| {
                room_say_attempt
                    .as_ref()
                    .map(|attempt| attempt.started_at + ROOM_ACTION_TIMEOUT)
            })
            .or_else(|| {
                join_game_attempt
                    .as_ref()
                    .map(|attempt| attempt.started_at + ROOM_ACTION_TIMEOUT)
            })
            .unwrap_or_else(|| Instant::now() + ROOM_ACTION_TIMEOUT);

        tokio::select! {
            request = requests.recv() => {
                match request {
                    Some(SessionRequest::Shutdown) | None => {
                        if let Some(attempt) = login_attempt.take() {
                            let _ = attempt.reply.send(Err("Login cancelled: session disconnected.".into()));
                        }
                        if let Some(attempt) = room_list_attempt.take() {
                            let _ = attempt.reply.send(Err("Room loading cancelled: session disconnected.".into()));
                        }
                        if let Some(attempt) = registration_attempt.take() {
                            let _ = attempt.reply.send(Err("Registration cancelled: session disconnected.".into()));
                        }
                        if let Some(attempt) = activation_attempt.take() {
                            let _ = attempt.reply.send(Err("Activation cancelled: session disconnected.".into()));
                        }
                        if let Some(attempt) = join_room_attempt.take() {
                            let _ = attempt.reply.send(Err("Joining the room was cancelled.".into()));
                        }
                        if let Some(attempt) = leave_room_attempt.take() {
                            let _ = attempt.reply.send(Err("Leaving the room was cancelled.".into()));
                        }
                        if let Some(attempt) = room_say_attempt.take() {
                            let _ = attempt.reply.send(Err("Sending the room message was cancelled.".into()));
                        }
                        if let Some(attempt) = join_game_attempt.take() {
                            let _ = attempt.reply.send(Err("Joining the game was cancelled.".into()));
                        }
                        socket.close().await;
                        let previous = state.snapshot().await.last_server;
                        state.update("offline", None, previous, None).await;
                        return;
                    }
                    Some(SessionRequest::Login { credentials, reply }) => {
                        if login_attempt.is_some() || registration_attempt.is_some() || activation_attempt.is_some() {
                            let _ = reply.send(Err("Another identity request is already in progress.".into()));
                            continue;
                        }

                        match start_login(&mut socket, &mut commands, credentials, reply, &server).await {
                            Ok(attempt) => login_attempt = Some(attempt),
                            Err((error, reply)) => {
                                let message = error.to_string();
                                let _ = reply.send(Err(message.clone()));
                                if matches!(
                                    error,
                                    ConnectionError::Io(_)
                                        | ConnectionError::WebSocket(_)
                                        | ConnectionError::Frame(_)
                                ) {
                                    state.set_error(message).await;
                                    socket.close().await;
                                    return;
                                }
                            }
                        }
                    }
                    Some(SessionRequest::Register { registration, reply }) => {
                        if login_attempt.is_some() || registration_attempt.is_some() || activation_attempt.is_some() {
                            let _ = reply.send(Err("Another identity request is already in progress.".into()));
                            continue;
                        }
                        match start_registration(
                            &mut socket,
                            &mut commands,
                            registration,
                            reply,
                            &server,
                        )
                        .await
                        {
                            Ok(attempt) => registration_attempt = Some(attempt),
                            Err((error, reply)) => {
                                let message = error.to_string();
                                let _ = reply.send(Err(message.clone()));
                                if is_transport_error(&error) {
                                    state.set_error(message).await;
                                    socket.close().await;
                                    return;
                                }
                            }
                        }
                    }
                    Some(SessionRequest::Activate { activation, reply }) => {
                        if login_attempt.is_some() || registration_attempt.is_some() || activation_attempt.is_some() {
                            let _ = reply.send(Err("Another identity request is already in progress.".into()));
                            continue;
                        }
                        match start_activation(
                            &mut socket,
                            &mut commands,
                            activation,
                            reply,
                        )
                        .await
                        {
                            Ok(attempt) => activation_attempt = Some(attempt),
                            Err((error, reply)) => {
                                let message = error.to_string();
                                let _ = reply.send(Err(message.clone()));
                                if is_transport_error(&error) {
                                    state.set_error(message).await;
                                    socket.close().await;
                                    return;
                                }
                            }
                        }
                    }
                    Some(SessionRequest::ListRooms { reply }) => {
                        if room_list_attempt.is_some() {
                            let _ = reply.send(Err("A room-list request is already in progress.".into()));
                            continue;
                        }
                        let command = commands.prepare_list_rooms();
                        if let Err(error) = socket.send_command(&command).await {
                            let message = error.to_string();
                            let _ = reply.send(Err(message.clone()));
                            state.set_error(message).await;
                            socket.close().await;
                            return;
                        }
                        room_list_attempt = Some(RoomListAttempt {
                            started_at: Instant::now(),
                            reply,
                        });
                    }
                    Some(SessionRequest::JoinRoom { room_id, reply }) => {
                        if join_room_attempt.is_some() || leave_room_attempt.is_some() || room_say_attempt.is_some() || join_game_attempt.is_some() {
                            let _ = reply.send(Err("Another room action is already in progress.".into()));
                            continue;
                        }
                        let command = commands.prepare_join_room(room_id);
                        if let Err(error) = socket.send_command(&command).await {
                            let message = error.to_string();
                            let _ = reply.send(Err(message.clone()));
                            state.set_error(message).await;
                            socket.close().await;
                            return;
                        }
                        join_room_attempt = Some(JoinRoomAttempt {
                            room_id,
                            started_at: Instant::now(),
                            reply,
                        });
                    }
                    Some(SessionRequest::LeaveRoom { room_id, reply }) => {
                        if join_room_attempt.is_some() || leave_room_attempt.is_some() || room_say_attempt.is_some() || join_game_attempt.is_some() {
                            let _ = reply.send(Err("Another room action is already in progress.".into()));
                            continue;
                        }
                        let command = commands.prepare_leave_room(room_id);
                        if let Err(error) = socket.send_command(&command).await {
                            let message = error.to_string();
                            let _ = reply.send(Err(message.clone()));
                            state.set_error(message).await;
                            socket.close().await;
                            return;
                        }
                        leave_room_attempt = Some(LeaveRoomAttempt {
                            started_at: Instant::now(),
                            reply,
                        });
                    }
                    Some(SessionRequest::RoomSay { room_id, message, reply }) => {
                        if join_room_attempt.is_some() || leave_room_attempt.is_some() || room_say_attempt.is_some() || join_game_attempt.is_some() {
                            let _ = reply.send(Err("Another room action is already in progress.".into()));
                            continue;
                        }
                        let message = message.trim().to_string();
                        if message.is_empty() {
                            let _ = reply.send(Err("The room message cannot be empty.".into()));
                            continue;
                        }
                        let command = commands.prepare_room_say(room_id, message);
                        if let Err(error) = socket.send_command(&command).await {
                            let error_message = error.to_string();
                            let _ = reply.send(Err(error_message.clone()));
                            state.set_error(error_message).await;
                            socket.close().await;
                            return;
                        }
                        room_say_attempt = Some(RoomSayAttempt {
                            started_at: Instant::now(),
                            reply,
                        });
                    }
                    Some(SessionRequest::JoinGame { room_id, game_id, password, spectator, reply }) => {
                        if join_room_attempt.is_some() || leave_room_attempt.is_some() || room_say_attempt.is_some() || join_game_attempt.is_some() {
                            let _ = reply.send(Err("Another room action is already in progress.".into()));
                            continue;
                        }
                        let command = commands.prepare_join_game(room_id, game_id, password, spectator);
                        if let Err(error) = socket.send_command(&command).await {
                            let message = error.to_string();
                            let _ = reply.send(Err(message.clone()));
                            state.set_error(message).await;
                            socket.close().await;
                            return;
                        }
                        join_game_attempt = Some(JoinGameAttempt {
                            game_id,
                            accepted: false,
                            started_at: Instant::now(),
                            reply,
                        });
                    }
                }
            }
            _ = keepalive.tick() => {
                if last_received.elapsed() >= SESSION_TIMEOUT {
                    if let Some(attempt) = login_attempt.take() {
                        let _ = attempt.reply.send(Err(
                            "Login failed because the server stopped responding.".into()
                        ));
                    }
                    if let Some(attempt) = room_list_attempt.take() {
                        let _ = attempt.reply.send(Err(
                            "Room loading failed because the server stopped responding.".into()
                        ));
                    }
                    if let Some(attempt) = registration_attempt.take() {
                        let _ = attempt.reply.send(Err(
                            "Registration failed because the server stopped responding.".into()
                        ));
                    }
                    if let Some(attempt) = activation_attempt.take() {
                        let _ = attempt.reply.send(Err(
                            "Activation failed because the server stopped responding.".into()
                        ));
                    }
                    if let Some(attempt) = join_room_attempt.take() {
                        let _ = attempt.reply.send(Err(
                            "Joining the room failed because the server stopped responding.".into()
                        ));
                    }
                    if let Some(attempt) = leave_room_attempt.take() {
                        let _ = attempt.reply.send(Err(
                            "Leaving the room failed because the server stopped responding.".into()
                        ));
                    }
                    if let Some(attempt) = room_say_attempt.take() {
                        let _ = attempt.reply.send(Err(
                            "Sending the room message failed because the server stopped responding.".into()
                        ));
                    }
                    if let Some(attempt) = join_game_attempt.take() {
                        let _ = attempt.reply.send(Err(
                            "Joining the game failed because the server stopped responding.".into()
                        ));
                    }
                    state
                        .set_error("server timed out after 45 seconds without traffic")
                        .await;
                    socket.close().await;
                    return;
                }

                let ping = commands.prepare_ping();
                if let Err(error) = socket.send_command(&ping).await {
                    state.set_error(error.to_string()).await;
                    return;
                }
            }
            _ = sleep_until(auth_deadline), if login_attempt.is_some() => {
                if let Some(attempt) = login_attempt.take() {
                    let _ = attempt.reply.send(Err(
                        "Login timed out after 15 seconds without a response.".into()
                    ));
                }
            }
            _ = sleep_until(room_list_deadline), if room_list_attempt.is_some() => {
                if let Some(attempt) = room_list_attempt.take() {
                    let _ = attempt.reply.send(Err(
                        "Room loading timed out after 10 seconds.".into()
                    ));
                }
            }
            _ = sleep_until(registration_deadline), if registration_attempt.is_some() => {
                if let Some(attempt) = registration_attempt.take() {
                    let _ = attempt.reply.send(Err(
                        "Registration timed out after 15 seconds.".into()
                    ));
                }
            }
            _ = sleep_until(activation_deadline), if activation_attempt.is_some() => {
                if let Some(attempt) = activation_attempt.take() {
                    let _ = attempt.reply.send(Err(
                        "Activation timed out after 15 seconds.".into()
                    ));
                }
            }
            _ = sleep_until(room_action_deadline), if join_room_attempt.is_some() || leave_room_attempt.is_some() || room_say_attempt.is_some() || join_game_attempt.is_some() => {
                if let Some(attempt) = join_room_attempt.take() {
                    let _ = attempt.reply.send(Err("Joining the room timed out after 10 seconds.".into()));
                }
                if let Some(attempt) = leave_room_attempt.take() {
                    let _ = attempt.reply.send(Err("Leaving the room timed out after 10 seconds.".into()));
                }
                if let Some(attempt) = room_say_attempt.take() {
                    let _ = attempt.reply.send(Err("Sending the room message timed out after 10 seconds.".into()));
                }
                if let Some(attempt) = join_game_attempt.take() {
                    let _ = attempt.reply.send(Err("Joining the game timed out after 10 seconds.".into()));
                }
            }
            incoming = socket.next_server_message() => {
                match incoming {
                    Ok(message) => {
                        last_received = Instant::now();
                        if let Some(event) = message.session_event {
                            if let Some(room_event) = event.list_rooms {
                                if let Some(attempt) = room_list_attempt.take() {
                                    let rooms = room_event
                                        .room_list
                                        .into_iter()
                                        .map(room_info_from_wire)
                                        .collect();
                                    let _ = attempt.reply.send(Ok(rooms));
                                }
                            }
                            if let Some(joined) = event.game_joined {
                                let matches_request = join_game_attempt.as_ref().is_some_and(|attempt| {
                                    attempt.accepted
                                        && joined.game_info.as_ref().and_then(|game| game.game_id)
                                            == Some(attempt.game_id)
                                });
                                if matches_request {
                                    if let Some(attempt) = join_game_attempt.take() {
                                        let _ = attempt.reply.send(game_session_from_wire(joined));
                                    }
                                }
                            }
                        }
                        if let Some(room_event) = message.room_event {
                            state.apply_room_event(room_event).await;
                        }
                        if let Some(response) = message.response {
                            let kind = commands.resolve(&response);
                            match kind {
                                Some(PendingCommandKind::RequestPasswordSalt) => {
                                    if let Some(mut attempt) = login_attempt.take() {
                                        match continue_after_password_salt(
                                            &mut socket,
                                            &mut commands,
                                            &response,
                                            &mut attempt,
                                        )
                                        .await
                                        {
                                            Ok(()) => login_attempt = Some(attempt),
                                            Err(error) => {
                                                let message = error.to_string();
                                                let _ = attempt.reply.send(Err(message.clone()));
                                                if is_transport_error(&error) {
                                                    state.set_error(message).await;
                                                    socket.close().await;
                                                    return;
                                                }
                                            }
                                        }
                                    }
                                }
                                Some(PendingCommandKind::Login) => {
                                    if let Some(attempt) = login_attempt.take() {
                                        match finish_login(&response, &attempt.user_name, &server.server_name) {
                                            Ok(result) => {
                                                state.set_authenticated(result.clone()).await;
                                                let _ = attempt.reply.send(Ok(result));
                                            }
                                            Err(error) => {
                                                let _ = attempt.reply.send(Err(error));
                                            }
                                        }
                                    }
                                }
                                Some(PendingCommandKind::ListRooms) => {
                                    if response.response_code.unwrap_or_default() != 1 {
                                        if let Some(attempt) = room_list_attempt.take() {
                                            let _ = attempt.reply.send(Err(format!(
                                                "Room loading failed (response {}): {}.",
                                                response.response_code.unwrap_or_default(),
                                                response_code_explanation(
                                                    response.response_code.unwrap_or_default()
                                                )
                                            )));
                                        }
                                    }
                                }
                                Some(PendingCommandKind::Register) => {
                                    if let Some(attempt) = registration_attempt.take() {
                                        let result = finish_registration(
                                            &response,
                                            &attempt.user_name,
                                        );
                                        let _ = attempt.reply.send(result);
                                    }
                                }
                                Some(PendingCommandKind::Activate) => {
                                    if let Some(attempt) = activation_attempt.take() {
                                        let result = finish_activation(
                                            &response,
                                            &attempt.user_name,
                                        );
                                        let _ = attempt.reply.send(result);
                                    }
                                }
                                Some(PendingCommandKind::JoinRoom) => {
                                    if let Some(attempt) = join_room_attempt.take() {
                                        let result = finish_join_room(&response, attempt.room_id);
                                        if let Ok(session) = &result {
                                            state.set_live_room(Some(session.clone())).await;
                                        }
                                        let _ = attempt.reply.send(result);
                                    }
                                }
                                Some(PendingCommandKind::LeaveRoom) => {
                                    if let Some(attempt) = leave_room_attempt.take() {
                                        let result = if response.response_code.unwrap_or_default() == 1 {
                                            Ok(())
                                        } else {
                                            Err(format!(
                                                "Could not leave room (response {}): {}.",
                                                response.response_code.unwrap_or_default(),
                                                response_code_explanation(
                                                    response.response_code.unwrap_or_default()
                                                )
                                            ))
                                        };
                                        if result.is_ok() {
                                            state.set_live_room(None).await;
                                        }
                                        let _ = attempt.reply.send(result);
                                    }
                                }
                                Some(PendingCommandKind::RoomSay) => {
                                    if let Some(attempt) = room_say_attempt.take() {
                                        let result = if response.response_code.unwrap_or_default() == 1 {
                                            Ok(())
                                        } else {
                                            Err(format!(
                                                "Could not send room message (response {}): {}.",
                                                response.response_code.unwrap_or_default(),
                                                response_code_explanation(
                                                    response.response_code.unwrap_or_default()
                                                )
                                            ))
                                        };
                                        let _ = attempt.reply.send(result);
                                    }
                                }
                                Some(PendingCommandKind::JoinGame) => {
                                    if response.response_code.unwrap_or_default() == 1 {
                                        if let Some(attempt) = join_game_attempt.as_mut() {
                                            attempt.accepted = true;
                                        }
                                    } else if let Some(attempt) = join_game_attempt.take() {
                                        let code = response.response_code.unwrap_or_default();
                                        let _ = attempt.reply.send(Err(format!(
                                            "Could not join game (response {code}): {}.",
                                            response_code_explanation(code)
                                        )));
                                    }
                                }
                                Some(PendingCommandKind::Ping)
                                | None => {}
                            }
                        }
                    }
                    Err(error) => {
                        if let Some(attempt) = login_attempt.take() {
                            let _ = attempt.reply.send(Err(error.to_string()));
                        }
                        if let Some(attempt) = room_list_attempt.take() {
                            let _ = attempt.reply.send(Err(error.to_string()));
                        }
                        if let Some(attempt) = registration_attempt.take() {
                            let _ = attempt.reply.send(Err(error.to_string()));
                        }
                        if let Some(attempt) = activation_attempt.take() {
                            let _ = attempt.reply.send(Err(error.to_string()));
                        }
                        if let Some(attempt) = join_room_attempt.take() {
                            let _ = attempt.reply.send(Err(error.to_string()));
                        }
                        if let Some(attempt) = leave_room_attempt.take() {
                            let _ = attempt.reply.send(Err(error.to_string()));
                        }
                        if let Some(attempt) = room_say_attempt.take() {
                            let _ = attempt.reply.send(Err(error.to_string()));
                        }
                        if let Some(attempt) = join_game_attempt.take() {
                            let _ = attempt.reply.send(Err(error.to_string()));
                        }
                        state.set_error(error.to_string()).await;
                        return;
                    }
                }
            }
        }
    }
}

struct RoomListAttempt {
    started_at: Instant,
    reply: oneshot::Sender<Result<Vec<RoomInfo>, String>>,
}

struct RegistrationAttempt {
    user_name: String,
    started_at: Instant,
    reply: oneshot::Sender<Result<RegistrationResult, String>>,
}

struct ActivationAttempt {
    user_name: String,
    started_at: Instant,
    reply: oneshot::Sender<Result<ActivationResult, String>>,
}

struct JoinRoomAttempt {
    room_id: u32,
    started_at: Instant,
    reply: oneshot::Sender<Result<RoomSession, String>>,
}

struct LeaveRoomAttempt {
    started_at: Instant,
    reply: oneshot::Sender<Result<(), String>>,
}

struct RoomSayAttempt {
    started_at: Instant,
    reply: oneshot::Sender<Result<(), String>>,
}

struct JoinGameAttempt {
    game_id: i32,
    accepted: bool,
    started_at: Instant,
    reply: oneshot::Sender<Result<GameSession, String>>,
}

struct LoginAttempt {
    user_name: String,
    phase: LoginPhase,
    started_at: Instant,
    reply: oneshot::Sender<Result<LoginResult, String>>,
}

enum LoginPhase {
    AwaitingSalt { password: Zeroizing<String> },
    AwaitingLogin,
}

async fn start_registration(
    socket: &mut CockatriceSocket,
    commands: &mut CommandTracker,
    registration: RegistrationRequest,
    reply: oneshot::Sender<Result<RegistrationResult, String>>,
    server: &ProbeResult,
) -> Result<
    RegistrationAttempt,
    (
        ConnectionError,
        oneshot::Sender<Result<RegistrationResult, String>>,
    ),
> {
    let user_name = registration.user_name.trim().to_string();
    if user_name.is_empty() {
        return Err((
            ConnectionError::Registration("A user name is required.".into()),
            reply,
        ));
    }
    let password = Zeroizing::new(registration.password);
    if password.is_empty() {
        return Err((
            ConnectionError::Registration("A password is required to create an account.".into()),
            reply,
        ));
    }

    let (plain_password, hashed_password) = if server.supports_password_hash {
        let random = Uuid::new_v4().simple().to_string();
        let salt = &random[..16];
        (None, Some(cockatrice_password_hash(&password, salt)))
    } else if server.transport == "wss" {
        (Some(password.to_string()), None)
    } else {
        return Err((
            ConnectionError::Registration(format!(
                "Account creation refused: {} does not support password hashing and {} is not encrypted. Use WSS.",
                server.server_name,
                server.transport.to_uppercase()
            )),
            reply,
        ));
    };

    let optional = |value: String| {
        let trimmed = value.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    };
    let command = commands.prepare_register(CommandRegister {
        user_name: user_name.clone(),
        password: plain_password,
        email: optional(registration.email),
        country: optional(registration.country),
        real_name: optional(registration.real_name),
        client_id: Some(format!("novatable-{}", Uuid::new_v4())),
        hashed_password,
    });
    if let Err(error) = socket.send_command(&command).await {
        return Err((error, reply));
    }

    Ok(RegistrationAttempt {
        user_name,
        started_at: Instant::now(),
        reply,
    })
}

fn finish_registration(response: &Response, user_name: &str) -> Result<RegistrationResult, String> {
    let code = response.response_code.unwrap_or_default();
    let requires_activation = match code {
        23 => false,
        33 => true,
        _ => {
            let reason = response
                .register
                .as_ref()
                .and_then(|payload| payload.denied_reason_str.as_deref())
                .filter(|reason| !reason.trim().is_empty());
            let mut message = format!(
                "Account creation failed (response {code}): {}.",
                response_code_explanation(code)
            );
            if let Some(reason) = reason {
                message.push_str(&format!(" Server reason: {reason}."));
            }
            return Err(message);
        }
    };

    Ok(RegistrationResult {
        user_name: user_name.to_string(),
        requires_activation,
        message: if requires_activation {
            "Account created. Check your email for the activation instructions.".into()
        } else {
            "Account created and ready to use.".into()
        },
    })
}

async fn start_activation(
    socket: &mut CockatriceSocket,
    commands: &mut CommandTracker,
    activation: ActivationRequest,
    reply: oneshot::Sender<Result<ActivationResult, String>>,
) -> Result<
    ActivationAttempt,
    (
        ConnectionError,
        oneshot::Sender<Result<ActivationResult, String>>,
    ),
> {
    let user_name = activation.user_name.trim().to_string();
    let token = activation.token.trim().to_string();
    if user_name.is_empty() || token.is_empty() {
        return Err((
            ConnectionError::Activation(
                "Both the user name and email activation code are required.".into(),
            ),
            reply,
        ));
    }

    let command = commands.prepare_activate(
        user_name.clone(),
        token,
        format!("novatable-{}", Uuid::new_v4()),
    );
    if let Err(error) = socket.send_command(&command).await {
        return Err((error, reply));
    }

    Ok(ActivationAttempt {
        user_name,
        started_at: Instant::now(),
        reply,
    })
}

fn finish_activation(response: &Response, user_name: &str) -> Result<ActivationResult, String> {
    let code = response.response_code.unwrap_or_default();
    if code != 31 {
        return Err(format!(
            "Account activation failed (response {code}): {}.",
            response_code_explanation(code)
        ));
    }
    Ok(ActivationResult {
        user_name: user_name.to_string(),
        message: "Account activated. You can now log in.".into(),
    })
}

async fn start_login(
    socket: &mut CockatriceSocket,
    commands: &mut CommandTracker,
    credentials: LoginCredentials,
    reply: oneshot::Sender<Result<LoginResult, String>>,
    server: &ProbeResult,
) -> Result<
    LoginAttempt,
    (
        ConnectionError,
        oneshot::Sender<Result<LoginResult, String>>,
    ),
> {
    let user_name = credentials.user_name.trim().to_string();
    if user_name.is_empty() {
        return Err((
            ConnectionError::Authentication(
                "A user name is required, including for guest login.".into(),
            ),
            reply,
        ));
    }

    let password = Zeroizing::new(credentials.password);
    if password.is_empty() {
        let command = login_command(commands, user_name.clone(), None, None);
        if let Err(error) = socket.send_command(&command).await {
            return Err((error, reply));
        }
        return Ok(LoginAttempt {
            user_name,
            phase: LoginPhase::AwaitingLogin,
            started_at: Instant::now(),
            reply,
        });
    }

    if server.supports_password_hash {
        let command = commands.prepare_request_password_salt(user_name.clone());
        if let Err(error) = socket.send_command(&command).await {
            return Err((error, reply));
        }
        return Ok(LoginAttempt {
            user_name,
            phase: LoginPhase::AwaitingSalt { password },
            started_at: Instant::now(),
            reply,
        });
    }

    if server.transport != "wss" {
        return Err((
            ConnectionError::Authentication(format!(
                "Account login refused: {} does not support password hashing and {} is not encrypted. Use WSS or leave the password empty for guest access.",
                server.server_name,
                server.transport.to_uppercase()
            )),
            reply,
        ));
    }

    let command = login_command(
        commands,
        user_name.clone(),
        Some(password.to_string()),
        None,
    );
    if let Err(error) = socket.send_command(&command).await {
        return Err((error, reply));
    }
    Ok(LoginAttempt {
        user_name,
        phase: LoginPhase::AwaitingLogin,
        started_at: Instant::now(),
        reply,
    })
}

async fn continue_after_password_salt(
    socket: &mut CockatriceSocket,
    commands: &mut CommandTracker,
    response: &Response,
    attempt: &mut LoginAttempt,
) -> Result<(), ConnectionError> {
    if response.response_code.unwrap_or_default() != 1 {
        return Err(ConnectionError::Authentication(login_error_message(
            response,
        )));
    }

    let password = match &attempt.phase {
        LoginPhase::AwaitingSalt { password } => password,
        LoginPhase::AwaitingLogin => {
            return Err(ConnectionError::Authentication(
                "Received an unexpected password-salt response.".into(),
            ));
        }
    };
    let salt = response
        .password_salt
        .as_ref()
        .and_then(|payload| payload.password_salt.as_deref())
        .unwrap_or_default();

    // Servatrice returns an empty salt for an unknown user when guest access is
    // allowed. Cockatrice intentionally retries that name without a password.
    let hashed_password = if salt.is_empty() {
        None
    } else {
        Some(cockatrice_password_hash(password, salt))
    };
    let command = login_command(commands, attempt.user_name.clone(), None, hashed_password);
    socket.send_command(&command).await?;
    attempt.phase = LoginPhase::AwaitingLogin;
    attempt.started_at = Instant::now();
    Ok(())
}

fn login_command(
    commands: &mut CommandTracker,
    user_name: String,
    password: Option<String>,
    hashed_password: Option<String>,
) -> CommandContainer {
    commands.prepare_login(
        user_name,
        password,
        hashed_password,
        format!("novatable-{}", Uuid::new_v4()),
        format!("NovaTable {}", env!("CARGO_PKG_VERSION")),
        cockatrice_client_features(),
    )
}

fn cockatrice_client_features() -> Vec<String> {
    [
        "client_id",
        "client_ver",
        "feature_set",
        "user_ban_history",
        "room_chat_history",
        "client_warnings",
        "mod_log_lookup",
        "idle_client",
        "forgot_password",
        "websocket",
        "2.7.0_min_version",
        "2.8.0_min_version",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn room_info_from_wire(room: ServerInfoRoom) -> RoomInfo {
    RoomInfo {
        room_id: room.room_id.unwrap_or(-1),
        name: room.name.unwrap_or_else(|| "Unnamed room".into()),
        description: room.description.unwrap_or_default(),
        game_count: room.game_count.unwrap_or_default(),
        player_count: room.player_count.unwrap_or_default(),
        auto_join: room.auto_join.unwrap_or(false),
        game_types: room
            .game_type_list
            .into_iter()
            .filter_map(|game_type| game_type.description)
            .collect(),
        permission_level: room.permission_level.unwrap_or_default(),
    }
}

fn room_session_from_wire(mut room: ServerInfoRoom) -> RoomSession {
    let users = std::mem::take(&mut room.user_list)
        .into_iter()
        .map(user_summary_from_wire)
        .collect();
    let games = std::mem::take(&mut room.game_list)
        .into_iter()
        .map(game_info_from_wire)
        .collect();
    RoomSession {
        room: room_info_from_wire(room),
        users,
        games,
    }
}

fn user_summary_from_wire(user: ServerInfoUser) -> UserSummary {
    let user_level = user.user_level.unwrap_or_default();
    UserSummary {
        name: user.name.unwrap_or_else(|| "Unknown user".into()),
        user_level,
        registered: user_level & 2 == 2,
        country: user.country.unwrap_or_default(),
    }
}

fn game_info_from_wire(game: ServerInfoGame) -> GameInfo {
    GameInfo {
        game_id: game.game_id.unwrap_or(-1),
        room_id: game.room_id.unwrap_or(-1),
        description: game.description.unwrap_or_else(|| "Untitled game".into()),
        creator_name: game
            .creator_info
            .and_then(|creator| creator.name)
            .unwrap_or_else(|| "Unknown host".into()),
        with_password: game.with_password.unwrap_or(false),
        max_players: game.max_players.unwrap_or_default(),
        player_count: game.player_count.unwrap_or_default(),
        spectator_count: game.spectators_count.unwrap_or_default(),
        spectators_allowed: game.spectators_allowed.unwrap_or(false),
        spectators_need_password: game.spectators_need_password.unwrap_or(false),
        only_registered: game.only_registered.unwrap_or(false),
        started: game.started.unwrap_or(false),
        closed: game.closed.unwrap_or(false),
        game_type_ids: game.game_types,
    }
}

fn game_session_from_wire(joined: EventGameJoined) -> Result<GameSession, String> {
    let game = joined
        .game_info
        .ok_or_else(|| "The server accepted the game join without game details.".to_string())?;
    Ok(GameSession {
        game: game_info_from_wire(game),
        host_id: joined.host_id.unwrap_or(-1),
        player_id: joined.player_id.unwrap_or(-1),
        spectator: joined.spectator.unwrap_or(false),
        judge: joined.judge.unwrap_or(false),
        resuming: joined.resuming.unwrap_or(false),
    })
}

fn finish_join_room(response: &Response, requested_room_id: u32) -> Result<RoomSession, String> {
    let code = response.response_code.unwrap_or_default();
    if code != 1 {
        return Err(format!(
            "Could not join room {requested_room_id} (response {code}): {}.",
            response_code_explanation(code)
        ));
    }

    let room = response
        .join_room
        .as_ref()
        .and_then(|payload| payload.room_info.clone())
        .ok_or_else(|| {
            "The server accepted the room join without returning room data.".to_string()
        })?;
    Ok(room_session_from_wire(room))
}

fn finish_login(
    response: &Response,
    requested_user_name: &str,
    server_name: &str,
) -> Result<LoginResult, String> {
    if response.response_code.unwrap_or_default() != 1 {
        return Err(login_error_message(response));
    }

    let login = response.login.as_ref();
    let user = login.and_then(|payload| payload.user_info.as_ref());
    let user_name = user
        .and_then(|info| info.name.clone())
        .unwrap_or_else(|| requested_user_name.to_string());
    let user_level = user.and_then(|info| info.user_level).unwrap_or_default();

    Ok(LoginResult {
        user_name,
        user_level,
        registered: user_level & 2 == 2,
        server_name: server_name.to_string(),
        missing_features: login
            .map(|payload| payload.missing_features.clone())
            .unwrap_or_default(),
    })
}

fn login_error_message(response: &Response) -> String {
    let code = response.response_code.unwrap_or_default();
    let explanation = response_code_explanation(code);

    let login = response.login.as_ref();
    let reason = login
        .and_then(|payload| payload.denied_reason_str.as_deref())
        .filter(|reason| !reason.trim().is_empty());
    let missing = login
        .map(|payload| payload.missing_features.as_slice())
        .unwrap_or_default();

    let mut message = format!("Login failed (response {code}): {explanation}.");
    if let Some(reason) = reason {
        message.push_str(&format!(" Server reason: {reason}."));
    }
    if !missing.is_empty() {
        message.push_str(&format!(" Missing features: {}.", missing.join(", ")));
    }
    message
}

fn response_code_explanation(code: i32) -> &'static str {
    match code {
        -1 => "the session is no longer connected",
        2 => "the session is not in that room",
        3 => "the server encountered an internal error",
        4 => "the server rejected the command",
        5 => "the request data is invalid",
        6 => "the requested room or user was not found",
        7 => "authentication is required",
        8 => "this operation is not allowed",
        9 => "the game has not started",
        10 => "the game is full",
        11 => "the server reports a conflicting room or game context",
        12 => "the password is incorrect",
        13 => "spectators are not allowed",
        14 => "this game is limited to the host's buddies",
        15 => "your account does not have permission to enter",
        17 => "another active session would be replaced; retry after closing it",
        19 => "this user or address is banned",
        20 => "access was denied",
        21 => "the user name is invalid",
        22 => "this server requires a registered account",
        23 => "registration was accepted",
        24 => "that user name already exists",
        25 => "an email address is required",
        26 => "too many requests were sent; try again later",
        27 => "the password is too short",
        28 => "the account has not been activated",
        29 => "registration is disabled on this server",
        30 => "the server could not complete registration",
        31 => "account activation was accepted",
        32 => "the activation code is invalid or expired",
        33 => "registration was accepted and requires activation",
        34 => "the server requires a client identifier",
        35 => "the client is missing features required by the server",
        36 => "the server is full",
        37 => "the email provider is not allowed by this server",
        _ => "the server rejected the request",
    }
}

fn is_transport_error(error: &ConnectionError) -> bool {
    matches!(
        error,
        ConnectionError::Io(_)
            | ConnectionError::WebSocket(_)
            | ConnectionError::Frame(_)
            | ConnectionError::Protocol(_)
            | ConnectionError::ClosedBeforeIdentification
    )
}

fn identification_message(server_name: &str, protocol_version: u32) -> ServerMessage {
    ServerMessage {
        message_type: Some(1),
        response: None,
        session_event: Some(SessionEvent {
            server_identification: Some(EventServerIdentification {
                server_name: Some(server_name.into()),
                server_version: Some("2026.07".into()),
                protocol_version: Some(protocol_version),
                server_options: Some(1),
            }),
            ..Default::default()
        }),
        game_event_container: None,
        room_event: None,
    }
}

fn build_probe_result(
    host: String,
    port: u16,
    transport: ResolvedTransport,
    started_at: Instant,
    identification: EventServerIdentification,
) -> ProbeResult {
    let protocol_version = identification.protocol_version.unwrap_or_default();
    ProbeResult {
        host,
        port,
        transport: transport.label().into(),
        server_name: identification
            .server_name
            .unwrap_or_else(|| "Cockatrice server".into()),
        server_version: identification.server_version.unwrap_or_default(),
        protocol_version,
        supported_protocol_version: SUPPORTED_PROTOCOL_VERSION,
        supports_password_hash: identification.server_options.unwrap_or_default() & 1 == 1,
        compatible: protocol_version == SUPPORTED_PROTOCOL_VERSION,
        latency_ms: started_at.elapsed().as_millis() as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cockatrice::protocol::wire::{
        EventJoinRoom, EventListGames, EventListRooms, EventRoomSay, ResponseJoinRoom,
    };
    use tokio_tungstenite::accept_hdr_async;
    use tokio_tungstenite::tungstenite::handshake::server::{
        Request, Response as HandshakeResponse,
    };

    async fn spawn_tcp_fixture(protocol_version: u32) -> (u16, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut handshake = [1_u8; 4];
            socket.read_exact(&mut handshake).await.unwrap();
            assert_eq!(handshake, [0, 0, 0, 0]);
            let message = identification_message("Fixture Servatrice", protocol_version);
            socket
                .write_all(&encode_frame(&message.encode_to_vec()).unwrap())
                .await
                .unwrap();
        });
        (port, server)
    }

    #[tokio::test]
    async fn probes_a_v14_tcp_server_end_to_end() {
        let (port, server) = spawn_tcp_fixture(SUPPORTED_PROTOCOL_VERSION).await;
        let result = probe_server(ServerProfile {
            host: "127.0.0.1".into(),
            port,
            transport: TransportPreference::Tcp,
        })
        .await
        .unwrap();

        assert!(result.compatible);
        assert!(result.supports_password_hash);
        assert_eq!(result.server_name, "Fixture Servatrice");
        assert_eq!(result.protocol_version, 14);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn probes_a_v14_websocket_server_end_to_end() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let callback = |request: &Request, response: HandshakeResponse| {
                assert_eq!(request.uri().path(), "/servatrice");
                Ok(response)
            };
            let mut websocket = accept_hdr_async(socket, callback).await.unwrap();
            websocket
                .send(WebSocketMessage::Binary(
                    identification_message("Fixture Servatrice", SUPPORTED_PROTOCOL_VERSION)
                        .encode_to_vec()
                        .into(),
                ))
                .await
                .unwrap();
        });

        let result = probe_server(ServerProfile {
            host: "127.0.0.1".into(),
            port,
            transport: TransportPreference::Ws,
        })
        .await
        .unwrap();

        assert!(result.compatible);
        assert_eq!(result.transport, "ws");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn runs_the_built_in_self_test() {
        let result = run_protocol_self_test().await.unwrap();
        assert!(result.compatible);
        assert_eq!(result.server_name, "NovaTable protocol fixture");
    }

    #[tokio::test]
    async fn keeps_and_explicitly_closes_a_session() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut handshake = [0_u8; 4];
            socket.read_exact(&mut handshake).await.unwrap();
            socket
                .write_all(
                    &encode_frame(
                        &identification_message("Persistent fixture", 14).encode_to_vec(),
                    )
                    .unwrap(),
                )
                .await
                .unwrap();

            let mut closed = [0_u8; 1];
            assert_eq!(socket.read(&mut closed).await.unwrap(), 0);
        });

        let state = CockatriceConnectionState::default();
        let result = state
            .connect(ServerProfile {
                host: "127.0.0.1".into(),
                port,
                transport: TransportPreference::Tcp,
            })
            .await
            .unwrap();
        assert_eq!(result.server_name, "Persistent fixture");
        assert_eq!(state.snapshot().await.phase, "connected");

        state.disconnect().await;
        assert_eq!(state.snapshot().await.phase, "offline");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn logs_in_a_guest_without_sending_password_fields() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_fixture_frame(&mut socket).await.unwrap().is_empty());
            socket
                .write_all(
                    &encode_frame(&identification_message("Guest fixture", 14).encode_to_vec())
                        .unwrap(),
                )
                .await
                .unwrap();

            let command =
                CommandContainer::decode(read_fixture_frame(&mut socket).await.unwrap().as_slice())
                    .unwrap();
            let login = command.session_command[0].login.as_ref().unwrap();
            assert_eq!(login.user_name.as_deref(), Some("DraftGuest"));
            assert!(login.password.is_none());
            assert!(login.hashed_password.is_none());

            write_fixture_response(
                &mut socket,
                Response {
                    cmd_id: command.cmd_id,
                    response_code: Some(1),
                    login: Some(ResponseLogin {
                        user_info: Some(ServerInfoUser {
                            name: Some("DraftGuest".into()),
                            user_level: Some(1),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

            let mut closed = [0_u8; 1];
            assert_eq!(socket.read(&mut closed).await.unwrap(), 0);
        });

        let state = CockatriceConnectionState::default();
        state
            .connect(ServerProfile {
                host: "127.0.0.1".into(),
                port,
                transport: TransportPreference::Tcp,
            })
            .await
            .unwrap();
        let login = state
            .login(LoginCredentials {
                user_name: " DraftGuest ".into(),
                password: String::new(),
            })
            .await
            .unwrap();

        assert_eq!(login.user_name, "DraftGuest");
        assert!(!login.registered);
        assert_eq!(state.snapshot().await.phase, "authenticated");
        state.disconnect().await;
        server.await.unwrap();
    }

    #[tokio::test]
    async fn refuses_legacy_plaintext_login_before_sending_a_command() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_fixture_frame(&mut socket).await.unwrap().is_empty());
            let mut identification = identification_message("Legacy fixture", 14);
            identification
                .session_event
                .as_mut()
                .unwrap()
                .server_identification
                .as_mut()
                .unwrap()
                .server_options = Some(0);
            socket
                .write_all(&encode_frame(&identification.encode_to_vec()).unwrap())
                .await
                .unwrap();

            let mut closed = [0_u8; 1];
            assert_eq!(socket.read(&mut closed).await.unwrap(), 0);
        });

        let state = CockatriceConnectionState::default();
        state
            .connect(ServerProfile {
                host: "127.0.0.1".into(),
                port,
                transport: TransportPreference::Tcp,
            })
            .await
            .unwrap();
        let error = state
            .login(LoginCredentials {
                user_name: "AccountUser".into(),
                password: "must-not-travel".into(),
            })
            .await
            .unwrap_err();

        assert!(error.to_string().contains("Account login refused"));
        assert_eq!(state.snapshot().await.phase, "connected");
        state.disconnect().await;
        server.await.unwrap();
    }

    #[tokio::test]
    async fn registers_an_account_with_a_fresh_hashed_password() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_fixture_frame(&mut socket).await.unwrap().is_empty());
            socket
                .write_all(
                    &encode_frame(
                        &identification_message("Registration fixture", 14).encode_to_vec(),
                    )
                    .unwrap(),
                )
                .await
                .unwrap();

            let command =
                CommandContainer::decode(read_fixture_frame(&mut socket).await.unwrap().as_slice())
                    .unwrap();
            let registration = command.session_command[0].register.as_ref().unwrap();
            assert_eq!(registration.user_name, "NewMage");
            assert_eq!(registration.email.as_deref(), Some("mage@example.test"));
            assert!(registration.password.is_none());
            let hashed = registration.hashed_password.as_deref().unwrap();
            assert_eq!(hashed, cockatrice_password_hash("secret123", &hashed[..16]));

            write_fixture_response(
                &mut socket,
                Response {
                    cmd_id: command.cmd_id,
                    response_code: Some(23),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let mut closed = [0_u8; 1];
            assert_eq!(socket.read(&mut closed).await.unwrap(), 0);
        });

        let state = CockatriceConnectionState::default();
        state
            .connect(ServerProfile {
                host: "127.0.0.1".into(),
                port,
                transport: TransportPreference::Tcp,
            })
            .await
            .unwrap();
        let result = state
            .register(RegistrationRequest {
                user_name: " NewMage ".into(),
                password: "secret123".into(),
                email: "mage@example.test".into(),
                country: "IT".into(),
                real_name: String::new(),
            })
            .await
            .unwrap();

        assert_eq!(result.user_name, "NewMage");
        assert!(!result.requires_activation);
        state.disconnect().await;
        server.await.unwrap();
    }

    #[tokio::test]
    async fn activates_an_account_with_the_email_token() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_fixture_frame(&mut socket).await.unwrap().is_empty());
            socket
                .write_all(
                    &encode_frame(
                        &identification_message("Activation fixture", 14).encode_to_vec(),
                    )
                    .unwrap(),
                )
                .await
                .unwrap();

            let command =
                CommandContainer::decode(read_fixture_frame(&mut socket).await.unwrap().as_slice())
                    .unwrap();
            let activation = command.session_command[0].activate.as_ref().unwrap();
            assert_eq!(activation.user_name, "NewMage");
            assert_eq!(activation.token, "email-token");
            assert!(activation
                .client_id
                .as_deref()
                .is_some_and(|client_id| !client_id.is_empty()));

            write_fixture_response(
                &mut socket,
                Response {
                    cmd_id: command.cmd_id,
                    response_code: Some(31),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let mut closed = [0_u8; 1];
            assert_eq!(socket.read(&mut closed).await.unwrap(), 0);
        });

        let state = CockatriceConnectionState::default();
        state
            .connect(ServerProfile {
                host: "127.0.0.1".into(),
                port,
                transport: TransportPreference::Tcp,
            })
            .await
            .unwrap();
        let result = state
            .activate(ActivationRequest {
                user_name: " NewMage ".into(),
                token: " email-token ".into(),
            })
            .await
            .unwrap();

        assert_eq!(result.user_name, "NewMage");
        assert!(result.message.contains("activated"));
        state.disconnect().await;
        server.await.unwrap();
    }

    #[tokio::test]
    async fn decodes_a_room_list_after_login() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_fixture_frame(&mut socket).await.unwrap().is_empty());
            socket
                .write_all(
                    &encode_frame(&identification_message("Lobby fixture", 14).encode_to_vec())
                        .unwrap(),
                )
                .await
                .unwrap();

            let login =
                CommandContainer::decode(read_fixture_frame(&mut socket).await.unwrap().as_slice())
                    .unwrap();
            write_fixture_response(
                &mut socket,
                Response {
                    cmd_id: login.cmd_id,
                    response_code: Some(1),
                    login: Some(ResponseLogin {
                        user_info: Some(ServerInfoUser {
                            name: Some("LobbyGuest".into()),
                            user_level: Some(1),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

            let list =
                CommandContainer::decode(read_fixture_frame(&mut socket).await.unwrap().as_slice())
                    .unwrap();
            assert!(list.session_command[0].list_rooms.is_some());
            let event = ServerMessage {
                message_type: Some(1),
                session_event: Some(SessionEvent {
                    list_rooms: Some(EventListRooms {
                        room_list: vec![ServerInfoRoom {
                            room_id: Some(7),
                            name: Some("Modern".into()),
                            description: Some("Open constructed games".into()),
                            game_count: Some(12),
                            player_count: Some(34),
                            auto_join: Some(false),
                            permission_level: Some("none".into()),
                            ..Default::default()
                        }],
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            };
            socket
                .write_all(&encode_frame(&event.encode_to_vec()).unwrap())
                .await
                .unwrap();
            write_fixture_response(
                &mut socket,
                Response {
                    cmd_id: list.cmd_id,
                    response_code: Some(1),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

            let mut closed = [0_u8; 1];
            assert_eq!(socket.read(&mut closed).await.unwrap(), 0);
        });

        let state = CockatriceConnectionState::default();
        state
            .connect(ServerProfile {
                host: "127.0.0.1".into(),
                port,
                transport: TransportPreference::Tcp,
            })
            .await
            .unwrap();
        state
            .login(LoginCredentials {
                user_name: "LobbyGuest".into(),
                password: String::new(),
            })
            .await
            .unwrap();
        let rooms = state.list_rooms().await.unwrap();

        assert_eq!(
            rooms,
            vec![RoomInfo {
                room_id: 7,
                name: "Modern".into(),
                description: "Open constructed games".into(),
                game_count: 12,
                player_count: 34,
                auto_join: false,
                game_types: vec![],
                permission_level: "none".into(),
            }]
        );
        state.disconnect().await;
        server.await.unwrap();
    }

    #[tokio::test]
    async fn joins_and_leaves_a_room_with_games_and_users() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(read_fixture_frame(&mut socket).await.unwrap().is_empty());
            socket
                .write_all(
                    &encode_frame(&identification_message("Room fixture", 14).encode_to_vec())
                        .unwrap(),
                )
                .await
                .unwrap();

            let login =
                CommandContainer::decode(read_fixture_frame(&mut socket).await.unwrap().as_slice())
                    .unwrap();
            write_fixture_response(
                &mut socket,
                Response {
                    cmd_id: login.cmd_id,
                    response_code: Some(1),
                    login: Some(ResponseLogin {
                        user_info: Some(ServerInfoUser {
                            name: Some("RoomGuest".into()),
                            user_level: Some(1),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

            let join =
                CommandContainer::decode(read_fixture_frame(&mut socket).await.unwrap().as_slice())
                    .unwrap();
            assert_eq!(
                join.session_command[0]
                    .join_room
                    .as_ref()
                    .and_then(|command| command.room_id),
                Some(7)
            );
            write_fixture_response(
                &mut socket,
                Response {
                    cmd_id: join.cmd_id,
                    response_code: Some(1),
                    join_room: Some(ResponseJoinRoom {
                        room_info: Some(ServerInfoRoom {
                            room_id: Some(7),
                            name: Some("Modern".into()),
                            description: Some("Constructed room".into()),
                            user_list: vec![ServerInfoUser {
                                name: Some("RoomGuest".into()),
                                user_level: Some(1),
                                country: Some("IT".into()),
                                ..Default::default()
                            }],
                            game_list: vec![ServerInfoGame {
                                room_id: Some(7),
                                game_id: Some(42),
                                description: Some("Best of three".into()),
                                creator_info: Some(ServerInfoUser {
                                    name: Some("HostMage".into()),
                                    ..Default::default()
                                }),
                                max_players: Some(2),
                                player_count: Some(1),
                                spectators_allowed: Some(true),
                                ..Default::default()
                            }],
                            ..Default::default()
                        }),
                    }),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

            let live_event = ServerMessage {
                message_type: Some(3),
                room_event: Some(RoomEvent {
                    room_id: Some(7),
                    join_room: Some(EventJoinRoom {
                        user_info: Some(ServerInfoUser {
                            name: Some("LateArrival".into()),
                            user_level: Some(2),
                            country: Some("DE".into()),
                            ..Default::default()
                        }),
                    }),
                    room_say: Some(EventRoomSay {
                        name: Some("LateArrival".into()),
                        message: Some("Ready to play?".into()),
                        message_type: Some(0),
                        time_of: Some(1_753_900_000),
                    }),
                    list_games: Some(EventListGames {
                        game_list: vec![ServerInfoGame {
                            room_id: Some(7),
                            game_id: Some(43),
                            description: Some("Live updated game".into()),
                            ..Default::default()
                        }],
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            };
            socket
                .write_all(&encode_frame(&live_event.encode_to_vec()).unwrap())
                .await
                .unwrap();

            let join_game =
                CommandContainer::decode(read_fixture_frame(&mut socket).await.unwrap().as_slice())
                    .unwrap();
            let join_game_payload = join_game.room_command[0].join_game.as_ref().unwrap();
            assert_eq!(join_game.room_id, Some(7));
            assert_eq!(join_game_payload.game_id, Some(42));
            assert_eq!(join_game_payload.spectator, Some(false));
            write_fixture_response(
                &mut socket,
                Response {
                    cmd_id: join_game.cmd_id,
                    response_code: Some(1),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let joined = ServerMessage {
                message_type: Some(1),
                session_event: Some(SessionEvent {
                    game_joined: Some(EventGameJoined {
                        game_info: Some(ServerInfoGame {
                            room_id: Some(7),
                            game_id: Some(42),
                            description: Some("Best of three".into()),
                            creator_info: Some(ServerInfoUser {
                                name: Some("HostMage".into()),
                                ..Default::default()
                            }),
                            max_players: Some(2),
                            player_count: Some(2),
                            spectators_allowed: Some(true),
                            ..Default::default()
                        }),
                        host_id: Some(0),
                        player_id: Some(1),
                        spectator: Some(false),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            };
            socket
                .write_all(&encode_frame(&joined.encode_to_vec()).unwrap())
                .await
                .unwrap();

            let say =
                CommandContainer::decode(read_fixture_frame(&mut socket).await.unwrap().as_slice())
                    .unwrap();
            assert_eq!(say.room_id, Some(7));
            assert_eq!(
                say.room_command[0]
                    .room_say
                    .as_ref()
                    .and_then(|command| command.message.as_deref()),
                Some("Hello room")
            );
            write_fixture_response(
                &mut socket,
                Response {
                    cmd_id: say.cmd_id,
                    response_code: Some(1),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

            let leave =
                CommandContainer::decode(read_fixture_frame(&mut socket).await.unwrap().as_slice())
                    .unwrap();
            assert_eq!(leave.room_id, Some(7));
            assert!(leave.room_command[0].leave_room.is_some());
            write_fixture_response(
                &mut socket,
                Response {
                    cmd_id: leave.cmd_id,
                    response_code: Some(1),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

            let mut closed = [0_u8; 1];
            assert_eq!(socket.read(&mut closed).await.unwrap(), 0);
        });

        let state = CockatriceConnectionState::default();
        state
            .connect(ServerProfile {
                host: "127.0.0.1".into(),
                port,
                transport: TransportPreference::Tcp,
            })
            .await
            .unwrap();
        state
            .login(LoginCredentials {
                user_name: "RoomGuest".into(),
                password: String::new(),
            })
            .await
            .unwrap();

        let room = state.join_room(7).await.unwrap();
        assert_eq!(room.room.name, "Modern");
        assert_eq!(room.users[0].country, "IT");
        assert_eq!(room.games[0].game_id, 42);
        assert_eq!(room.games[0].creator_name, "HostMage");

        let live = timeout(Duration::from_secs(1), async {
            loop {
                let live = state.live_room().await;
                if !live.messages.is_empty() {
                    break live;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(live.session.as_ref().unwrap().users.len(), 2);
        assert_eq!(live.session.as_ref().unwrap().games[0].game_id, 43);
        assert_eq!(live.messages[0].message, "Ready to play?");

        let game = state.join_game(7, 42, String::new(), false).await.unwrap();
        assert_eq!(game.game.description, "Best of three");
        assert_eq!(game.player_id, 1);
        assert!(!game.spectator);

        state
            .send_room_message(7, " Hello room ".into())
            .await
            .unwrap();
        state.leave_room(7).await.unwrap();
        assert!(state.live_room().await.session.is_none());
        state.disconnect().await;
        server.await.unwrap();
    }

    #[test]
    fn auto_transport_matches_cockatrice_port_conventions() {
        assert_eq!(
            ResolvedTransport::resolve(TransportPreference::Auto, 4747),
            ResolvedTransport::Tcp
        );
        assert_eq!(
            ResolvedTransport::resolve(TransportPreference::Auto, 4748),
            ResolvedTransport::Ws
        );
        assert_eq!(
            ResolvedTransport::resolve(TransportPreference::Auto, 443),
            ResolvedTransport::Wss
        );
    }

    #[test]
    fn explicit_transport_overrides_port_conventions() {
        assert_eq!(
            ResolvedTransport::resolve(TransportPreference::Tcp, 443),
            ResolvedTransport::Tcp
        );
        assert_eq!(
            ResolvedTransport::resolve(TransportPreference::Wss, 4747),
            ResolvedTransport::Wss
        );
    }
}
