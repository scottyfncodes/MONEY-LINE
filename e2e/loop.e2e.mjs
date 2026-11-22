// End-to-end: the first complete mining-to-market loop, driven through the real interface in a real browser.
// Run against a built preview:  npm run build && npm run preview &  then  npm run test:e2e
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const URL = process.env.ML_URL ?? 'http://localhost:4173/';
const OUT = new URL_('./out/', import.meta.url).pathname;
function URL_(a, b) { return new globalThis.URL(a, b); }
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

let step = 0;
const ok = (cond, what) => { if (!cond) throw new Error(`FAILED: ${what}`); console.log(`  ✓ ${what}`); };
const shot = async (name) => page.screenshot({ path: `${OUT}${String(++step).padStart(2, '0')}-${name}.png` });
const S = (fn, arg) => page.evaluate(fn, arg);
const state = () => S(() => { const s = window.__ml.state; return { day: s.day, cash: s.finance.cash, debt: s.finance.debt, edges: s.edges.length, jobs: s.jobs.length, mines: s.mines.length, mills: s.mills.length, stations: s.stations.length, objective: s.objective, stats: s.stats, revenue: s.finance.totals.revenue, upgrades: Object.keys(s.upgrades).length, wagons: s.wagonsOwned, terrainRev: s.rev.terrain }; });
const tool = async (name) => { const b = page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name, exact: true }); if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click(); };
/** Point the camera so a ground point sits in the clear middle of the screen, then click it. */
const clickGround = async (x, z, dist = 60) => {
  await S(([x, z, dist]) => { const w = window.__ml.world; w.cam.x = x + dist * 0.12; w.cam.z = z; w.cam.dist = dist; w.cam.yaw = 0.3; w.cam.pitch = 0.9; w.cam.follow = null; }, [x, z, dist]);
  await page.waitForTimeout(350);
  const p = await S(([x, z]) => window.__ml.screenOf(x, z), [x, z]);
  await page.mouse.move(p.x, p.y); await page.waitForTimeout(80);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(250);
};
const days = (n) => S((n) => window.__ml.advanceDays(n), n);

console.log('1. Begin in the city');
await page.goto(URL);
await page.getByRole('button', { name: 'New Venture' }).click();
await page.waitForFunction(() => !!window.__ml?.state);
await page.waitForTimeout(1200);
let s = await state();
ok(s.cash === 18000 && s.debt === 0 && s.edges === 0, 'a new venture starts with $18,000, no debt and no track');
await shot('start');

console.log('2. Inspect the terrain and the claim');
const gold = await S(() => { const d = window.__ml.state.deposits[0]; return { x: d.x, z: d.z }; });
await tool('Inspect');
await clickGround(gold.x, gold.z);
ok(await page.getByText('Eureka Lode').first().isVisible(), 'the claim opens in the inspector');
ok(await page.getByText('Ore in the ground').isVisible(), 'with a reserve estimate');
await shot('claim');

console.log('3. Borrow money');
await tool('Finance');
for (let i = 0; i < 7; i++) await page.getByRole('button', { name: 'More', exact: true }).click();
await page.getByRole('button', { name: /^Borrow \$45,000/ }).click();
s = await state();
ok(s.debt === 45000 && s.cash === 63000, 'borrowing $45,000 raises cash and debt together');

console.log('4. Build a railroad to the deposit');
await tool('Railroad');
await page.waitForTimeout(3000); // the view glides to show the terminal and the claim together
ok(await page.getByText('Drag from here').isVisible(), 'the terminal is marked as the place to draw from');
// draw the line by hand: press on the terminal and drag across the valley to the claim
const stroke = await S(([gx, gz]) => { const n = window.__ml.state.nodes[0]; return [[n.x, n.z], [45, 91], [64, 83], [gx - 3, gz + 4]].map(([x, z]) => window.__ml.screenOf(x, z)); }, [gold.x, gold.z]);
await page.mouse.move(stroke[0].x, stroke[0].y); await page.mouse.down();
for (const p of stroke.slice(1)) await page.mouse.move(p.x, p.y, { steps: 12 });
ok(await S(() => window.__ml.ui.getState().drawing), 'the line follows the pointer while it is held');
await page.mouse.up(); await page.waitForTimeout(300);
await page.getByText("The engineer's estimate").waitFor();
ok(await page.getByText('Buildable', { exact: true }).isVisible(), 'the drawn line is a buildable route with an itemised estimate');
await S(() => { const w = window.__ml.world; w.cam.x = 60; w.cam.z = 80; w.cam.dist = 120; });
await page.waitForTimeout(500);
await shot('route-estimate');
const before = (await state()).cash;
await page.getByRole('button', { name: /^Sign the contract/ }).click();
s = await state();
ok(s.jobs === 1 && s.cash < before, `the contract costs $${Math.round(before - s.cash).toLocaleString()} and the crews start`);
await page.waitForFunction(() => window.__ml.state.objective >= 1, null, { timeout: 5000 });
ok(true, 'objective "Sign for a line to the Eureka claim" is met');
await days(8); await page.waitForTimeout(700);
await shot('railhead');
ok((await state()).edges === 0, 'the line is not open until the crews finish it');
await days(30); await page.waitForTimeout(500);
s = await state();
ok(s.edges >= 1 && s.jobs === 0 && s.stats.reachedClaim, 'the railhead reaches the claim');

