use novatable_lib::cockatrice::connection::{
    CockatriceConnectionState, LoginCredentials, ServerProfile, TransportPreference,
};
use uuid::Uuid;

#[tokio::main]
async fn main() {
    let host = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "server.cockatrice.us".into());
    let port = std::env::args()
        .nth(2)
        .and_then(|value| value.parse().ok())
        .unwrap_or(443);
    let transport = if port == 443 {
        TransportPreference::Wss
    } else {
        TransportPreference::Auto
    };

    let state = CockatriceConnectionState::default();
    match state
        .connect(ServerProfile {
            host,
            port,
            transport,
        })
        .await
    {
        Ok(server) => {
            println!(
                "{} | protocol v{} | {} | {} ms | password hash: {}",
                server.server_name,
                server.protocol_version,
                server.transport,
                server.latency_ms,
                server.supports_password_hash
            );
            if std::env::args().any(|argument| argument == "--guest") {
                let suffix = &Uuid::new_v4().simple().to_string()[..8];
                match state
                    .login(LoginCredentials {
                        user_name: format!("NovaTableProbe{suffix}"),
                        password: String::new(),
                    })
                    .await
                {
                    Ok(login) => {
                        let rooms = state.list_rooms().await.expect("room listing failed");
                        println!(
                            "guest {} authenticated | {} rooms visible",
                            login.user_name,
                            rooms.len()
                        );
                    }
                    Err(error) => println!("guest rejected by server | {error}"),
                }
            }
            state.disconnect().await;
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
