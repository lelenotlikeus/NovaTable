import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Minimize2 } from "lucide-react";

export function FullscreenButton() {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    try { void getCurrentWindow().isFullscreen().then(setFullscreen).catch(() => setFullscreen(Boolean(document.fullscreenElement))); }
    catch { setFullscreen(Boolean(document.fullscreenElement)); }
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    const shortcut = (event: KeyboardEvent) => { if (event.key === "F11") { event.preventDefault(); void toggle(); } };
    document.addEventListener("fullscreenchange", changed);
    window.addEventListener("keydown", shortcut);
    return () => { document.removeEventListener("fullscreenchange", changed); window.removeEventListener("keydown", shortcut); };
  }, []);

  async function toggle() {
    let next = !fullscreen;
    try {
      const window = getCurrentWindow();
      next = !(await window.isFullscreen());
      await window.setFullscreen(next);
    }
    catch {
      if (document.fullscreenElement) { await document.exitFullscreen(); next = false; }
      else { await document.documentElement.requestFullscreen(); next = true; }
    }
    setFullscreen(next);
  }

  return <button className="fullscreen-button" onClick={() => void toggle()} title={fullscreen ? "Exit fullscreen" : "Enter fullscreen"} aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>;
}
