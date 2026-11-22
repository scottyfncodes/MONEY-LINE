import { useEffect, useRef } from 'react';
import { audio } from '../audio/audio';
import { World } from '../render/world';
import { suggestRoute } from '../sim/autoroute';
import { MILL, MINE, STATION, SURVEY, TIME, fmtMoney } from '../sim/config';
import { millSite, mineSite } from '../sim/facilities';
import { findSnap } from '../sim/rail';
import { tick } from '../sim/sim';
import { heightAt, planTerrainOp } from '../sim/terrain';
import type { GameState } from '../sim/types';
import { useUI, type Selection } from '../store';

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

export function GameView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ui = useUI.getState;
    const world = new World(canvas, ui().game!);
    theWorld = world;
    let game = ui().game!;
    let raf = 0, last = performance.now(), acc = 0, lastBump = 0, lastSave = performance.now(), labelKey = '';
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

    const drainEvents = () => {
      for (const e of game.events) {
        if (e.type === 'blast') { world.burst('blast', e.x, e.z); audio.play('explosion', 0.55, 0.9 + Math.random() * 0.2); }
        else if (e.type === 'dig') { world.burst('dig', e.x, e.z); audio.play('hit', 0.3, 0.8 + Math.random() * 0.4); }
        else if (e.type === 'sale') { world.burst('sale', e.x, e.z); audio.play('coin', 0.6); ui().toast('good', `Shipment sold: ${fmtMoney(e.amount)}`); }
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
      if (st.game && st.game !== game) { game = st.game; world.setState(game); labelKey = ''; lastNote = game.notes.length ? game.notes[game.notes.length - 1].id : 0; }
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
      if (now - lastBump > 240) { lastBump = now; st.bump(); }
      if (now - lastSave > 20000) { lastSave = now; void st.save(); }
    };
    raf = requestAnimationFrame(frame);

    // ── pointer input ──
    const ptrs = new Map<number, { x: number; y: number }>();
    let down: { x: number; y: number; button: number; moved: boolean; way: number; paint: boolean; lastPaint: number } | null = null;
    let pinch = 0, pinchAngle = 0;

    const setChip = (text: string | null, tone: 'ok' | 'bad' | 'info' = 'info') => {
      const el = chipRef.current!; if (!text) { el.style.opacity = '0'; return; }
      el.textContent = text; el.dataset.tone = tone; el.style.opacity = '1';
    };
    const moveChip = (x: number, y: number) => { const r = canvas.getBoundingClientRect(); chipRef.current!.style.transform = `translate(${x - r.left + 18}px, ${y - r.top + 18}px)`; };

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
        if (st.way.length === 0) { const snap = findSnap(game, hover.x, hover.z); setChip(snap ? 'Start the line here' : 'Start on existing track or the terminal', snap ? 'ok' : 'bad'); }
        else if (st.way.length === 1) setChip('Click the destination', 'info');
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

    const click = (x: number, y: number) => {
      const st = ui(); const hit = world.pick(x, y); if (!hit) return;
      void audio.unlock();
      if (st.tool === 'survey') { st.run({ type: 'prospect', x: hit.x, z: hit.z }); return; }
      if (st.tool === 'build') {
        const r = st.run({ type: st.buildKind, x: hit.x, z: hit.z });
        if (r.ok) { const v = r.value as { id: number }; st.set({ selection: { kind: st.buildKind === 'platform' ? 'station' : st.buildKind, id: v.id } }); }
        return;
      }
      if (st.tool === 'rail') {
        if (st.lifting) { const e = pickEntity(game, world, hit); if (e.kind === 'edge') { st.run({ type: 'demolish', edge: e.id }); } else st.toast('info', 'Click directly on a finished line to lift it.'); return; }
        if (st.way.length === 0) {
          const snap = findSnap(game, hit.x, hit.z);
          if (!snap) return st.toast('bad', 'Start the line on existing track or at the city terminal.');
          st.setWay([{ x: snap.x, z: snap.z }]); audio.play('click', 0.4); return;
        }
        if (st.way.length === 1) {
          const end = findSnap(game, hit.x, hit.z);
          const to = end ? { x: end.x, z: end.z } : hit;
          const way = suggestRoute(game, st.way[0], to) ?? [st.way[0], to];
          st.setWay(way); audio.play('click', 0.4); return;
        }
        // add a waypoint where it bends the existing line least
        let bi = 1, bd = Infinity;
        for (let i = 1; i < st.way.length; i++) {
          const a = st.way[i - 1], b = st.way[i];
          const extra = Math.hypot(hit.x - a.x, hit.z - a.z) + Math.hypot(b.x - hit.x, b.z - hit.z) - Math.hypot(b.x - a.x, b.z - a.z);
          if (extra < bd) { bd = extra; bi = i; }
        }
        const way = st.way.slice(); way.splice(bi, 0, hit); st.setWay(way); audio.play('click', 0.4);
        return;
      }
      if (st.tool === 'terrain') return;
      const sel = pickEntity(game, world, hit);
      st.set({ selection: sel, panelOpen: true });
      audio.play('click', 0.3);
    };

    const waypointAt = (x: number, y: number): number => {
      const st = ui(); if (st.tool !== 'rail' || st.way.length < 2) return -1;
      const r = canvas.getBoundingClientRect();
      for (let i = 0; i < st.way.length; i++) { const p = world.project(st.way[i].x, st.way[i].z, 0.3); if (Math.hypot(p.x - (x - r.left), p.y - (y - r.top)) < 16) return i; }
      return -1;
    };

    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); pinchAngle = Math.atan2(b.y - a.y, b.x - a.x); down = null; return; }
      const st = ui();
      const way = e.button === 0 ? waypointAt(e.clientX, e.clientY) : -1;
      const paintMode = e.button === 0 && st.tool === 'terrain' && e.pointerType === 'mouse' && !keys.has(' ');
      down = { x: e.clientX, y: e.clientY, button: e.button, moved: false, way, paint: paintMode, lastPaint: 0 };
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
      if (!down.moved && Math.hypot(dx, dy) > 5) down.moved = true;
      if (!down.moved) return;
      if (down.way >= 0) {
        const hit = world.pick(e.clientX, e.clientY); const st = ui();
        if (hit && performance.now() - down.lastPaint > 45) { down.lastPaint = performance.now(); const way = st.way.slice(); way[down.way] = hit; st.setWay(way); }
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
      const d = down; down = null;
      if (d.way >= 0 && d.moved) { const hit = world.pick(e.clientX, e.clientY); const st = ui(); if (hit) { const way = st.way.slice(); const snap = (d.way === 0 || d.way === way.length - 1) ? findSnap(game, hit.x, hit.z) : null; way[d.way] = snap ? { x: snap.x, z: snap.z } : hit; st.setWay(way); } return; }
      if (d.paint) { ui().bump(); return; }
      if (!d.moved && d.button === 0) {
        if (ui().tool === 'terrain') { void audio.unlock(); paint(e.clientX, e.clientY); return; }
        click(e.clientX, e.clientY);
      }
    };
    const onDbl = (e: MouseEvent) => {
      const i = waypointAt(e.clientX, e.clientY); const st = ui();
      if (i > 0 && i < st.way.length - 1) { const way = st.way.slice(); way.splice(i, 1); st.setWay(way); }
    };
    const onWheel = (e: WheelEvent) => { e.preventDefault(); world.zoom(Math.exp(e.deltaY * 0.0011)); };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (e.type === 'keydown') {
        keys.add(k);
        const st = ui();
        if (k === 'escape') { if (st.way.length) st.setWay([]); else st.setTool('inspect'); st.set({ selection: null, panelOpen: false, menu: false, help: false }); }
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
        if (stage === 'railhead') { days(9); world.focus(game.jobs[0]?.pts[Math.max(0, game.jobs[0].applied)].x ?? gold.x, game.jobs[0]?.pts[Math.max(0, game.jobs[0].applied)].z ?? gold.z, 30); game.events.length = 0; return; }
        while (game.jobs.length) days(1);
        if (!game.mines.length) { const s0 = hook.findSite('mine', gold.x, gold.z); if (s0) run({ type: 'mine', x: s0.x, z: s0.z }); const e = game.edges[0], p = e.pts[e.pts.length - 4]; run({ type: 'platform', x: p.x, z: p.z }); }
        if (stage === 'nearSale') {
          for (let i = 0; i < 4000; i++) { const t = game.trains[0]; if (t.phase === 'inbound' && t.trip && t.trip.dist > t.trip.length - 7) break; tick(game); }
          const n = game.nodes[0]; world.cam.x = n.x + 1; world.cam.z = n.z + 1; world.cam.dist = 30; world.cam.pitch = 0.62; st.set({ speed: 1 });
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
      <div ref={chipRef} className="chip" aria-hidden="true" />
    </div>
  );
}
