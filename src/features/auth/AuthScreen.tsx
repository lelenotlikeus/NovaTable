import { type FormEvent, useState } from "react";
import { ArrowRight, Check, Gamepad2, LockKeyhole, Mail, UserRound } from "lucide-react";
import { loginAccount, registerAccount } from "../../infrastructure/localPlatform";
import type { UserProfile } from "../../domain/platform/types";

export function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: UserProfile) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [identity, setIdentity] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(null); setLoading(true);
    try {
      const user = mode === "login"
        ? await loginAccount(identity, password)
        : await registerAccount({ email, username, displayName, password });
      onAuthenticated(user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setLoading(false); }
  }

  return (
    <main className="auth-screen">
      <section className="auth-story">
        <div className="brand-lockup"><img src="/novatable-logo.svg" alt="" /><strong>NovaTable</strong></div>
        <div className="auth-story__copy">
          <span className="kicker">Magic, around one shared table</span>
          <h1>Your next Commander night starts here.</h1>
          <p>Create a lobby, bring your deck, and play with the freedom of a real tabletop.</p>
          <ul>
            <li><Check size={15} /> One permanent NovaTable account</li>
            <li><Check size={15} /> Private lobbies and friend invites</li>
            <li><Check size={15} /> Manual, permissive Commander play</li>
          </ul>
        </div>
        <div className="auth-party-card">
          <Gamepad2 size={18} /><div><strong>Commander pod online</strong><span>3 friends are ready to play</span></div>
          <div className="mini-avatars"><i>MV</i><i>OR</i><i>NI</i></div>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-panel__inner">
          <span className="kicker">{mode === "login" ? "Welcome back" : "Join NovaTable"}</span>
          <h2>{mode === "login" ? "Sign in to play" : "Create your account"}</h2>
          <p>{mode === "login" ? "Your friends and decks are waiting." : "One identity for every lobby and game."}</p>
          <div className="auth-tabs">
            <button className={mode === "login" ? "is-active" : ""} onClick={() => { setMode("login"); setError(null); }}>Login</button>
            <button className={mode === "register" ? "is-active" : ""} onClick={() => { setMode("register"); setError(null); }}>Register</button>
          </div>
          <form onSubmit={submit} className="auth-fields">
            {mode === "login" ? (
              <label>Email or username<span><UserRound size={15} /><input value={identity} onChange={(event) => setIdentity(event.target.value)} autoComplete="username" required /></span></label>
            ) : (
              <>
                <label>Email<span><Mail size={15} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></span></label>
                <label>Username<span><UserRound size={15} /><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></span></label>
                <label>Display name<span><UserRound size={15} /><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" required /></span></label>
              </>
            )}
            <label>Password<span><LockKeyhole size={15} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} required /></span></label>
            {error && <div className="inline-error" role="alert">{error}</div>}
            <button className="primary-button auth-submit" disabled={loading}>
              {loading ? "Please wait…" : mode === "login" ? "Login" : "Create account"}<ArrowRight size={16} />
            </button>
          </form>
          <small className="local-note">Development build: account data is stored locally and the API boundary is ready for a real backend.</small>
        </div>
      </section>
    </main>
  );
}
