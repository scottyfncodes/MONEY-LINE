import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { audio } from '../audio/audio';
import { TIME, fmtMoney } from '../sim/config';
import { availableCredit, avgDaily, creditLimit } from '../sim/economy';
import { OBJECTIVES } from '../sim/objectives';
import { dateLabel } from '../sim/sim';
import { useUI, type Tool } from '../store';
import { GameView, theWorld } from './GameView';
import { SidePanel } from './Panels';

const ICONS: Record<Tool, ReactNode> = {
  inspect: <><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l6 6" /></>,
  survey: <><rect x="8" y="3" width="9" height="5" rx="1" /><path d="M12 8v5M12 13l-5 8M12 13l5 8M5 5.5h3" /></>,
  terrain: <><path d="M2 19l6-10 4 6 3-4 7 8z" /><path d="M6.5 11.5l1.5 1 1.5-1" /></>,
  rail: <><path d="M8 2l-2 20M16 2l2 20M7 7h10M6.6 12h10.8M6.2 17h11.6" /></>,
  build: <><path d="M4 20L14 10" /><path d="M12 6l6 6 3-3-6-6z" /></>,
  trains: <><rect x="5" y="4" width="14" height="13" rx="2" /><path d="M5 11h14M8 21l2-4M16 21l-2-4" /><circle cx="9" cy="14" r=".8" /><circle cx="15" cy="14" r=".8" /></>,
  finance: <><path d="M6 3h9l4 4v14H6z" /><path d="M9 10h7M9 13.5h7M9 17h4" /></>,
  works: <><circle cx="12" cy="12" r="3.2" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" /></>,
};
const TOOLS: Array<[Tool, string, string]> = [
  ['inspect', 'Inspect', 'Look at anything in the valley'], ['survey', 'Survey', 'Prospect ground, survey deposits, file claims'],
  ['terrain', 'Terrain', 'Excavate, fill, grade, blast, clear'], ['rail', 'Railroad', 'Lay or lift track'],
  ['build', 'Build', 'Mines, mills and platforms'], ['trains', 'Trains', 'Engines, hoppers and services'],
  ['finance', 'Finance', 'Bank, books and market'], ['works', 'Works', 'Improvements'],
];
function Icon({ tool }: { tool: Tool }) { return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[tool]}</svg>; }

function TopBar() {
  const g = useUI((s) => s.game)!;
  const speed = useUI((s) => s.speed);
  const set = useUI((s) => s.set);
  const setTool = useUI((s) => s.setTool);
  const menu = useUI((s) => s.menu);
  useUI((s) => s.rev);
  const f = g.finance, pl = avgDaily(g);
  const stat = (label: string, value: string, tone = '', extra?: string) => (
    <button type="button" className="stat" onClick={() => { if (useUI.getState().tool !== 'finance') setTool('finance'); }} title="Open Finance">
      <span className="lab">{label}</span><span className={`val ${tone}`}>{value}{extra && <small> {extra}</small>}</span>
    </button>
  );
  return (
    <header className="topbar">
      <button type="button" className="brand" onClick={() => set({ menu: !menu })} aria-expanded={menu} aria-label="MONEY LINE menu">MONEY LINE</button>
      <div className="stats">
        {stat('Cash', fmtMoney(f.cash), f.cash < 0 ? 'bad' : '')}
        {stat('Debt', fmtMoney(f.debt), f.debt > 0 ? 'debt' : '')}
        {stat('Credit', fmtMoney(availableCredit(g)), '', `of ${fmtMoney(creditLimit(g))}`)}
        {stat('Daily P/L', `${pl >= 0 ? '+ ' : '− '}${fmtMoney(Math.abs(pl))}`, pl >= 0 ? 'good' : 'bad')}
      </div>
      <div className="clock"><span className="lab">Day {g.day + 1}</span><span className="val">{dateLabel(g.day)}</span></div>
      <div className="speeds" role="group" aria-label="Game speed">
        {[['Pause', <path key="p" d="M8 5v14M16 5v14" strokeWidth="3" />], ['Run', <path key="r" d="M8 5l11 7-11 7z" fill="currentColor" />], ['Fast', <path key="f" d="M4 6l8 6-8 6zM13 6l8 6-8 6z" fill="currentColor" />], ['Faster', <path key="ff" d="M2 6l7 6-7 6zM9 6l7 6-7 6zM16 6l6 6-6 6z" fill="currentColor" />]].map(([name, icon], i) => (
          <button type="button" key={i} className={speed === i ? 'on' : ''} onClick={() => set({ speed: i })} aria-pressed={speed === i} aria-label={`${name}${i ? ` (${TIME.speeds[i]}×)` : ''}`} title={`${name}${i ? ` ${TIME.speeds[i]}×` : ''}`}>
            <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" fill="none" aria-hidden="true">{icon}</svg>
          </button>
        ))}
      </div>
    </header>
  );
}