console.log('5. Modify the landscape');
await tool('Terrain');
await page.getByRole('radio', { name: 'Grade' }).click();
const c0 = (await state()).cash;
await clickGround(gold.x + 3, gold.z - 4, 30);
s = await state();
ok(s.stats.terrainEdits >= 1 && s.cash < c0, `grading moved earth and cost $${Math.round(c0 - s.cash)}`);

console.log('6. Establish a mine');
await tool('Build');
let site = await S(([x, z]) => window.__ml.findSite('mine', x, z), [gold.x, gold.z]);
ok(!!site, 'there is level ground on the claim within reach of the track');
await page.getByRole('button', { name: /^Mine/ }).click();
await clickGround(site.x, site.z, 30);
ok((await state()).mines === 1, 'the mine is built');
await page.getByRole('button', { name: /^Loading platform/ }).click();
const end = await S(() => { const e = window.__ml.state.edges[0]; const p = e.pts[e.pts.length - 4]; return { x: p.x, z: p.z }; });
await clickGround(end.x, end.z, 30);
s = await state();
ok(s.stations === 2, 'the loading platform is built on the line');

console.log('7–11. Extract, load, haul, sell');
await page.getByRole('button', { name: /Faster/ }).click();
await page.waitForTimeout(4000);
ok((await state()).day > s.day, 'time runs on its own at speed');
await days(12); await page.waitForTimeout(600);
await shot('first-ore');
s = await state();
ok(s.stats.firstSale && s.revenue > 0, `the first shipment is sold in the city for $${Math.round(s.revenue).toLocaleString()}`);

console.log('8. Process the ore');
const mine = await S(() => { const m = window.__ml.state.mines[0]; return { x: m.x, z: m.z }; });
site = await S(([x, z]) => window.__ml.findSite('mill', x, z), [mine.x, mine.z]);
if (!site) { // no level pad: make one, as a player would
  await tool('Terrain'); await page.getByRole('radio', { name: 'Grade' }).click();
  for (let i = 0; i < 14 && !site; i++) { await clickGround(mine.x + 4, mine.z + 3, 30); site = await S(([x, z]) => window.__ml.findSite('mill', x, z), [mine.x, mine.z]); }
}
ok(!!site, 'a level pad for the mill exists beside the mine');
if ((await state()).cash < 13500) { await tool('Finance'); await page.getByRole('button', { name: /^Borrow/ }).click(); }
await tool('Build');
await page.getByRole('button', { name: /^Stamp mill/ }).click();
await clickGround(site.x, site.z, 30);
ok((await state()).mills === 1, 'the stamp mill is built');
await days(25); await page.waitForTimeout(500);
s = await state();
if (!s.stats.firstConcSale) console.log(await S(() => { const s = window.__ml.state; return JSON.stringify({ t: s.trains.map((t) => [t.phase, t.status, t.cargo, t.dwell]), mine: s.mines.map((m) => [m.stock, m.status]), mill: s.mills.map((m) => [m.stock, m.status, m.x, m.z]), st: s.stations.map((x) => [x.x, x.z]), cash: s.finance.cash, day: s.day }); }));
ok(s.stats.firstConcSale, 'concentrate from the mill has been hauled to the city and sold');
await S(() => { const w = window.__ml.world; const m = window.__ml.state.mines[0]; w.cam.x = m.x; w.cam.z = m.z; w.cam.dist = 26; w.cam.pitch = 0.62; });
await page.waitForTimeout(900);
await shot('mine-and-mill');

console.log('12. Use the proceeds to improve the operation');
await days(40);
if ((await state()).cash < 1400) await days(30);
await tool('Trains');
const w0 = (await state()).wagons;
await page.getByRole('button', { name: /^Buy 2 hoppers/ }).click();
s = await state();
ok(s.wagons === w0 + 2 && s.stats.upgrades >= 1, 'two more hoppers bought out of earnings');
await shot('trains');

console.log('Save and reload');
await page.getByRole('button', { name: 'Pause' }).click();
await page.getByRole('button', { name: 'MONEY LINE menu' }).click();
await page.getByRole('button', { name: 'Save now' }).click();
await page.waitForTimeout(600);
const saved = await S(() => { const s = window.__ml.state; return { day: s.day, edges: s.edges.length, mines: s.mines.length, mills: s.mills.length, debt: s.finance.debt, h: Array.from(s.height.slice(5000, 5200)).join(',') }; });
await page.reload();
await page.getByRole('button', { name: /^Continue/ }).click();
await page.waitForFunction(() => !!window.__ml?.state);
const loaded = await S(() => { const s = window.__ml.state; return { day: s.day, edges: s.edges.length, mines: s.mines.length, mills: s.mills.length, debt: s.finance.debt, h: Array.from(s.height.slice(5000, 5200)).join(',') }; });
ok(loaded.day === saved.day && loaded.debt === saved.debt && loaded.edges === saved.edges && loaded.mines === saved.mines && loaded.mills === saved.mills && loaded.h === saved.h, 'the saved venture comes back with its track, works and terrain');
await page.waitForTimeout(1200);
await shot('reloaded');

ok(errors.length === 0, `no console or page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
console.log('\nThe whole mining-to-market loop works through the interface.');
