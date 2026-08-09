pub mod cockatrice;

use cockatrice::{
    probe_server, run_protocol_self_test, ActivationRequest, ActivationResult,
    CockatriceConnectionState, ConnectionSnapshot, GameSession, LiveRoomState, LoginCredentials,
    LoginResult, ProbeResult, RegistrationRequest, RegistrationResult, RoomInfo, RoomSession,
    ServerProfile,
};
use tauri::State;
use tauri_plugin_updater::UpdaterExt;

#[tauri::command]
async fn probe_cockatrice(
    profile: ServerProfile,
    connection: State<'_, CockatriceConnectionState>,
) -> Result<ProbeResult, String> {
    connection.set_probing().await;

    match probe_server(profile).await {
        Ok(result) => {
            connection.set_result(result.clone()).await;
            Ok(result)
        }
        Err(error) => {
            let message = error.to_string();
            connection.set_error(message.clone()).await;
            Err(message)
        }
    }
}

#[tauri::command]
async fn cockatrice_connection_status(
    connection: State<'_, CockatriceConnectionState>,
) -> Result<ConnectionSnapshot, String> {
    Ok(connection.snapshot().await)
}

#[tauri::command]
async fn connect_cockatrice(
    profile: ServerProfile,
    connection: State<'_, CockatriceConnectionState>,
) -> Result<ProbeResult, String> {
    connection
        .connect(profile)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn disconnect_cockatrice(
    connection: State<'_, CockatriceConnectionState>,
) -> Result<(), String> {
    connection.disconnect().await;
    Ok(())
}

#[tauri::command]
async fn login_cockatrice(
    credentials: LoginCredentials,
    connection: State<'_, CockatriceConnectionState>,
) -> Result<LoginResult, String> {
    connection
        .login(credentials)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_cockatrice_rooms(
    connection: State<'_, CockatriceConnectionState>,
) -> Result<Vec<RoomInfo>, String> {
    connection
        .list_rooms()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn register_cockatrice_account(
    registration: RegistrationRequest,
    connection: State<'_, CockatriceConnectionState>,
) -> Result<RegistrationResult, String> {
    connection
        .register(registration)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn activate_cockatrice_account(
    activation: ActivationRequest,
    connection: State<'_, CockatriceConnectionState>,
) -> Result<ActivationResult, String> {
    connection
        .activate(activation)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn join_cockatrice_room(
    room_id: u32,
    connection: State<'_, CockatriceConnectionState>,
) -> Result<RoomSession, String> {
    connection
        .join_room(room_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn leave_cockatrice_room(
    room_id: u32,
    connection: State<'_, CockatriceConnectionState>,
) -> Result<(), String> {
    connection
        .leave_room(room_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn cockatrice_live_room(
    connection: State<'_, CockatriceConnectionState>,
) -> Result<LiveRoomState, String> {
    Ok(connection.live_room().await)
}

#[tauri::command]
async fn send_cockatrice_room_message(
    room_id: u32,
    message: String,
    connection: State<'_, CockatriceConnectionState>,
) -> Result<(), String> {
    connection
        .send_room_message(room_id, message)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn join_cockatrice_game(
    room_id: u32,
    game_id: i32,
    password: String,
    spectator: bool,
    connection: State<'_, CockatriceConnectionState>,
) -> Result<GameSession, String> {
    connection
        .join_game(room_id, game_id, password, spectator)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn cockatrice_protocol_self_test() -> Result<ProbeResult, String> {
    run_protocol_self_test()
        .await
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let Ok(updater) = handle.updater() else { return };
                let Ok(Some(update)) = updater.check().await else { return };
                if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
                    handle.restart();
                }
            });
            Ok(())
        })
        .manage(CockatriceConnectionState::default())
        .invoke_handler(tauri::generate_handler![
            probe_cockatrice,
            cockatrice_connection_status,
            connect_cockatrice,
            disconnect_cockatrice,
            login_cockatrice,
            list_cockatrice_rooms,
            register_cockatrice_account,
            activate_cockatrice_account,
            join_cockatrice_room,
            leave_cockatrice_room,
            cockatrice_live_room,
            send_cockatrice_room_message,
            join_cockatrice_game,
            cockatrice_protocol_self_test
        ])
        .run(tauri::generate_context!())
        .expect("error while running NovaTable");
}
