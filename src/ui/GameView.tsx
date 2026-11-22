import { useEffect, useRef } from 'react';
import { audio } from '../audio/audio';
import { World } from '../render/world';
import { suggestRoute } from '../sim/autoroute';
import { MILL, MINE, STATION, SURVEY, TIME, TRACK, fmtMoney } from '../sim/config';
import { millSite, mineSite } from '../sim/facilities';
import { findSnap } from '../sim/rail';
import { tick } from '../sim/sim';
import { extendWay, strokeToWay } from '../sim/stroke';
import { heightAt, isWater, planTerrainOp } from '../sim/terrain';
import type { GameState } from '../sim/types';
import { isPhone, useUI, type Selection } from '../store';

const TONE = { excavate: 0xe0a34a, fill: 0x8fbf6a, grade: 0xf4ecd8, blast: 0xd9614e, clear: 0xb7d08a } as const;

function pickEntity(g: GameState, world: World, hit: { x: number; z: number }): Selection {
  const near = (o: { x: number; z: number }, r: number) => Math.hypot(o.x - hit.x, o.z - hit.z) <= r;
  for (const t of g.trains) { const p = world.trainPos(t.id); if (p && near(p, 1.7)) return { kind: 'train', id: t.id }; }
  for (const m of g.mines) if (near(m, 2.1)) return { kind: 'mine', id: m.id };
  for (const m of g.mills) if (near(m, 2.1)) return { kind: 'mill', id: m.id };
  for (const s of g.stations) if (!s.city && near(s, 1.6)) return { kind: 'station', id: s.id };
  if (near(g.city, g.city.radius)) return { kind: 'city' };
  for (const d of g.deposits) if (d.discovered && near(d, d.radius * 0.75)) return { kind: 'deposit', id: d.id };
  let best = 1.0, edge = -1;
  for (const e of g.edges) for (let i = 0; i < e.pts.length; i += 2) { const d = Math.hypot(e.pts[i].x - hit.x, e.pts[i].z - hit.z); if (d < best) { best = d; edge = e.id; } }
  if (edge >= 0) return { kind: 'edge', id: edge };
  return { kind: 'terrain', x: hit.x, z: hit.z };
}

export function selectionPoint(g: GameState, world: World | null, sel: Selection | null): { x: number; z: number; r: number } | null {
  if (!sel) return null;
  switch (sel.kind) {
    case 'train': { const p = world?.trainPos(sel.id); return p ? { ...p, r: 1.1 } : null; }
    case 'mine': { const m = g.mines.find((x) => x.id === sel.id); return m ? { x: m.x, z: m.z, r: 2.2 } : null; }
    case 'mill': { const m = g.mills.find((x) => x.id === sel.id); return m ? { x: m.x, z: m.z, r: 2.2 } : null; }
    case 'station': { const m = g.stations.find((x) => x.id === sel.id); return m ? { x: m.x, z: m.z, r: 1.6 } : null; }
    case 'deposit': { const m = g.deposits.find((x) => x.id === sel.id); return m ? { x: m.x, z: m.z, r: m.radius } : null; }
    case 'city': return { x: g.city.x, z: g.city.z, r: g.city.radius + 0.5 };
    case 'terrain': return { x: sel.x, z: sel.z, r: 0.6 };
    default: return null;
  }
}

export let theWorld: World | null = null;

type XZ = { x: number; z: number };
/** How close to the lode a line has to end for the claim to count as reached (the gold ring on the ground). */
export const CLAIM_RING = 6.5;
export const ownClaim = (g: GameState) => g.deposits.find((d) => d.owned && d.resource === 'gold') ?? null;
/** Where a new line may be drawn from: the terminal, and every loose end of the track. */
export function lineStarts(g: GameState): XZ[] {
  const ends = g.nodes.filter((n) => n.id !== g.city.node && g.edges.filter((e) => e.a === n.id || e.b === n.id).length === 1);
  const city = g.nodes.find((n) => n.id === g.city.node);
  return [...(city ? [city] : []), ...ends].slice(0, 6).map((n) => ({ x: n.x, z: n.z }));
}
/** What the engineer's refusal comes to, in the few words that fit beside a fingertip. */
export function briefError(e: string): string {
  if (e.startsWith('Too steep')) return 'Too steep: swing wider to climb';
  if (e.startsWith('Curve too sharp')) return 'Curve too sharp';
  if (e.startsWith('Too short')) return 'Keep going';
  if (e.startsWith('The grade line dips')) return 'Too low over the river';
  if (e.startsWith('The line runs through')) return 'Go around the works';
  if (e.startsWith('The line leaves')) return 'Off the map';
  if (e.startsWith('Both track gangs')) return 'Both gangs are busy';
  return e.split('. ')[0];
}

