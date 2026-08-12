import { useEffect, useState } from "react";
import type { GameSetupPlayer } from "../domain/commander/types";
import type { UserProfile } from "../domain/platform/types";
import { AuthScreen } from "../features/auth/AuthScreen";
import { CommanderBoard } from "../features/game/CommanderBoard";
import { CardDatabaseSetup } from "../features/platform/CardDatabaseSetup";
import { PlatformApp } from "../features/platform/PlatformApp";
import { isCardDatabaseInstalled } from "../infrastructure/cardDatabase";
import { currentUser, logoutAccount, refreshCurrentProfile } from "../infrastructure/localPlatform";

interface ActiveGame {
  players: GameSetupPlayer[];
  startingLife: number;
  lobbyName: string;
  gameId: string;
  seed: number;
}

export function App() {
  const [user, setUser] = useState<UserProfile | null>(() => currentUser());
  const [game, setGame] = useState<ActiveGame | null>(null);
  const [cardSetupOpen, setCardSetupOpen] = useState(() => !isCardDatabaseInstalled());

  useEffect(() => {
    document.documentElement.dataset.theme = user?.theme ?? "dark";
  }, [user?.theme]);

  useEffect(() => { if (user) void refreshCurrentProfile().then((fresh) => fresh && setUser(fresh)).catch(() => {}); }, [user?.id]);

  const content = !user
    ? <AuthScreen onAuthenticated={setUser} />
    : game
      ? <CommanderBoard {...game} onLeave={(updatedUser) => { if (updatedUser) setUser(updatedUser); setGame(null); }} />
      : <PlatformApp user={user} onLogout={() => { logoutAccount(); setUser(null); }}
          onUserUpdated={setUser}
          onStartGame={(players, startingLife, lobbyName, gameId, seed) => setGame({ players, startingLife, lobbyName, gameId, seed })} />;

  return <>{content}{cardSetupOpen && <CardDatabaseSetup onComplete={() => setCardSetupOpen(false)} onDismiss={() => setCardSetupOpen(false)} />}</>;
}
