import { useState, useEffect, useCallback, useRef } from "react";

// ── constants ────────────────────────────────────────────────────────────────
const CORS = "https://corsproxy.io/?";
const YF = (sym) => `${CORS}https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`;
const YF_QUOTE = (sym) => `${CORS}https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=price`;

const CLAUDE_API = "https://api.anthropic.com/v1/messages";

// ── helpers ──────────────────────────────────────────────────────────────────
const fmt$ = (n, decimals = 0) => n == null ? "—" : `${n >= 0 ? "+" : ""}${Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
const fmtPct = (n) => n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const fmtNum = (n, d = 2) => n == null ? "—" : n.toFixed(d);
const clsx = (...cs) => cs.filter(Boolean).join(" ");

function getSessionMode() {
  const now = new Date();
  const h = now.getHours(), m = now.getMinutes();
  const mins = h * 60 + m;
  if (mins >= 9 * 60 && mins < 10 * 60 + 30) return "morning";
  if (mins >= 15 * 60 && mins < 16 * 60) return "afternoon";
  if (mins >= 10 * 60 + 30 && mins < 15 * 60) return "midday";
  return "closed";
}

function getMorningSignal({ gapPct, pullbackDepth, vix, vixDelta, rsi, volumeRatio, streak, timeMinsPastOpen }) {
  const flags = { green: [], yellow: [], red: [] };

  if (gapPct == null) return { signal: "WAIT", color: "yellow", flags };

  // gap
  if (gapPct >= 0.2) flags.green.push("Gap up confirmed");
  else if (gapPct <= -0.2) flags.red.push("Gap down — skip");
  else flags.yellow.push("Flat open, no gap edge");

  // pullback depth
  if (pullbackDepth >= 0.2 && pullbackDepth <= 0.8) flags.green.push(`Pullback ${pullbackDepth.toFixed(1)}% — sweet spot`);
  else if (pullbackDepth < 0.2) flags.yellow.push("Pullback too shallow — wait for dip");
  else if (pullbackDepth > 1.0) flags.red.push("Pullback >1% — possible reversal not dip");
  else flags.yellow.push("Pullback deepening — watch");

  // vix
  if (vixDelta <= 0) flags.green.push("VIX stable/falling");
  else if (vixDelta <= 0.5) flags.yellow.push("VIX ticking up slightly");
  else flags.red.push(`VIX spiking +${vixDelta?.toFixed(1)} — danger`);

  // rsi
  if (rsi != null) {
    if (rsi >= 50 && rsi <= 65) flags.green.push(`RSI ${rsi?.toFixed(0)} reset — entry zone`);
    else if (rsi > 65) flags.yellow.push(`RSI ${rsi?.toFixed(0)} still elevated — wait`);
    else if (rsi < 45) flags.red.push(`RSI ${rsi?.toFixed(0)} oversold — not a pullback`);
  }

  // volume
  if (volumeRatio != null) {
    if (volumeRatio < 0.8) flags.green.push("Volume drying up on pullback ✓");
    else if (volumeRatio < 1.2) flags.yellow.push("Volume neutral on pullback");
    else flags.red.push("Heavy volume on pullback — sellers active");
  }

  // streak
  if (streak >= 5) flags.red.push(`Day ${streak} streak — mean reversion risk`);
  else if (streak >= 3) flags.yellow.push(`Day ${streak} streak — caution`);
  else flags.green.push(`Streak ${streak} — healthy`);

  // time
  if (timeMinsPastOpen > 60) flags.red.push("Past 10:30 — window closed");
  else if (timeMinsPastOpen > 45) flags.yellow.push("Window closing — act soon");

  const reds = flags.red.length, yellows = flags.yellow.length, greens = flags.green.length;
  let signal = "GO", color = "green";
  if (reds >= 1) { signal = "SKIP"; color = "red"; }
  else if (yellows >= 2 || greens < 2) { signal = "WAIT"; color = "yellow"; }

  return { signal, color, flags };
}

function getAfternoonSignal({ closingStrength, vix, vixDelta, futures, streak, hasMacroTomorrow }) {
  const flags = { green: [], yellow: [], red: [] };

  if (closingStrength >= 0.3) flags.green.push("Closing near day highs");
  else if (closingStrength >= 0) flags.yellow.push("Closing mid-range");
  else flags.red.push("Closing near lows — weak close");

  if (vixDelta <= 0) flags.green.push("VIX falling into close");
  else if (vixDelta <= 0.5) flags.yellow.push("VIX slightly elevated");
  else flags.red.push(`VIX rising +${vixDelta?.toFixed(1)} — skip`);

  if (futures > 0.1) flags.green.push(`Futures +${futures?.toFixed(2)}% — bullish overnight`);
  else if (futures > -0.1) flags.yellow.push("Futures flat — neutral");
  else flags.red.push(`Futures ${futures?.toFixed(2)}% — bearish overnight`);

  if (streak <= 3) flags.green.push(`Streak ${streak} — healthy`);
  else if (streak === 4) flags.yellow.push("Day 4 streak — moderate caution");
  else flags.red.push(`Day ${streak} streak — high mean reversion risk`);

  if (!hasMacroTomorrow) flags.green.push("No macro tomorrow");
  else flags.red.push("Macro event tomorrow — skip overnight");

  const reds = flags.red.length, yellows = flags.yellow.length, greens = flags.green.length;
  let signal = "GO", color = "green";
  if (reds >= 1) { signal = "SKIP"; color = "red"; }
  else if (yellows >= 2 || greens < 2) { signal = "WAIT"; color = "yellow"; }

  return { signal, color, flags };
}

// ── data fetching ─────────────────────────────────────────────────────────────
async function fetchQuote(symbol) {
  try {
    const r = await fetch(YF_QUOTE(symbol));
    const d = await r.json();
    const p = d?.quoteSummary?.result?.[0]?.price;
    if (!p) return null;
    return {
      price: p.regularMarketPrice?.raw,
      change: p.regularMarketChange?.raw,
      changePct: p.regularMarketChangePercent?.raw * 100,
      open: p.regularMarketOpen?.raw,
      high: p.regularMarketDayHigh?.raw,
      low: p.regularMarketDayLow?.raw,
      prevClose: p.regularMarketPreviousClose?.raw,
      volume: p.regularMarketVolume?.raw,
    };
  } catch { return null; }
}

async function fetchIntraday(symbol) {
  try {
    const r = await fetch(YF(symbol));
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result) return null;
    const timestamps = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    return timestamps.map((t, i) => ({
      time: t * 1000,
      open: q.open?.[i],
      high: q.high?.[i],
      low: q.low?.[i],
      close: q.close?.[i],
      volume: q.volume?.[i],
    })).filter(c => c.close != null);
  } catch { return null; }
}

// ── AI Analysis ───────────────────────────────────────────────────────────────
async function getAIRead(mode, marketData, signal) {
  const prompt = mode === "morning"
    ? `You are a professional options trader assistant. Analyze this morning session data and give a 2-3 sentence plain-English read on whether to enter a SPX put credit spread right now. Be direct and specific. Data: SPX gap: ${fmtPct(marketData.gapPct)}, pullback from high: ${fmtPct(marketData.pullbackDepth)}, VIX: ${fmtNum(marketData.vix)} (${marketData.vixDelta >= 0 ? "rising" : "falling"}), streak: ${marketData.streak} green days, signal: ${signal.signal}. Flags for: ${signal.flags.green.join(", ")}. Flags against: ${signal.flags.red.join(", ")}.`
    : `You are a professional options trader assistant. Analyze this afternoon session data for an overnight SPX put credit spread. Give a 2-3 sentence plain-English read on the overnight gap setup. Be direct. Data: SPX day change: ${fmtPct(marketData.dayChangePct)}, closing strength: ${fmtPct(marketData.closingStrength)}, VIX: ${fmtNum(marketData.vix)}, ES futures: ${fmtPct(marketData.futures)}, streak: ${marketData.streak} green days, macro tomorrow: ${marketData.hasMacroTomorrow ? "YES" : "None"}, signal: ${signal.signal}.`;

  try {
    const r = await fetch(CLAUDE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const d = await r.json();
    return d.content?.[0]?.text || null;
  } catch { return null; }
}

// ── components ────────────────────────────────────────────────────────────────
function SignalBadge({ signal, color, size = "large" }) {
  const icons = { GO: "▶", WAIT: "◐", SKIP: "✕" };
  return (
    <div className={clsx("signal-badge", `signal-${color}`, `signal-${size}`)}>
      <span className="signal-icon">{icons[signal]}</span>
      <span className="signal-text">{signal}</span>
    </div>
  );
}

function FlagList({ flags }) {
  return (
    <div className="flag-list">
      {flags.green.map((f, i) => <div key={i} className="flag-item flag-g">▲ {f}</div>)}
      {flags.yellow.map((f, i) => <div key={i} className="flag-item flag-y">◆ {f}</div>)}
      {flags.red.map((f, i) => <div key={i} className="flag-item flag-r">▼ {f}</div>)}
    </div>
  );
}

function MetricTile({ label, value, sub, accent }) {
  return (
    <div className="metric-tile">
      <div className="mt-label">{label}</div>
      <div className={clsx("mt-value", accent)}>{value}</div>
      {sub && <div className="mt-sub">{sub}</div>}
    </div>
  );
}

function PullbackBar({ depth }) {
  const pct = Math.min(Math.max(depth || 0, 0), 2);
  const fill = (pct / 2) * 100;
  const color = pct < 0.2 ? "#f5c542" : pct <= 0.8 ? "#00e5a0" : pct <= 1.0 ? "#f5c542" : "#ff4d6a";
  return (
    <div className="pb-wrap">
      <div className="pb-track">
        <div className="pb-fill" style={{ width: `${fill}%`, background: color }} />
        <div className="pb-marker" style={{ left: "10%" }} title="0.2%" />
        <div className="pb-marker" style={{ left: "40%" }} title="0.8%" />
        <div className="pb-marker" style={{ left: "50%" }} title="1.0%" />
      </div>
      <div className="pb-labels">
        <span>0%</span><span style={{ color: "#00e5a0" }}>sweet spot</span><span>2%</span>
      </div>
    </div>
  );
}

function MiniSparkline({ candles }) {
  if (!candles?.length) return null;
  const recent = candles.slice(-30);
  const prices = recent.map(c => c.close).filter(Boolean);
  if (prices.length < 2) return null;
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 1;
  const w = 200, h = 40;
  const pts = prices.map((p, i) => `${(i / (prices.length - 1)) * w},${h - ((p - min) / range) * h}`).join(" ");
  const trend = prices[prices.length - 1] > prices[0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="sparkline" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={trend ? "#00e5a0" : "#ff4d6a"} strokeWidth="1.5" />
    </svg>
  );
}

function ThesisModal({ mode, marketData, signal, onSave, onClose }) {
  const [thesis, setThesis] = useState({ prediction: "up", confidence: 70, spread: "", credit: "", notes: "", followed: true });
  const set = (k, v) => setThesis(t => ({ ...t, [k]: v }));
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Log Trade Thesis</span>
          <span className="modal-mode">{mode === "morning" ? "MORNING SESSION" : "AFTERNOON OVERNIGHT"}</span>
        </div>
        <div className="thesis-grid">
          <div className="tg-group">
            <label>Gap Prediction</label>
            <div className="btn-row">
              {["up","flat","down"].map(p => <button key={p} className={clsx("choice-btn", thesis.prediction === p && "choice-active")} onClick={() => set("prediction", p)}>{p.toUpperCase()}</button>)}
            </div>
          </div>
          <div className="tg-group">
            <label>Confidence</label>
            <div className="conf-row">
              <input type="range" min={40} max={95} step={5} value={thesis.confidence} onChange={e => set("confidence", +e.target.value)} className="conf-slider" />
              <span className="conf-val">{thesis.confidence}%</span>
            </div>
          </div>
          <div className="tg-group">
            <label>Spread (e.g. 5400/5350P)</label>
            <input className="t-input" value={thesis.spread} onChange={e => set("spread", e.target.value)} placeholder="5400/5350 Put spread" />
          </div>
          <div className="tg-group">
            <label>Credit Target ($)</label>
            <input className="t-input" value={thesis.credit} onChange={e => set("credit", e.target.value)} placeholder="e.g. 800" />
          </div>
          <div className="tg-group full">
            <label>Reasoning</label>
            <textarea className="t-textarea" value={thesis.notes} onChange={e => set("notes", e.target.value)} placeholder="What's your read? What would make you exit early?" rows={3} />
          </div>
          <div className="tg-group">
            <label>Following Your Rules?</label>
            <div className="btn-row">
              <button className={clsx("choice-btn", thesis.followed && "choice-active")} onClick={() => set("followed", true)}>YES</button>
              <button className={clsx("choice-btn", !thesis.followed && "choice-danger")} onClick={() => set("followed", false)}>NO — override</button>
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn-cancel" onClick={onClose}>Cancel</button>
          <button className="btn-save" onClick={() => { onSave({ ...thesis, mode, signal: signal.signal, timestamp: Date.now(), marketSnapshot: { ...marketData } }); onClose(); }}>
            Save Thesis
          </button>
        </div>
      </div>
    </div>
  );
}

function ThesisCard({ entry, onOutcome }) {
  const [open, setOpen] = useState(false);
  const ts = new Date(entry.timestamp);
  const timeStr = ts.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <div className={clsx("tcard", entry.outcome ? (entry.outcome === "win" ? "tc-win" : entry.outcome === "loss" ? "tc-loss" : "tc-skip") : "tc-pending")}>
      <div className="tcard-header" onClick={() => setOpen(!open)}>
        <span className="tc-time">{timeStr}</span>
        <span className={clsx("tc-mode", entry.mode === "morning" ? "mode-am" : "mode-pm")}>{entry.mode === "morning" ? "AM" : "PM"}</span>
        <span className="tc-pred">Gap {entry.prediction?.toUpperCase()} {entry.confidence}%</span>
        <SignalBadge signal={entry.signal} color={entry.signal === "GO" ? "green" : entry.signal === "WAIT" ? "yellow" : "red"} size="small" />
        {!entry.outcome && <button className="tc-outcome-btn" onClick={e => { e.stopPropagation(); onOutcome(entry.id); }}>Log Outcome</button>}
        {entry.outcome && <span className={clsx("tc-result", entry.outcome === "win" ? "col-g" : entry.outcome === "loss" ? "col-r" : "col-y")}>{entry.outcome.toUpperCase()}</span>}
        <span className="tc-chevron">{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div className="tcard-body">
          {entry.spread && <div className="tc-detail"><span className="tc-dk">Spread</span><span>{entry.spread}</span></div>}
          {entry.credit && <div className="tc-detail"><span className="tc-dk">Target Credit</span><span>${entry.credit}</span></div>}
          {entry.notes && <div className="tc-detail"><span className="tc-dk">Thesis</span><span>{entry.notes}</span></div>}
          {!entry.followed && <div className="tc-broke">⚠ Rules override — trade entered against signals</div>}
        </div>
      )}
    </div>
  );
}

function OutcomeModal({ entryId, onSave, onClose }) {
  const [outcome, setOutcome] = useState("win");
  const [pnl, setPnl] = useState("");
  const [notes, setNotes] = useState("");
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
        <div className="modal-title">Log Outcome</div>
        <div className="tg-group" style={{ marginBottom: 14 }}>
          <label>Result</label>
          <div className="btn-row">
            {["win", "loss", "skip"].map(o => <button key={o} className={clsx("choice-btn", outcome === o && (o === "win" ? "choice-active" : o === "loss" ? "choice-danger" : "choice-yellow"))} onClick={() => setOutcome(o)}>{o.toUpperCase()}</button>)}
          </div>
        </div>
        <div className="tg-group" style={{ marginBottom: 14 }}>
          <label>Realized P&L ($)</label>
          <input className="t-input" value={pnl} onChange={e => setPnl(e.target.value)} placeholder="e.g. 750 or -1100" />
        </div>
        <div className="tg-group" style={{ marginBottom: 14 }}>
          <label>Notes</label>
          <textarea className="t-textarea" value={notes} onChange={e => setNotes(e.target.value)} placeholder="What happened?" rows={2} />
        </div>
        <div className="modal-actions">
          <button className="btn-cancel" onClick={onClose}>Cancel</button>
          <button className="btn-save" onClick={() => { onSave(entryId, { outcome, pnl: parseFloat(pnl) || 0, outcomeNotes: notes }); onClose(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── main ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("cockpit");
  const [mode, setMode] = useState(getSessionMode());
  const [modeOverride, setModeOverride] = useState(null);
  const [market, setMarket] = useState({});
  const [candles, setCandles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [aiRead, setAiRead] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [showThesis, setShowThesis] = useState(false);
  const [thesisLog, setThesisLog] = useState([]);
  const [outcomeFor, setOutcomeFor] = useState(null);
  const timerRef = useRef(null);

  const activeMode = modeOverride || mode;

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [spx, vix, spy, qqq, aapl] = await Promise.all([
        fetchQuote("^GSPC"), fetchQuote("^VIX"),
        fetchQuote("SPY"), fetchQuote("QQQ"), fetchQuote("AAPL")
      ]);
      const spxCandles = await fetchIntraday("^GSPC");
      if (spxCandles) setCandles(spxCandles);

      // derive signals
      let gapPct = null, pullbackDepth = null, closingStrength = null;
      if (spx?.open && spx?.prevClose) gapPct = ((spx.open - spx.prevClose) / spx.prevClose) * 100;
      if (spxCandles?.length > 3) {
        const openPrice = spxCandles[0]?.open;
        const dayHigh = Math.max(...spxCandles.map(c => c.high).filter(Boolean));
        const current = spxCandles[spxCandles.length - 1]?.close;
        if (openPrice && dayHigh && current) pullbackDepth = ((dayHigh - current) / dayHigh) * 100;
        if (spx?.high && spx?.low && spx?.price) {
          const range = spx.high - spx.low;
          closingStrength = range > 0 ? ((spx.price - spx.low) / range - 0.5) * 100 : 0;
        }
      }

      // estimate RSI from candles
      let rsi = null;
      if (spxCandles?.length >= 15) {
        const closes = spxCandles.slice(-15).map(c => c.close).filter(Boolean);
        let gains = 0, losses = 0;
        for (let i = 1; i < closes.length; i++) {
          const d = closes[i] - closes[i - 1];
          if (d > 0) gains += d; else losses -= d;
        }
        const avgG = gains / 14, avgL = losses / 14;
        rsi = avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));
      }

      // volume ratio (rough: compare last candle vol to avg of first hour)
      let volumeRatio = null;
      if (spxCandles?.length > 10) {
        const recent = spxCandles.slice(-5).map(c => c.volume).filter(Boolean);
        const baseline = spxCandles.slice(0, 10).map(c => c.volume).filter(Boolean);
        if (recent.length && baseline.length) {
          const avgR = recent.reduce((a, b) => a + b, 0) / recent.length;
          const avgB = baseline.reduce((a, b) => a + b, 0) / baseline.length;
          volumeRatio = avgB > 0 ? avgR / avgB : null;
        }
      }

      const now = new Date();
      const minsOpen = Math.max(0, (now.getHours() * 60 + now.getMinutes()) - 9 * 60 - 30);

      setMarket({
        spx, vix, spy, qqq, aapl,
        gapPct, pullbackDepth, closingStrength, rsi, volumeRatio,
        futures: (Math.random() * 0.4 - 0.1), // placeholder — replace with Finnhub
        streak: 4, // placeholder — will wire to historical data
        hasMacroTomorrow: false,
        vixDelta: vix?.change || 0,
        timeMinsPastOpen: minsOpen,
        dayChangePct: spx?.changePct,
      });
      setLastUpdated(new Date());
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }, []);

  const getAI = useCallback(async (md, sig) => {
    setAiLoading(true);
    setAiRead("");
    const txt = await getAIRead(activeMode, md, sig);
    setAiRead(txt || "AI analysis unavailable — check connection.");
    setAiLoading(false);
  }, [activeMode]);

  useEffect(() => {
    fetchData();
    timerRef.current = setInterval(fetchData, 60000);
    return () => clearInterval(timerRef.current);
  }, [fetchData]);

  useEffect(() => {
    const tick = setInterval(() => setMode(getSessionMode()), 30000);
    return () => clearInterval(tick);
  }, []);

  const morningSignal = getMorningSignal({
    gapPct: market.gapPct, pullbackDepth: market.pullbackDepth,
    vix: market.vix?.price, vixDelta: market.vixDelta,
    rsi: market.rsi, volumeRatio: market.volumeRatio,
    streak: market.streak || 0, timeMinsPastOpen: market.timeMinsPastOpen || 0,
  });

  const afternoonSignal = getAfternoonSignal({
    closingStrength: market.closingStrength, vix: market.vix?.price,
    vixDelta: market.vixDelta, futures: market.futures,
    streak: market.streak || 0, hasMacroTomorrow: market.hasMacroTomorrow,
  });

  const activeSignal = activeMode === "morning" ? morningSignal : afternoonSignal;

  const perf = (() => {
    const entries = thesisLog.filter(e => e.outcome);
    if (!entries.length) return null;
    const wins = entries.filter(e => e.outcome === "win").length;
    const totalPnl = entries.reduce((s, e) => s + (e.pnl || 0), 0);
    const flagged = thesisLog.filter(e => e.signal === "SKIP" || !e.followed);
    const flaggedLosses = flagged.filter(e => e.outcome === "loss").length;
    return { wins, total: entries.length, winRate: (wins / entries.length) * 100, totalPnl, flaggedLosses, flagged: flagged.length };
  })();

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,400&family=Unbounded:wght@400;700;900&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --bg: #05080b;
          --s1: #080d12;
          --s2: #0c1318;
          --s3: #111c24;
          --b1: #182230;
          --b2: #1e2d3d;
          --txt: #b8cfe0;
          --txt2: #5a7a96;
          --txt3: #2a4560;
          --G: #00f0a0;
          --G2: #00b87a;
          --R: #ff3d5a;
          --R2: #cc1a35;
          --Y: #ffc235;
          --Y2: #cc8800;
          --B: #2a9fff;
          --P: #a066ff;
          --font: 'DM Mono', monospace;
          --head: 'Unbounded', sans-serif;
        }
        body { background: var(--bg); color: var(--txt); font-family: var(--font); font-size: 13px; line-height: 1.5; }
        .app { min-height: 100vh; display: flex; flex-direction: column; }

        /* topbar */
        .topbar {
          background: var(--s1); border-bottom: 1px solid var(--b1);
          padding: 0 20px; height: 52px; display: flex; align-items: center;
          justify-content: space-between; position: sticky; top: 0; z-index: 200;
        }
        .logo { font-family: var(--head); font-size: 15px; font-weight: 900; color: #fff; letter-spacing: -0.5px; display: flex; align-items: center; gap: 10px; }
        .logo-pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--G); box-shadow: 0 0 10px var(--G); animation: pulse 2s ease-in-out infinite; }
        @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(0.8)} }
        .topbar-right { display: flex; align-items: center; gap: 12px; }
        .update-time { font-size: 10px; color: var(--txt3); letter-spacing: 1px; }
        .refresh-btn { background: var(--s3); border: 1px solid var(--b1); color: var(--txt2); font-family: var(--font); font-size: 11px; padding: 5px 12px; border-radius: 4px; cursor: pointer; transition: all .15s; }
        .refresh-btn:hover { color: var(--txt); border-color: var(--b2); }

        /* nav */
        .nav { display: flex; gap: 0; border-bottom: 1px solid var(--b1); background: var(--s1); padding: 0 20px; }
        .nav-btn { background: none; border: none; color: var(--txt2); font-family: var(--font); font-size: 11px; padding: 10px 16px; cursor: pointer; letter-spacing: 1.5px; text-transform: uppercase; border-bottom: 2px solid transparent; transition: all .15s; }
        .nav-btn:hover { color: var(--txt); }
        .nav-btn.active { color: var(--G); border-bottom-color: var(--G); }

        /* content */
        .content { flex: 1; padding: 20px; max-width: 900px; width: 100%; margin: 0 auto; }

        /* mode selector */
        .mode-bar { display: flex; gap: 8px; margin-bottom: 20px; align-items: center; }
        .mode-btn { background: var(--s2); border: 1px solid var(--b1); color: var(--txt2); font-family: var(--font); font-size: 11px; padding: 6px 14px; border-radius: 20px; cursor: pointer; letter-spacing: 1px; transition: all .15s; }
        .mode-btn.mode-active { background: var(--s3); border-color: var(--G); color: var(--G); }
        .mode-auto { font-size: 10px; color: var(--txt3); margin-left: auto; }

        /* signal */
        .signal-badge { display: inline-flex; align-items: center; gap: 8px; border-radius: 6px; font-family: var(--head); font-weight: 700; letter-spacing: 1px; }
        .signal-large { padding: 14px 24px; font-size: 22px; }
        .signal-small { padding: 3px 10px; font-size: 11px; border-radius: 4px; }
        .signal-green { background: rgba(0,240,160,0.12); color: var(--G); border: 1px solid rgba(0,240,160,0.3); }
        .signal-yellow { background: rgba(255,194,53,0.1); color: var(--Y); border: 1px solid rgba(255,194,53,0.25); }
        .signal-red { background: rgba(255,61,90,0.1); color: var(--R); border: 1px solid rgba(255,61,90,0.25); }

        /* signal hero */
        .signal-hero { background: var(--s2); border: 1px solid var(--b1); border-radius: 10px; padding: 20px; margin-bottom: 16px; display: flex; align-items: center; gap: 20px; }
        .signal-hero-left { flex: 1; }
        .signal-session { font-size: 10px; color: var(--txt3); text-transform: uppercase; letter-spacing: 2px; margin-bottom: 8px; }

        /* metrics row */
        .metrics-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; }
        .metric-tile { background: var(--s2); border: 1px solid var(--b1); border-radius: 8px; padding: 12px 14px; }
        .mt-label { font-size: 9px; color: var(--txt3); text-transform: uppercase; letter-spacing: 2px; margin-bottom: 6px; }
        .mt-value { font-family: var(--head); font-size: 18px; font-weight: 700; line-height: 1; }
        .mt-sub { font-size: 10px; color: var(--txt2); margin-top: 4px; }
        .col-g { color: var(--G); } .col-r { color: var(--R); } .col-y { color: var(--Y); } .col-b { color: var(--B); } .col-p { color: var(--P); }

        /* flag list */
        .flag-list { display: flex; flex-direction: column; gap: 4px; }
        .flag-item { font-size: 11px; padding: 3px 0; }
        .flag-g { color: var(--G2); } .flag-y { color: var(--Y2); } .flag-r { color: var(--R2); }

        /* two col */
        .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
        .panel { background: var(--s2); border: 1px solid var(--b1); border-radius: 8px; padding: 16px; }
        .panel-title { font-size: 9px; color: var(--txt3); text-transform: uppercase; letter-spacing: 2px; margin-bottom: 12px; }

        /* pullback bar */
        .pb-wrap { margin-top: 6px; }
        .pb-track { height: 6px; background: var(--s3); border-radius: 3px; position: relative; overflow: hidden; }
        .pb-fill { height: 100%; border-radius: 3px; transition: width .5s ease; }
        .pb-marker { position: absolute; top: -2px; bottom: -2px; width: 1px; background: var(--b2); }
        .pb-labels { display: flex; justify-content: space-between; font-size: 9px; color: var(--txt3); margin-top: 4px; }

        /* sparkline */
        .sparkline { width: 100%; height: 40px; display: block; }

        /* AI read */
        .ai-panel { background: var(--s2); border: 1px solid var(--b1); border-left: 3px solid var(--B); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
        .ai-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
        .ai-label { font-size: 9px; color: var(--B); text-transform: uppercase; letter-spacing: 2px; }
        .ai-get-btn { background: none; border: 1px solid var(--b2); color: var(--B); font-family: var(--font); font-size: 10px; padding: 4px 10px; border-radius: 4px; cursor: pointer; transition: all .15s; }
        .ai-get-btn:hover { background: rgba(42,159,255,0.1); }
        .ai-text { font-size: 12px; color: var(--txt); line-height: 1.7; }
        .ai-loading { color: var(--txt3); font-size: 12px; }

        /* action btn */
        .log-btn { width: 100%; background: var(--G2); border: none; color: #000; font-family: var(--head); font-weight: 700; font-size: 13px; padding: 14px; border-radius: 8px; cursor: pointer; letter-spacing: 1px; text-transform: uppercase; transition: background .15s; margin-bottom: 16px; }
        .log-btn:hover { background: var(--G); }

        /* benchmark */
        .bench-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 16px; }
        .bench-card { background: var(--s2); border: 1px solid var(--b1); border-radius: 8px; padding: 14px; text-align: center; }
        .bench-name { font-size: 9px; color: var(--txt3); text-transform: uppercase; letter-spacing: 2px; margin-bottom: 6px; }
        .bench-val { font-family: var(--head); font-size: 20px; font-weight: 700; }
        .bench-vs { font-size: 10px; margin-top: 4px; }

        /* thesis log */
        .tcard { background: var(--s2); border: 1px solid var(--b1); border-radius: 8px; overflow: hidden; margin-bottom: 8px; }
        .tc-win { border-left: 3px solid var(--G2); }
        .tc-loss { border-left: 3px solid var(--R2); }
        .tc-skip { border-left: 3px solid var(--txt3); }
        .tc-pending { border-left: 3px solid var(--B); }
        .tcard-header { display: flex; align-items: center; gap: 10px; padding: 12px 14px; cursor: pointer; transition: background .1s; flex-wrap: wrap; }
        .tcard-header:hover { background: var(--s3); }
        .tc-time { font-size: 11px; color: var(--txt2); }
        .tc-mode { font-size: 9px; padding: 2px 7px; border-radius: 3px; font-weight: 700; letter-spacing: 1px; }
        .mode-am { background: rgba(255,194,53,0.1); color: var(--Y); border: 1px solid rgba(255,194,53,0.2); }
        .mode-pm { background: rgba(160,102,255,0.1); color: var(--P); border: 1px solid rgba(160,102,255,0.2); }
        .tc-pred { font-size: 11px; flex: 1; }
        .tc-result { font-size: 11px; font-weight: 700; }
        .tc-outcome-btn { background: var(--s3); border: 1px solid var(--b2); color: var(--B); font-family: var(--font); font-size: 10px; padding: 3px 10px; border-radius: 4px; cursor: pointer; }
        .tc-chevron { font-size: 10px; color: var(--txt3); margin-left: auto; }
        .tcard-body { padding: 0 14px 12px; display: flex; flex-direction: column; gap: 6px; }
        .tc-detail { display: flex; gap: 12px; font-size: 11px; }
        .tc-dk { color: var(--txt3); min-width: 80px; }
        .tc-broke { font-size: 11px; color: var(--Y); background: rgba(255,194,53,0.07); padding: 6px 10px; border-radius: 4px; }

        /* perf summary */
        .perf-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--b1); font-size: 12px; }
        .perf-row:last-child { border: none; }
        .perf-k { color: var(--txt2); }

        /* modal */
        .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.75); z-index: 500; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .modal { background: var(--s2); border: 1px solid var(--b2); border-radius: 12px; padding: 24px; max-width: 460px; width: 100%; }
        .modal-sm { max-width: 360px; }
        .modal-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 20px; }
        .modal-title { font-family: var(--head); font-size: 14px; font-weight: 700; color: #fff; }
        .modal-mode { font-size: 9px; color: var(--txt3); letter-spacing: 2px; text-transform: uppercase; }
        .thesis-grid { display: flex; flex-direction: column; gap: 14px; margin-bottom: 20px; }
        .tg-group { display: flex; flex-direction: column; gap: 6px; }
        .tg-group.full { }
        label { font-size: 9px; color: var(--txt2); text-transform: uppercase; letter-spacing: 1.5px; }
        .btn-row { display: flex; gap: 6px; }
        .choice-btn { background: var(--s3); border: 1px solid var(--b2); color: var(--txt2); font-family: var(--font); font-size: 11px; padding: 7px 14px; border-radius: 4px; cursor: pointer; transition: all .15s; }
        .choice-active { background: rgba(0,240,160,0.12); border-color: var(--G); color: var(--G); }
        .choice-danger { background: rgba(255,61,90,0.12); border-color: var(--R); color: var(--R); }
        .choice-yellow { background: rgba(255,194,53,0.1); border-color: var(--Y); color: var(--Y); }
        .conf-row { display: flex; align-items: center; gap: 10px; }
        .conf-slider { flex: 1; accent-color: var(--G); }
        .conf-val { font-size: 14px; color: var(--G); font-weight: 500; min-width: 36px; }
        .t-input { background: var(--s3); border: 1px solid var(--b2); color: var(--txt); font-family: var(--font); font-size: 12px; padding: 8px 12px; border-radius: 4px; outline: none; width: 100%; transition: border-color .15s; }
        .t-input:focus { border-color: var(--B); }
        .t-textarea { background: var(--s3); border: 1px solid var(--b2); color: var(--txt); font-family: var(--font); font-size: 12px; padding: 8px 12px; border-radius: 4px; outline: none; width: 100%; resize: vertical; transition: border-color .15s; }
        .t-textarea:focus { border-color: var(--B); }
        .modal-actions { display: flex; gap: 10px; justify-content: flex-end; }
        .btn-cancel { background: none; border: 1px solid var(--b2); color: var(--txt2); font-family: var(--font); font-size: 12px; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
        .btn-save { background: var(--G2); border: none; color: #000; font-family: var(--head); font-size: 12px; font-weight: 700; padding: 8px 20px; border-radius: 4px; cursor: pointer; letter-spacing: .5px; }

        /* loading */
        .loading-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--B); animation: pulse 1s infinite; }

        /* empty */
        .empty { text-align: center; padding: 40px; color: var(--txt3); font-size: 12px; }

        @media (max-width: 640px) {
          .metrics-row { grid-template-columns: repeat(2, 1fr); }
          .two-col { grid-template-columns: 1fr; }
          .bench-grid { grid-template-columns: repeat(3, 1fr); }
          .content { padding: 12px; }
          .signal-hero { flex-direction: column; gap: 14px; }
        }
      `}</style>

      <div className="app">
        <header className="topbar">
          <div className="logo">
            <div className="logo-pulse" />
            EDGE
          </div>
          <div className="topbar-right">
            {lastUpdated && <span className="update-time">Updated {lastUpdated.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>}
            <button className="refresh-btn" onClick={fetchData} disabled={loading}>{loading ? "…" : "↻ Refresh"}</button>
          </div>
        </header>

        <nav className="nav">
          {[["cockpit", "Cockpit"], ["thesis", "Thesis Log"], ["performance", "Performance"]].map(([id, label]) => (
            <button key={id} className={clsx("nav-btn", tab === id && "active")} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>

        <div className="content">

          {/* ── COCKPIT ── */}
          {tab === "cockpit" && (
            <>
              {/* mode selector */}
              <div className="mode-bar">
                <button className={clsx("mode-btn", activeMode === "morning" && "mode-active")} onClick={() => setModeOverride("morning")}>AM 9:00–10:30</button>
                <button className={clsx("mode-btn", activeMode === "afternoon" && "mode-active")} onClick={() => setModeOverride("afternoon")}>PM 3:00–4:00</button>
                <button className={clsx("mode-btn", modeOverride === null && "mode-active")} onClick={() => setModeOverride(null)}>Auto</button>
                <span className="mode-auto">{activeMode === "morning" ? "Morning reversal session" : activeMode === "afternoon" ? "Overnight setup session" : activeMode === "midday" ? "Midday — no active session" : "Market closed"}</span>
              </div>

              {/* signal hero */}
              <div className="signal-hero">
                <div className="signal-hero-left">
                  <div className="signal-session">{activeMode === "morning" ? "Morning Reversal Signal" : "Overnight Gap Signal"}</div>
                  <SignalBadge signal={activeSignal.signal} color={activeSignal.color} size="large" />
                </div>
                <FlagList flags={activeSignal.flags} />
              </div>

              {/* live metrics */}
              <div className="metrics-row">
                <MetricTile label="SPX" value={market.spx?.price?.toFixed(0) ?? "—"} sub={fmtPct(market.spx?.changePct)} accent={market.spx?.changePct >= 0 ? "col-g" : "col-r"} />
                <MetricTile label="VIX" value={market.vix?.price?.toFixed(1) ?? "—"} sub={`${market.vixDelta >= 0 ? "+" : ""}${market.vixDelta?.toFixed(2)} today`} accent={market.vixDelta <= 0 ? "col-g" : "col-r"} />
                <MetricTile label="Gap" value={market.gapPct != null ? fmtPct(market.gapPct) : "—"} sub="from prev close" accent={market.gapPct >= 0.2 ? "col-g" : market.gapPct <= -0.2 ? "col-r" : "col-y"} />
                <MetricTile label="Streak" value={`${market.streak ?? "—"}d`} sub="green days" accent={market.streak >= 5 ? "col-r" : market.streak >= 3 ? "col-y" : "col-g"} />
              </div>

              {/* two col panels */}
              <div className="two-col">
                {activeMode === "morning" ? (
                  <div className="panel">
                    <div className="panel-title">Pullback Depth</div>
                    <div style={{ fontSize: 22, fontFamily: "var(--head)", fontWeight: 700, marginBottom: 8 }} className={market.pullbackDepth >= 0.2 && market.pullbackDepth <= 0.8 ? "col-g" : market.pullbackDepth > 1 ? "col-r" : "col-y"}>
                      {market.pullbackDepth != null ? `${market.pullbackDepth.toFixed(2)}%` : "—"}
                    </div>
                    <PullbackBar depth={market.pullbackDepth} />
                    <div style={{ marginTop: 10, fontSize: 10, color: "var(--txt3)" }}>0.2–0.8% is the entry zone</div>
                  </div>
                ) : (
                  <div className="panel">
                    <div className="panel-title">Closing Strength</div>
                    <div style={{ fontSize: 22, fontFamily: "var(--head)", fontWeight: 700 }} className={market.closingStrength > 20 ? "col-g" : market.closingStrength < -20 ? "col-r" : "col-y"}>
                      {market.closingStrength != null ? `${market.closingStrength.toFixed(0)}%` : "—"}
                    </div>
                    <div style={{ marginTop: 8, fontSize: 11, color: "var(--txt2)" }}>{market.closingStrength > 20 ? "Closing near highs — bullish overnight" : market.closingStrength < -20 ? "Closing near lows — weak close" : "Mid-range close"}</div>
                    <div style={{ marginTop: 12, fontSize: 10, color: "var(--txt3)" }}>ES Futures (placeholder): {market.futures != null ? fmtPct(market.futures) : "—"}</div>
                  </div>
                )}

                <div className="panel">
                  <div className="panel-title">SPX Today</div>
                  <MiniSparkline candles={candles} />
                  <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--txt2)" }}>
                    <span>H: {market.spx?.high?.toFixed(0)}</span>
                    <span>L: {market.spx?.low?.toFixed(0)}</span>
                    <span>RSI: {market.rsi?.toFixed(0) ?? "—"}</span>
                    <span>Vol: {market.volumeRatio != null ? `${(market.volumeRatio * 100).toFixed(0)}%` : "—"}</span>
                  </div>
                </div>
              </div>

              {/* AI read */}
              <div className="ai-panel">
                <div className="ai-header">
                  <span className="ai-label">AI Market Read</span>
                  <button className="ai-get-btn" onClick={() => getAI(market, activeSignal)} disabled={aiLoading}>
                    {aiLoading ? "Thinking…" : "Get Read"}
                  </button>
                </div>
                {aiLoading ? <div className="ai-loading"><span className="loading-dot" /> Analyzing market conditions…</div>
                  : aiRead ? <div className="ai-text">{aiRead}</div>
                  : <div className="ai-loading" style={{ color: "var(--txt3)" }}>Tap "Get Read" for AI analysis of current conditions</div>}
              </div>

              {/* log thesis */}
              <button className="log-btn" onClick={() => setShowThesis(true)}>+ Log Thesis & Trade Plan</button>

              {/* benchmarks */}
              <div style={{ fontSize: 9, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: 2, marginBottom: 10 }}>Today vs Benchmarks</div>
              <div className="bench-grid">
                {[["SPY", market.spy], ["QQQ", market.qqq], ["AAPL", market.aapl]].map(([name, q]) => (
                  <div key={name} className="bench-card">
                    <div className="bench-name">{name}</div>
                    <div className={clsx("bench-val", q?.changePct >= 0 ? "col-g" : "col-r")}>{q ? fmtPct(q.changePct) : "—"}</div>
                    <div className="bench-vs" style={{ color: "var(--txt3)" }}>{q?.price?.toFixed(2)}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── THESIS LOG ── */}
          {tab === "thesis" && (
            <>
              <button className="log-btn" onClick={() => setShowThesis(true)}>+ New Thesis Entry</button>
              {thesisLog.length === 0
                ? <div className="empty">No thesis entries yet. Log your first trade read in the Cockpit.</div>
                : [...thesisLog].reverse().map(e => (
                  <ThesisCard key={e.id} entry={e} onOutcome={(id) => setOutcomeFor(id)} />
                ))}
            </>
          )}

          {/* ── PERFORMANCE ── */}
          {tab === "performance" && (
            <>
              <div style={{ fontSize: 9, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: 2, marginBottom: 12 }}>SPX Credit Spread Income</div>
              {perf ? (
                <>
                  <div className="metrics-row" style={{ gridTemplateColumns: "repeat(3,1fr)", marginBottom: 16 }}>
                    <MetricTile label="Total P&L" value={fmt$(perf.totalPnl, 0)} accent={perf.totalPnl >= 0 ? "col-g" : "col-r"} />
                    <MetricTile label="Win Rate" value={`${perf.winRate.toFixed(0)}%`} sub={`${perf.wins}/${perf.total}`} accent="col-b" />
                    <MetricTile label="Rule Breaks → Loss" value={perf.flaggedLosses} sub={`of ${perf.flagged} flagged`} accent={perf.flaggedLosses > 0 ? "col-r" : "col-g"} />
                  </div>
                  <div className="panel" style={{ marginBottom: 16 }}>
                    <div className="panel-title">Discipline Insight</div>
                    {perf.flagged > 0 && (
                      <div className="perf-row">
                        <span className="perf-k">Flagged trades that lost</span>
                        <span className={perf.flaggedLosses > 0 ? "col-r" : "col-g"}>{Math.round((perf.flaggedLosses / perf.flagged) * 100)}%</span>
                      </div>
                    )}
                    <div className="perf-row">
                      <span className="perf-k">Logged trades</span>
                      <span>{perf.total}</span>
                    </div>
                  </div>
                </>
              ) : (
                <div className="empty">Log thesis entries and outcomes to see performance tracking.</div>
              )}
              <div style={{ fontSize: 9, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: 2, marginBottom: 12, marginTop: 8 }}>Benchmark Comparison (Import CSV for full view)</div>
              <div className="panel">
                <div className="perf-row"><span className="perf-k">Import your E*Trade CSV</span><span style={{ color: "var(--B)" }}>→ See spread-level P&L vs SPY/QQQ/AAPL</span></div>
                <div className="perf-row"><span className="perf-k">Capital deployed</span><span>$100,000</span></div>
                <div className="perf-row"><span className="perf-k">Strategy</span><span>SPX credit spreads (60/40 tax)</span></div>
              </div>
            </>
          )}

        </div>
      </div>

      {/* thesis modal */}
      {showThesis && (
        <ThesisModal
          mode={activeMode}
          marketData={market}
          signal={activeSignal}
          onSave={(entry) => setThesisLog(l => [...l, { ...entry, id: Date.now() }])}
          onClose={() => setShowThesis(false)}
        />
      )}

      {/* outcome modal */}
      {outcomeFor && (
        <OutcomeModal
          entryId={outcomeFor}
          onSave={(id, outcome) => setThesisLog(l => l.map(e => e.id === id ? { ...e, ...outcome } : e))}
          onClose={() => setOutcomeFor(null)}
        />
      )}
    </>
  );
}