/** The margins the interface takes from the view, so framing puts things where they can be seen and touched. */
function clearInsets(panel: boolean, tool: boolean) {
  const bar = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 64;
  if (isPhone()) {
    // with a map tool in hand the objective folds to one line and the tool's strip sits above the tool bar
    const card = tool ? bar + 58 : document.querySelector('.objectives')?.getBoundingClientRect().bottom ?? bar + 58;
    return { top: card + (tool ? 56 : 26), right: 40, bottom: 57 + (tool ? 184 : 18), left: 40 };
  }
  return { top: bar + 80, right: (panel ? 372 + 16 : 0) + 80, bottom: 80, left: 76 + 32 + 70 };
}
/** Show the ground the first line has to cross: the terminal at the near edge, the claim at the far one. */
export function frameOpening(instant = false, panel = false, tool = true) {
  const w = theWorld, g = useUI.getState().game; if (!w || !g) return;
  const gold = ownClaim(g) ?? g.deposits[0], n = g.nodes.find((x) => x.id === g.city.node) ?? g.city;
  const c = document.querySelector('canvas.world') as HTMLCanvasElement | null;
  // on an upright screen the valley is turned so the line runs away from the player: a stroke straight up the glass
  const upright = !!c && c.clientWidth / c.clientHeight < 0.8;
  const yaw = upright ? Math.atan2(-(gold.x - n.x), -(gold.z - n.z)) : w.cam.yaw;
  const ring = [0, 1, 2, 3].map((k) => ({ x: gold.x + Math.cos(k * 1.5708) * CLAIM_RING, z: gold.z + Math.sin(k * 1.5708) * CLAIM_RING }));
  // and looked at more from above, as a map is, so a finger lands where it means to
  // with no tool in hand it is enough to see both ends; with one, the whole ring has to be within reach
  w.fit(tool ? [n, { x: g.city.x, z: g.city.z }, ...ring] : [n, gold], clearInsets(panel, tool), yaw, instant, upright ? 0.92 : w.cam.pitch);
}
/** Open on what the company owns. Before the claim is reached that is the crossing; afterwards, the whole line. */
export function frameVenture(instant = false) {
  const w = theWorld, g = useUI.getState().game; if (!w || !g) return;
  if (!g.stats.reachedClaim) return frameOpening(instant, false, false);
  w.fit([{ x: g.city.x, z: g.city.z }, ...g.nodes, ...g.mines, ...g.jobs.map((j) => j.pts[j.pts.length - 1])], clearInsets(false, false), w.cam.yaw, instant);
}