function ToolRail() {
  const tool = useUI((s) => s.tool);
  const setTool = useUI((s) => s.setTool);
  return (
    <nav className="rail" aria-label="Tools">
      {TOOLS.map(([id, name, tip]) => (
        <button type="button" key={id} className={tool === id ? 'on' : ''} onClick={() => { void audio.unlock(); audio.play('click', 0.4); setTool(id); }} aria-pressed={tool === id} title={tip}>
          <Icon tool={id} /><span>{name}</span>
        </button>
      ))}
    </nav>
  );
}

function Objectives() {
  const g = useUI((s) => s.game)!;
  useUI((s) => s.rev);
  const [open, setOpen] = useState(true);
  const cur = OBJECTIVES[g.objective];
  return (
    <section className={`objectives ${open ? '' : 'shut'}`} aria-label="Objectives">
      <button type="button" className="objhead" onClick={() => setOpen(!open)} aria-expanded={open}>
        <h2>Objectives</h2><em>{Math.min(g.objective + 1, OBJECTIVES.length)} of {OBJECTIVES.length}</em>
      </button>
      {open && (cur ? (
        <div className="objbody">
          {g.objective > 0 && <p className="done"><i aria-hidden="true">☒</i>{OBJECTIVES[g.objective - 1].title}</p>}
          <p className="now"><i aria-hidden="true">☐</i>{cur.title}</p>
          <p className="why">{cur.why}</p>
          <p className="how">{cur.how}</p>
          {cur.progress?.(g) && <p className="prog">{cur.progress(g)}</p>}
          {OBJECTIVES[g.objective + 1] && <p className="next"><i aria-hidden="true">☐</i>{OBJECTIVES[g.objective + 1].title}</p>}
        </div>
      ) : <div className="objbody"><p className="now">The line is yours.</p><p className="why">Every objective is met. The valley is open: deposits run out, markets turn, and there is always another ridge.</p></div>)}
    </section>
  );
}

function Toasts() {
  const toasts = useUI((s) => s.toasts);
  useUI((s) => s.rev);
  const now = performance.now();
  return <div className="toasts" role="status" aria-live="polite">{toasts.filter((t) => t.until > now).map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>;
}

function Minimap() {
  const ref = useRef<HTMLCanvasElement>(null);
  const rev = useUI((s) => s.rev);
  useEffect(() => { const c = ref.current; if (!c || !theWorld || rev % 2) return; const ctx = c.getContext('2d'); if (ctx) theWorld.drawMap(ctx, c.width); }, [rev]);
  const go = (e: React.PointerEvent<HTMLCanvasElement>) => { const r = e.currentTarget.getBoundingClientRect(); theWorld?.focus(((e.clientX - r.left) / r.width) * 128, ((e.clientY - r.top) / r.height) * 128); };
  return (
    <div className="minimap">
      <canvas ref={ref} width={176} height={176} onPointerDown={go} onPointerMove={(e) => e.buttons && go(e)} aria-label="Overview map. Click to move the view." />
      <div className="mapbtns">
        <button type="button" onClick={() => theWorld?.rotate(Math.PI / 4)} aria-label="Rotate view left" title="Rotate (Q)">↺</button>
        <button type="button" onClick={() => theWorld?.rotate(-Math.PI / 4)} aria-label="Rotate view right" title="Rotate (E)">↻</button>
        <button type="button" onClick={() => theWorld?.zoom(0.75)} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => theWorld?.zoom(1.33)} aria-label="Zoom out">−</button>
      </div>
    </div>
  );
}

export function Credit() { return <span className="credit" data-haveanapp>by HaveAnApp</span>; }

function HowTo({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="How to play">
      <div className="sheet">
        <header><h2>How the line pays</h2><button type="button" className="x" onClick={onClose} aria-label="Close">×</button></header>
        <ol className="steps">
          <li><b>Borrow.</b> Finance → draw on the credit line. Interest is charged every day.</li>
          <li><b>Lay track.</b> Railroad → click the terminal, then the claim. Drag the markers until the estimate suits you, then sign. Crews build it day by day.</li>
          <li><b>Open the mine.</b> Build → Mine on the claim, then a Platform on the track beside it. Rough ground has to be graded first.</li>
          <li><b>Haul and sell.</b> Your engine runs the service by itself. Every shipment is sold at the city market at the day's price.</li>
          <li><b>Mill it.</b> A stamp mill turns eight tons of ore into one of concentrate. Then improve the works, and look beyond the ridge.</li>
        </ol>
        <dl className="keys">
          <dt>Drag</dt><dd>move the view</dd><dt>Right-drag, Q / E</dt><dd>rotate</dd><dt>Wheel</dt><dd>zoom</dd><dt>W A S D</dt><dd>move</dd>
          <dt>Space</dt><dd>pause</dd><dt>1 2 3</dt><dd>speed</dd><dt>Esc</dt><dd>put the tool down</dd>
        </dl>
      </div>
    </div>
  );
}

