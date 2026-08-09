import { useState } from "react";
import { Check, Database, Download, HardDrive, Image, X } from "lucide-react";
import { installCardDatabase } from "../../infrastructure/cardDatabase";

export function CardDatabaseSetup({ onComplete, onDismiss }: { onComplete: () => void; onDismiss: () => void }) {
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("Ready to install");
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  async function download() {
    setError(null);
    setDownloading(true);
    try {
      await installCardDatabase((nextProgress, nextMessage) => {
        setProgress(Math.min(100, nextProgress));
        setMessage(nextMessage);
      });
      window.setTimeout(onComplete, 450);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setDownloading(false);
    }
  }

  return <div className="card-download-backdrop" role="dialog" aria-modal="true" aria-labelledby="card-download-title">
    <section className="card-download-modal">
      <button className="card-download-close" onClick={onDismiss} disabled={downloading} aria-label="Not now"><X size={20} /></button>
      <span className="card-download-icon"><Database size={32} /></span>
      <span className="kicker">First-time setup</span>
      <h2 id="card-download-title">Install the Magic card library</h2>
      <p>Download the complete Oracle card catalog so NovaTable can identify decks, show rules and display real card artwork while you play.</p>
      <div className="card-download-benefits">
        <span><HardDrive size={18} /><strong>Offline catalog</strong><small>Names, rules, mana costs and types</small></span>
        <span><Image size={18} /><strong>Real card artwork</strong><small>Artwork loads from its catalog URL when shown</small></span>
        <span><Check size={18} /><strong>Download once</strong><small>NovaTable remembers the installed version</small></span>
      </div>
      {downloading && <div className="card-download-progress"><div><span style={{ width: `${progress}%` }} /></div><strong>{progress}%</strong><p>{message}</p></div>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      <footer>
        <button className="secondary-button" onClick={onDismiss} disabled={downloading}>Not now</button>
        <button className="primary-button" onClick={() => void download()} disabled={downloading || progress === 100}><Download size={18} />{downloading ? "Installing…" : "Download card library"}</button>
      </footer>
      <small className="card-source-note">Card data and imagery are provided by Scryfall. Images are cached by the system webview as they are displayed.</small>
    </section>
  </div>;
}