export function GameView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLDivElement>(null);
  const handlesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ui = useUI.getState;
    const world = new World(canvas, ui().game!);
    theWorld = world;
    let game = ui().game!;
    frameVenture(true);
    let raf = 0, last = performance.now(), acc = 0, lastBump = 0, lastSave = performance.now(), labelKey = '', handleKey = '';
    const handles: Array<{ el: HTMLDivElement; x: number; z: number }> = [];
    const keys = new Set<string>();
    let hover: { x: number; z: number } | null = null;
    let gradeTarget: number | null = null;
    const labels = new Map<string, { el: HTMLDivElement; x: number; z: number; lift: number }>();

    const rebuildLabels = () => {
      const host = labelsRef.current!; host.innerHTML = ''; labels.clear();
      const add = (key: string, text: string, cls: string, x: number, z: number, lift: number) => {
        const el = document.createElement('div'); el.className = `maplabel ${cls}`; el.textContent = text; host.appendChild(el);
        labels.set(key, { el, x, z, lift });
      };
      add('city', game.city.name, 'city', game.city.x, game.city.z, 2.2);
      for (const s of game.stations) if (!s.city) add('st' + s.id, s.name, 'station', s.x, s.z, 1.3);
      for (const d of game.deposits) {
        if (d.discovered) add('d' + d.id, d.name, `deposit ${d.resource}${d.owned ? ' owned' : ''}`, d.x, d.z, 2.3);
        else if (d.rumor) add('r' + d.id, 'Rumoured silver', 'rumour', d.rumor.x, d.rumor.z, 1.5);
      }
    };

    /** The grips a line is drawn from, as marks on the map: where to start, and where to carry on. */
    const rebuildHandles = () => {
      const host = handlesRef.current!; host.innerHTML = ''; handles.length = 0;
      const st = ui(); if (st.tool !== 'rail' || st.lifting || st.drawing) return;
      const add = (cls: string, p: XZ, text: string | null) => {
        const el = document.createElement('div'); el.className = `grip ${cls}`;
        el.appendChild(document.createElement('i'));
        if (text) { const b = document.createElement('b'); b.textContent = text; el.appendChild(b); }
        host.appendChild(el); handles.push({ el, x: p.x, z: p.z });
      };
      if (st.way.length === 0) lineStarts(game).forEach((p, i) => add('start', p, i === 0 && game.edges.length === 0 ? 'Drag from here' : null));
      else if (st.way.length === 1) add('start', st.way[0], 'Drag from here');
      else {
        const end = st.way[st.way.length - 1], gold = ownClaim(game);
        const short = !game.stats.reachedClaim && !!gold && !st.line?.end && Math.hypot(end.x - gold.x, end.z - gold.z) > CLAIM_RING;
        add('end', end, short ? 'Drag on from here' : null);
      }
    };

    const drainEvents = () => {
      for (const e of game.events) {
        if (e.type === 'blast') { world.burst('blast', e.x, e.z); audio.play('explosion', 0.55, 0.9 + Math.random() * 0.2); }
        else if (e.type === 'dig') { world.burst('dig', e.x, e.z); audio.play('hit', 0.3, 0.8 + Math.random() * 0.4); }
        else if (e.type === 'sale') {
          world.burst('sale', e.x, e.z); audio.play('coin', 0.6); ui().toast('good', `Shipment sold: ${fmtMoney(e.amount)}`);
          // the money lands where the player reads it: the cash figure rings gold for a moment
          const cash = document.querySelector('.stat'); if (cash) { cash.classList.remove('paid'); void (cash as HTMLElement).offsetWidth; cash.classList.add('paid'); }
          // a gold plate under the bar states the amount (its own element, so nothing can clip it)
          document.querySelector('.paidplate')?.remove();
          const plate = document.createElement('div'); plate.className = 'paidplate'; plate.textContent = `+ ${fmtMoney(e.amount)}`; plate.setAttribute('role', 'status');
          document.querySelector('.game')?.appendChild(plate); setTimeout(() => plate.remove(), 4600);
        }
        else if (e.type === 'built') { world.burst('build', e.x, e.z); audio.play('thud', 0.5); }
        else if (e.type === 'depart') audio.whistle(0.16);
        else if (e.type === 'arrive') audio.play('whoosh', 0.3);
        else if (e.type === 'objective') audio.play('coin', 0.4, 1.3);
        else if (e.type === 'discovery') audio.play('coin', 0.5, 0.8);
      }
      game.events.length = 0;
    };
    let lastNote = game.notes.length ? game.notes[game.notes.length - 1].id : 0;
    const surfaceNotes = () => {
      for (const n of game.notes) if (n.id > lastNote) { lastNote = n.id; if (!n.text.startsWith('First shipment') ) ui().toast(n.kind, n.text); }
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const st = ui();
      if (st.game && st.game !== game) { game = st.game; world.setState(game); labelKey = ''; handleKey = ''; lastNote = game.notes.length ? game.notes[game.notes.length - 1].id : 0; frameVenture(true); }
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const mul = game.finance.receivership ? 0 : TIME.speeds[st.speed];
      acc += (dt * mul * TIME.ticksPerDay) / TIME.secondsPerDay;
      let n = 0;
      while (acc >= 1 && n < 80) { tick(game); acc -= 1; n++; }
      if (n >= 80) acc = 0;
      drainEvents(); surfaceNotes();

      // keyboard camera
      const f = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
      const r = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
      if (f || r) world.move(f * dt * 60, r * dt * 60);
      if (keys.has('q')) world.rotate(dt * 1.4); if (keys.has('e')) world.rotate(-dt * 1.4);

      // tool previews
      const sel = selectionPoint(game, world, st.selection);
      world.setPreview({
        route: st.tool === 'rail' && st.line && st.way.length >= 2 ? { pts: st.line.plan.pts, valid: !st.line.error, way: st.way } : st.tool === 'rail' && st.way.length === 1 ? { pts: [], valid: true, way: st.way } : null,
        brush: st.tool === 'terrain' && hover ? { x: hover.x, z: hover.z, radius: st.brush, color: TONE[st.terrainTool] } : null,
        ghost: st.tool === 'build' && hover && st.buildKind !== 'platform' ? { x: Math.round(hover.x), z: Math.round(hover.z), half: 1.5, ok: (st.buildKind === 'mine' ? mineSite(game, Math.round(hover.x), Math.round(hover.z)).error : millSite(game, Math.round(hover.x), Math.round(hover.z)).error) == null } : null,
        target: st.tool === 'rail' && !st.lifting && !game.stats.reachedClaim && ownClaim(game) ? { x: ownClaim(game)!.x, z: ownClaim(game)!.z, r: CLAIM_RING } : null,
        ring: st.tool === 'survey' && hover ? { x: hover.x, z: hover.z, r: SURVEY.prospectRadius, color: 0xf0c84a } : st.tool === 'build' && st.buildKind === 'platform' && hover ? { x: hover.x, z: hover.z, r: STATION.serviceRadius, color: 0xf4ecd8 } : null,
        select: sel,
      });
      world.frame(Math.min(1, acc), dt);

      // exhaust beat for the nearest moving engine
      for (const t of game.trains) if (t.trip) { const p = world.trainPos(t.id); if (p) { const near = Math.max(0, 1 - (Math.hypot(p.x - world.cam.x, p.z - world.cam.z) + world.cam.dist * 0.6) / 60); audio.chuff(now / 1000, t.speed * mul, near); break; } }

      // map labels
      const lk = `${game.rev.structures}|${game.stations.length}|${game.deposits.map((d) => (d.discovered ? 1 : 0) + (d.owned ? 2 : 0)).join('')}`;
      if (lk !== labelKey) { labelKey = lk; rebuildLabels(); }
      const far = world.cam.dist > 95;
      for (const l of labels.values()) {
        const p = world.project(l.x, l.z, l.lift);
        l.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
        l.el.style.opacity = p.visible && !(far && l.el.classList.contains('station')) ? '1' : '0';
      }
      const end = st.way[st.way.length - 1];
      const hk = st.tool !== 'rail' || st.lifting ? '' : `${st.way.length}|${st.drawing}|${game.rev.track}|${game.edges.length}|${end ? `${end.x},${end.z}` : ''}|${st.line?.end ? 1 : 0}|${game.stats.reachedClaim}`;
      if (hk !== handleKey) { handleKey = hk; rebuildHandles(); }
      for (const h of handles) {
        const p = world.project(h.x, h.z, 0.3);
        h.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
        h.el.style.opacity = p.visible ? '1' : '0';
      }
      if (now - lastBump > 240) { lastBump = now; st.bump(); }
      if (now - lastSave > 20000) { lastSave = now; void st.save(); }
    };
    raf = requestAnimationFrame(frame);

    // ── pointer input ──
    const ptrs = new Map<number, { x: number; y: number }>();
    interface Press {
      x: number; y: number; button: number; moved: boolean; touch: boolean; lastPaint: number;
      /** index of the waypoint being dragged, or −1 */
      way: number; kept: boolean; paint: boolean;
      /** a line is being drawn: the waypoints it grows from, the line as it was, and the stroke so far */
      draw: XZ[] | null; before: XZ[]; undo: XZ[][]; stroke: XZ[]; atClaim: boolean;
    }
    let down: Press | null = null;
    let pinch = 0, pinchAngle = 0;

    const setChip = (text: string | null, tone: 'ok' | 'bad' | 'info' = 'info') => {
      const el = chipRef.current!; if (!text) { el.style.opacity = '0'; return; }
      el.textContent = text; el.dataset.tone = tone; el.style.opacity = '1';
    };
    /** Beside the mouse pointer; above a fingertip, where the hand does not hide it. */
    const moveChip = (x: number, y: number, touch = false) => {
      const r = canvas.getBoundingClientRect(), el = chipRef.current!;
      el.style.transform = touch
        ? `translate(${Math.max(96, Math.min(r.width - 96, x - r.left))}px, ${Math.max(150, y - r.top - 58)}px) translate(-50%, -100%)`
        : `translate(${x - r.left + 18}px, ${y - r.top + 18}px)`;
    };
    const grabPx = (touch: boolean) => (touch ? 34 : 18);
    const nearPx = (p: XZ, x: number, y: number, r: number) => { const rc = canvas.getBoundingClientRect(), q = world.project(p.x, p.z, 0.3); return Math.hypot(q.x - (x - rc.left), q.y - (y - rc.top)) < r; };
    /** Track within a fingertip of a point on the ground, however far the view is pulled back. */
    const snapNear = (hit: XZ, touch: boolean) => findSnap(game, hit.x, hit.z, Math.max(TRACK.snapRadius, world.cellsPerPx() * grabPx(touch)));

    /** If a press lands where a line can be drawn from, the waypoints that line will grow from. */
    const drawBase = (x: number, y: number, touch: boolean): XZ[] | null => {
      const st = ui(); if (st.tool !== 'rail' || st.lifting) return null;
      if (st.way.length >= 1) return nearPx(st.way[st.way.length - 1], x, y, grabPx(touch)) ? st.way : null;
      const hit = world.pick(x, y); if (!hit) return null;
      const snap = snapNear(hit, touch);
      return snap ? [{ x: snap.x, z: snap.z }] : null;
    };
    const layStroke = (d: Press) => {
      const way = d.draw!.length >= 2 ? extendWay(d.draw!, d.stroke) : strokeToWay([d.draw![0], ...d.stroke]);
      if (way.length >= 2) ui().setWay(way);
    };
    /** While a line is being drawn the price runs beside the hand, and says when the claim is reached. */
    const drawChip = (d: Press, x: number, y: number) => {
      const st = ui(), line = st.line, gold = ownClaim(game), end = st.way[st.way.length - 1];
      moveChip(x, y, d.touch);
      if (!line || !end) return setChip('Keep going', 'info');
      const at = !game.stats.reachedClaim && !!gold && Math.hypot(end.x - gold.x, end.z - gold.z) <= CLAIM_RING;
      if (at && !d.atClaim) { try { navigator.vibrate?.(12); } catch { /* no haptics */ } audio.play('click', 0.35, 1.4); }
      d.atClaim = at;
      if (isWater(game, end.x, end.z)) setChip('Carry on across the river', 'info');
      else if (line.error) setChip(briefError(line.error), 'bad');
      else setChip(`${at ? 'At the claim · ' : ''}${fmtMoney(line.plan.total)}`, 'ok');
    };

    const updateHover = (x: number, y: number) => {
      const st = ui();
      hover = world.pick(x, y);
      moveChip(x, y);
      if (!hover) return setChip(null);
      if (st.tool === 'terrain') {
        const plan = planTerrainOp(game, { tool: st.terrainTool, x: hover.x, z: hover.z, radius: st.brush, target: gradeTarget ?? heightAt(game, hover.x, hover.z) });
        if (plan.changed === 0 && plan.cleared === 0) setChip(plan.blockedByRock ? 'Bedrock — blast it' : plan.blockedByLock ? 'Protected ground' : 'Nothing to move', 'bad');
        else setChip(`${fmtMoney(plan.cost)}${plan.rockCut > 0.01 ? ' · rock' : ''}${plan.remote > 1.05 ? ' · remote' : ''}`, plan.cost > game.finance.cash ? 'bad' : 'ok');
      } else if (st.tool === 'build') {
        if (st.buildKind === 'platform') { const snap = findSnap(game, hover.x, hover.z, 2.2); setChip(snap ? `Platform · ${fmtMoney(STATION.platformCost)}` : 'Place on finished track', snap ? 'ok' : 'bad'); }
        else { const site = st.buildKind === 'mine' ? mineSite(game, Math.round(hover.x), Math.round(hover.z)) : millSite(game, Math.round(hover.x), Math.round(hover.z)); setChip(site.error ?? `${st.buildKind === 'mine' ? 'Mine' : 'Stamp mill'} · ${fmtMoney(st.buildKind === 'mine' ? MINE.cost : MILL.cost)}`, site.error ? 'bad' : 'ok'); }
      } else if (st.tool === 'survey') setChip(`Prospect this ground · ${fmtMoney(SURVEY.prospectCost)}`, 'info');
      else if (st.tool === 'rail' && !st.lifting) {
        if (st.way.length === 0) { const snap = snapNear(hover, false); setChip(snap ? 'Press and drag to draw the line' : 'Lines start from the terminal or existing track', snap ? 'ok' : 'info'); }
        else if (drawBase(x, y, false)) setChip(st.way.length === 1 ? 'Press and drag to draw the line' : 'Drag to carry the line on', 'ok');
        else if (st.way.length === 1) setChip('Or click where the line should end', 'info');
        else setChip(null);
      } else if (st.tool === 'rail' && st.lifting) setChip('Click a line to lift it', 'bad');
      else setChip(null);
    };

    const paint = (x: number, y: number) => {
      const st = ui(); const hit = world.pick(x, y); if (!hit) return;
      if (gradeTarget == null) gradeTarget = heightAt(game, hit.x, hit.z);
      const r = st.run({ type: 'terrain', op: { tool: st.terrainTool, x: hit.x, z: hit.z, radius: st.brush, target: gradeTarget } }, true);
      if (!r.ok && down && !down.moved) st.toast('bad', r.error ?? '');
    };

    const click = (x: number, y: number, touch: boolean) => {
      const st = ui(); const hit = world.pick(x, y); if (!hit) return;
      void audio.unlock();
      if (st.tool === 'survey') { st.run({ type: 'prospect', x: hit.x, z: hit.z }); return; }
      if (st.tool === 'build') {
        const r = st.run({ type: st.buildKind, x: hit.x, z: hit.z });
        if (r.ok) { const v = r.value as { id: number }; st.set({ selection: { kind: st.buildKind === 'platform' ? 'station' : st.buildKind, id: v.id } }); }
        return;
      }
      if (st.tool === 'rail') {
        if (st.lifting) { const e = pickEntity(game, world, hit); if (e.kind === 'edge') { st.run({ type: 'demolish', edge: e.id }); } else st.toast('info', 'Tap directly on a finished line to lift it.'); return; }
        if (st.way.length === 0) {
          // a press on track is caught earlier and starts a line; this ground has none
          st.toast('info', game.edges.length ? 'A line starts from track you already have. Drag from a gold marker.' : 'The line starts at Prosperity. Drag from the gold marker.');
          const s0 = lineStarts(game)[0]; if (s0 && !world.project(s0.x, s0.z).visible) world.focus(s0.x, s0.z);
          return;
        }
        if (st.way.length === 1) {
          // one tap for the far end: the surveyor finds the way between
          const end = snapNear(hit, touch);
          const to = end ? { x: end.x, z: end.z } : hit;
          const way = suggestRoute(game, st.way[0], to) ?? [st.way[0], to];
          st.keepWay(); st.setWay(way); audio.play('click', 0.4); return;
        }
        // add a waypoint where it bends the existing line least
        let bi = 1, bd = Infinity;
        for (let i = 1; i < st.way.length; i++) {
          const a = st.way[i - 1], b = st.way[i];
          const extra = Math.hypot(hit.x - a.x, hit.z - a.z) + Math.hypot(b.x - hit.x, b.z - hit.z) - Math.hypot(b.x - a.x, b.z - a.z);
          if (extra < bd) { bd = extra; bi = i; }
        }
        const way = st.way.slice(); way.splice(bi, 0, hit); st.keepWay(); st.setWay(way); audio.play('click', 0.4);
        return;
      }
      if (st.tool === 'terrain') return;
      const sel = pickEntity(game, world, hit);
      st.set({ selection: sel, panelOpen: true });
      audio.play('click', 0.3);
    };

    /** A marker in the middle of the line, which can be dragged to bend it. The far end is for drawing on. */
    const waypointAt = (x: number, y: number, touch: boolean): number => {
      const st = ui(); if (st.tool !== 'rail' || st.way.length < 2) return -1;
      for (let i = 0; i < st.way.length - 1; i++) if (nearPx(st.way[i], x, y, touch ? 28 : 16)) return i;
      return -1;
    };
    const stopDrawing = (keep: boolean) => {
      const d = down; if (!d?.draw) return;
      const st = ui();
      if (st.drawing) {
        if (keep) st.set({ drawing: false, wayUndo: [...d.undo.slice(-19), d.before] });
        else { st.setWay(d.before); st.set({ drawing: false, wayUndo: d.undo }); }
      }
      if (d.touch) setChip(null);
    };

    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // a second finger means the player wants to move the view: whatever the first one was drawing is put back
      if (ptrs.size === 2) { stopDrawing(false); const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); pinchAngle = Math.atan2(b.y - a.y, b.x - a.x); down = null; return; }
      const st = ui(), touch = e.pointerType !== 'mouse';
      const draw = e.button === 0 && !keys.has(' ') ? drawBase(e.clientX, e.clientY, touch) : null;
      const way = e.button === 0 && !draw ? waypointAt(e.clientX, e.clientY, touch) : -1;
      const paintMode = e.button === 0 && st.tool === 'terrain' && !touch && !keys.has(' ');
      down = { x: e.clientX, y: e.clientY, button: e.button, moved: false, touch, way, kept: false, paint: paintMode, lastPaint: 0, draw, before: st.way, undo: st.wayUndo, stroke: [], atClaim: false };
      gradeTarget = null;
      if (paintMode) { void audio.unlock(); paint(e.clientX, e.clientY); down.lastPaint = performance.now(); }
    };
    const onMove = (e: PointerEvent) => {
      const prev = ptrs.get(e.pointerId);
      if (prev && ptrs.size === 2) {
        ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
        if (pinch > 0) world.zoom(pinch / d);
        let da = ang - pinchAngle; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
        world.rotate(-da);
        pinch = d; pinchAngle = ang; return;
      }
      if (!down) { if (e.pointerType === 'mouse') updateHover(e.clientX, e.clientY); return; }
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!down.moved && Math.hypot(dx, dy) > (down.touch ? 8 : 5)) down.moved = true;
      if (!down.moved) return;
      if (down.draw) {
        const st = ui();
        if (!st.drawing) { void audio.unlock(); st.set({ drawing: true }); }
        const hit = world.pick(e.clientX, e.clientY), tip = down.stroke[down.stroke.length - 1];
        if (hit && (!tip || Math.hypot(hit.x - tip.x, hit.z - tip.z) > 0.35)) down.stroke.push(hit);
        if (performance.now() - down.lastPaint > 50) { down.lastPaint = performance.now(); layStroke(down); }
        drawChip(down, e.clientX, e.clientY);
        return;
      }
      if (down.way >= 0) {
        const hit = world.pick(e.clientX, e.clientY); const st = ui();
        if (hit && performance.now() - down.lastPaint > 45) { if (!down.kept) { down.kept = true; st.keepWay(); } down.lastPaint = performance.now(); const way = st.way.slice(); way[down.way] = hit; st.setWay(way); }
        return;
      }
      if (down.paint) { if (performance.now() - down.lastPaint > 110) { down.lastPaint = performance.now(); paint(e.clientX, e.clientY); } updateHover(e.clientX, e.clientY); return; }
      if (down.button === 2 || down.button === 1 || e.shiftKey) world.rotate(-(e.clientX - (prev?.x ?? e.clientX)) * 0.006, (e.clientY - (prev?.y ?? e.clientY)) * 0.004);
      else world.pan(e.clientX - (prev?.x ?? e.clientX), e.clientY - (prev?.y ?? e.clientY));
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    };
    const onUp = (e: PointerEvent) => {
      ptrs.delete(e.pointerId);
      if (!down) return;
      const d = down;
      if (d.draw) {
        const st = ui();
        if (d.moved && e.type !== 'pointercancel') {
          const from = d.draw[d.draw.length - 1], tip = d.stroke[d.stroke.length - 1];
          const far = !!tip && Math.hypot(tip.x - from.x, tip.z - from.z) > 2.5;
          if (far) layStroke(d);
          if (far && ui().way.length >= 2) { stopDrawing(true); audio.play('click', 0.45); try { navigator.vibrate?.(8); } catch { /* no haptics */ } }
          else { stopDrawing(false); if (!d.before.length) { st.setWay([d.draw[0]]); } }
        } else if (d.moved) stopDrawing(false);
        else if (!d.before.length) { void audio.unlock(); st.setWay([d.draw[0]]); audio.play('click', 0.4); }
        down = null;
        if (d.touch) setChip(null);
        return;
      }
      down = null;
      if (d.way >= 0 && d.moved) { const hit = world.pick(e.clientX, e.clientY); const st = ui(); if (hit) { const way = st.way.slice(); const snap = d.way === 0 ? findSnap(game, hit.x, hit.z) : null; way[d.way] = snap ? { x: snap.x, z: snap.z } : hit; st.setWay(way); } return; }
      if (d.paint) { ui().bump(); return; }
      if (!d.moved && d.button === 0 && e.type !== 'pointercancel') {
        if (ui().tool === 'terrain') { void audio.unlock(); paint(e.clientX, e.clientY); return; }
        click(e.clientX, e.clientY, d.touch);
      }
    };
    const onDbl = (e: MouseEvent) => {
      const i = waypointAt(e.clientX, e.clientY, false); const st = ui();
      if (i > 0 && i < st.way.length - 1) { const way = st.way.slice(); way.splice(i, 1); st.keepWay(); st.setWay(way); }
    };
    const onWheel = (e: WheelEvent) => { e.preventDefault(); world.zoom(Math.exp(e.deltaY * 0.0011)); };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (e.type === 'keydown') {
        keys.add(k);
        const st = ui();
        if (k === 'escape') { if (st.way.length) { st.setWay([]); st.set({ drawing: false }); down = null; } else st.setTool('inspect'); st.set({ selection: null, panelOpen: false, menu: false, help: false }); }
        if (k === ' ') { e.preventDefault(); st.set({ speed: st.speed === 0 ? 1 : 0 }); }
        if (k === '1' || k === '2' || k === '3') st.set({ speed: Number(k) });
      } else keys.delete(k);
    };
    const onResize = () => world.resize();
    const onHide = () => { if (document.visibilityState === 'hidden') void ui().save(); };
    const noMenu = (e: Event) => e.preventDefault();

    canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', () => { hover = null; setChip(null); });
    canvas.addEventListener('dblclick', onDbl); canvas.addEventListener('wheel', onWheel, { passive: false }); canvas.addEventListener('contextmenu', noMenu);
    window.addEventListener('keydown', onKey); window.addEventListener('keyup', onKey); window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onHide);
    const ro = new ResizeObserver(onResize); ro.observe(canvas);

    // test and automation hook: real state, real commands, real screen coordinates
    (window as unknown as Record<string, unknown>).__ml = {
      get state() { return game; }, world, ui: useUI,
      screenOf: (x: number, z: number) => { const r = canvas.getBoundingClientRect(); const p = world.project(x, z); return { x: p.x + r.left, y: p.y + r.top, visible: p.visible }; },
      /** nearest buildable site for a mine or mill around a point, or null */
      findSite: (kind: 'mine' | 'mill', x: number, z: number, reach = 6) => {
        let best: { x: number; z: number } | null = null, bd = Infinity;
        for (let dz = -reach; dz <= reach; dz++) for (let dx = -reach; dx <= reach; dx++) {
          const px = Math.round(x) + dx, pz = Math.round(z) + dz;
          const err = kind === 'mine' ? mineSite(game, px, pz).error : millSite(game, px, pz).error;
          if (!err && Math.hypot(dx, dz) < bd) { bd = Math.hypot(dx, dz); best = { x: px, z: pz }; }
        }
        return best;
      },
      /** Play real commands through the simulation to reach a named point in the first loop (captures and tests). */
      demo: (stage: 'line' | 'railhead' | 'mine' | 'nearSale' | 'bust') => {
        const st = ui(); const run = (c: Parameters<typeof st.run>[0]) => st.run(c, true);
        const days = (n: number) => { for (let i = 0; i < n * TIME.ticksPerDay; i++) tick(game); };
        const hook = (window as unknown as { __ml: { findSite: (k: 'mine' | 'mill', x: number, z: number) => { x: number; z: number } | null } }).__ml;
        if (stage === 'bust') { run({ type: 'borrow', amount: 1e9 }); run({ type: 'borrow', amount: Math.floor((game.finance.assetValue * 0.45 + 60000) - game.finance.debt) }); for (let i = 0; i < 9000 && !game.finance.receivership; i++) days(1); game.events.length = 0; return; }
        const gold = game.deposits[0];
        if (!game.edges.length && !game.jobs.length) { run({ type: 'borrow', amount: 45000 }); run({ type: 'buildLine', way: suggestRoute(game, game.nodes[0], { x: gold.x - 3, z: gold.z + 4 })! }); }
        if (stage === 'line') return;
        if (stage === 'railhead') { days(9); st.set({ speed: 2 }); world.cam.dist = 20; world.cam.pitch = 0.6; world.focus(game.jobs[0]?.pts[Math.max(0, game.jobs[0].applied)].x ?? gold.x, game.jobs[0]?.pts[Math.max(0, game.jobs[0].applied)].z ?? gold.z, 20); game.events.length = 0; return; }
        while (game.jobs.length) days(1);
        if (!game.mines.length) { const s0 = hook.findSite('mine', gold.x, gold.z); if (s0) run({ type: 'mine', x: s0.x, z: s0.z }); const e = game.edges[0], p = e.pts[e.pts.length - 4]; run({ type: 'platform', x: p.x, z: p.z }); }
        if (stage === 'nearSale') {
          for (let i = 0; i < 4000; i++) { const t = game.trains[0]; if (t.phase === 'inbound' && t.trip && t.trip.dist > t.trip.length - 7) break; tick(game); }
          const n = game.nodes[0]; world.cam.x = n.x + (window.innerWidth > 820 ? -5 : 1.5); world.cam.z = n.z + 1; world.cam.dist = 30; world.cam.pitch = 0.62; st.set({ speed: 1 });
        }
        game.events.length = 0;
      },
      advanceDays: (days: number) => { for (let i = 0; i < days * TIME.ticksPerDay; i++) tick(game); game.events.length = 0; },
    };

    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onHide);
      world.dispose(); theWorld = null;
    };
  }, []);

  return (
    <div className="stage">
      <canvas ref={canvasRef} className="world" aria-label="The valley: terrain, railroad and works" />
      <div ref={labelsRef} className="maplabels" aria-hidden="true" />
      <div ref={handlesRef} className="handles" aria-hidden="true" />
      <div ref={chipRef} className="chip" aria-hidden="true" />
    </div>
  );
}