function Menu() {
  const ui = useUI();
  const g = ui.game!;
  if (!ui.menu) return null;
  const item = (label: string, fn: () => void) => <button type="button" onClick={fn}>{label}</button>;
  return (
    <div className="menu" role="menu">
      {item('Save now', () => { void ui.save().then(() => ui.toast('good', 'Saved.')); ui.set({ menu: false }); })}
      {item(ui.sound ? 'Sound: on' : 'Sound: off', () => { void audio.unlock(); audio.setEnabled(!ui.sound); ui.set({ sound: !ui.sound }); })}
      {item(ui.music ? 'Music: on' : 'Music: off', () => { void audio.unlock(); audio.setMusic(!ui.music); ui.set({ music: !ui.music }); })}
      {item('How to play', () => ui.set({ help: true, menu: false }))}
      {item('Back to title', () => { void ui.save().then(() => ui.probeSave()); ui.set({ screen: 'title', menu: false }); })}
      <p>World seed {g.seed} · saved automatically <Credit /></p>
    </div>
  );
}

function Receivership() {
  const ui = useUI();
  const g = ui.game!;
  if (!g.finance.receivership) return null;
  return (
    <div className="modal" role="alertdialog" aria-modal="true" aria-label="Receivership">
      <div className="sheet">
        <header><h2>Receivership</h2></header>
        <p>Forty-five days without cash or credit. The bank has taken the line, {fmtMoney(g.finance.debt)} of debt still on it, on day {g.day + 1}.</p>
        <div className="btnrow">
          {!g.finance.restructured && <button type="button" className="btn primary" onClick={() => ui.run({ type: 'restructure' })}>Plead for a restructuring</button>}
          <button type="button" className="btn" onClick={() => ui.startNew()}>Start a new venture</button>
        </div>
      </div>
    </div>
  );
}

function Title() {
  const ui = useUI();
  const [help, setHelp] = useState(false);
  useEffect(() => { void ui.probeSave(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const begin = (fn: () => void) => { void audio.unlock(); audio.play('click', 0.5); fn(); };
  return (
    <main className="title">
      <div className="cert">
        <p className="over">The Prosperity &amp; Sawtooth Railroad and Mining Company</p>
        <h1>MONEY LINE</h1>
        <p className="tag">Dig Deep. Lay Track. Strike Rich.</p>
        <div className="orn" aria-hidden="true"><span /><svg viewBox="0 0 48 16" width="48" height="16"><path d="M2 14h44M8 14V7h6v7M14 9h14V5h6v9M30 5V2h3v3" fill="none" stroke="currentColor" strokeWidth="1.2" /><circle cx="12" cy="14" r="2" fill="currentColor" /><circle cx="24" cy="14" r="2" fill="currentColor" /><circle cx="32" cy="14" r="2" fill="currentColor" /></svg><span /></div>
        <p className="premise">The year is 1890. There is gold in the Sawtooth. The bank will lend you sixty thousand dollars.</p>
        <div className="actions">
          <button type="button" className="btn primary big" onClick={() => begin(() => ui.startNew())}>New Venture</button>
          <button type="button" className="btn big" disabled={!ui.saveInfo} onClick={() => begin(() => { void ui.continueGame(); })}>
            Continue{ui.saveInfo && <small>Day {ui.saveInfo.day + 1} · {fmtMoney(ui.saveInfo.cash)}</small>}
          </button>
        </div>
        <div className="minor">
          <button type="button" onClick={() => { const on = !ui.sound; void audio.unlock(); audio.setEnabled(on); ui.set({ sound: on }); }} aria-pressed={ui.sound}>Sound: {ui.sound ? 'on' : 'off'}</button>
          <button type="button" onClick={() => setHelp(true)}>How to play</button>
        </div>
        <Credit />
      </div>
      {help && <HowTo onClose={() => setHelp(false)} />}
    </main>
  );
}

class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) { return { error: e.message }; }
  render() {
    if (!this.state.error) return this.props.children;
    return <main className="title"><div className="cert"><h1>MONEY LINE</h1><p className="premise">The game hit a problem and stopped: {this.state.error}. Your last autosave is intact.</p><div className="actions"><button type="button" className="btn primary big" onClick={() => location.reload()}>Reload</button></div></div></main>;
  }
}

export function App() {
  const screen = useUI((s) => s.screen);
  const help = useUI((s) => s.help);
  const set = useUI((s) => s.set);
  return (
    <Boundary>
      {screen === 'title' ? <Title /> : (
        <div className="game">
          <GameView />
          <TopBar /><Menu /><ToolRail /><Objectives /><SidePanel /><Minimap /><Toasts /><Receivership />
          {help && <HowTo onClose={() => set({ help: false })} />}
        </div>
      )}
    </Boundary>
  );
}
