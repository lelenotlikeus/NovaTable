import { useEffect, useState } from "react";
import { Check, Image, LoaderCircle, RotateCcw, X } from "lucide-react";
import {
  getCardByName,
  getCardPrintings,
  setPreferredCardPrinting,
  type CardPrinting,
  type CardRecord
} from "../../infrastructure/cardDatabase";

export function useCardRecord(name: string) {
  const [record, setRecord] = useState<CardRecord | null>(null);
  useEffect(() => {
    let active = true;
    function load() {
      setRecord(null);
      if (name) void getCardByName(name).then((value) => { if (active) setRecord(value); });
    }
    function artworkChanged(event: Event) {
      if ((event as CustomEvent<string>).detail === name.toLocaleLowerCase()) load();
    }
    load();
    window.addEventListener("novatable:artwork-changed", artworkChanged);
    return () => { active = false; window.removeEventListener("novatable:artwork-changed", artworkChanged); };
  }, [name]);
  return record;
}

export function CommanderArtwork({ name, compact = false }: { name: string; compact?: boolean }) {
  const card = useCardRecord(name);
  return <span className={`commander-artwork ${compact ? "is-compact" : ""}`}>
    {card?.imageUrl ? <img src={card.imageUrl} alt={name} /> : <><Image size={compact ? 15 : 24} /><small>{name}</small></>}
  </span>;
}

export function CardArtworkPicker({ cardName, onClose }: { cardName: string; onClose: () => void }) {
  const current = useCardRecord(cardName);
  const [printings, setPrintings] = useState<CardPrinting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getCardPrintings(cardName).then((cards) => { if (active) setPrintings(cards); }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [cardName]);

  return <div className="artwork-picker-backdrop" role="dialog" aria-modal="true" aria-label={`Choose artwork for ${cardName}`}>
    <section className="artwork-picker">
      <header><div><span className="kicker">Card appearance</span><h2>{cardName}</h2><p>Choose a printing. The preference is used everywhere in NovaTable.</p></div><button onClick={onClose} aria-label="Close artwork picker"><X size={18} /></button></header>
      <div className="artwork-picker-actions"><button onClick={() => { setPreferredCardPrinting(cardName, null); onClose(); }}><RotateCcw size={14} />Use default artwork</button><span>{printings.length ? `${printings.length} printings` : "Official printings"}</span></div>
      {loading && <div className="artwork-picker-status"><LoaderCircle className="spin" size={24} />Loading editions and artwork…</div>}
      {error && <div className="inline-error">{error}</div>}
      {!loading && !error && <div className="artwork-grid">{printings.map((printing) => <button className={current?.printingId === printing.printingId ? "is-current" : ""} key={printing.printingId} onClick={() => { setPreferredCardPrinting(cardName, printing); onClose(); }}>
        <img src={printing.imageUrl!} alt={`${cardName} — ${printing.setName}`} loading="lazy" />
        <span><strong>{printing.setName}</strong><small>{printing.setCode} · #{printing.collectorNumber}{printing.releasedAt ? ` · ${printing.releasedAt.slice(0, 4)}` : ""}</small><i>{printing.artist}</i></span>
        {current?.printingId === printing.printingId && <b><Check size={12} />Selected</b>}
      </button>)}</div>}
    </section>
  </div>;
}
