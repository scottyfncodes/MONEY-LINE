// Global error handling in the real game: uncaught errors and rejections are logged, the player is told once,
// the simulation pauses, and the game keeps rendering.   npm run build && npm run preview &  then  node e2e/errors.e2e.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const URL = process.env.ML_URL ?? 'http://localhost:4173/';
const ok = (c, what) => { if (!c) throw new Error(`FAILED: ${what}`); console.log(`  ✓ ${what}`); };

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 664 }]) {
  console.log(`viewport ${viewport.width}x${viewport.height}`);
  const page = await browser.newPage({ viewport });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  await page.goto(URL);
  await page.getByRole('button', { name: 'New Venture' }).click();
  await page.waitForFunction(() => !!window.__ml?.state);
  await page.getByRole('button', { name: 'Run', exact: false }).first().click().catch(() => {});
  await page.evaluate(() => window.__ml.ui.getState().set({ speed: 1 }));
  ok(logs.length === 0, 'a healthy game logs no errors');

  await page.evaluate(() => { setTimeout(() => { throw new Error('test fault in a callback'); }); });
  const dialog = page.getByRole('alertdialog', { name: 'Something went wrong' });
  await dialog.waitFor({ timeout: 5000 });
  ok(await dialog.isVisible(), 'an uncaught error shows the player a message');
  ok(await page.getByText('Your venture is saved automatically').isVisible(), 'the message says the autosave is intact');
  ok(await page.evaluate(() => window.__ml.ui.getState().speed) === 0, 'the simulation is paused');
  ok(logs.some((l) => l.includes('[MONEY LINE] error: test fault in a callback')), 'the error is logged with context');

  const box = await page.getByRole('button', { name: 'Keep playing' }).boundingBox();
  ok(box && box.height >= 44, 'the dialog buttons are at least 44 px tall');
  await page.getByRole('button', { name: 'Keep playing' }).click();
  ok(!(await dialog.isVisible()), 'Keep playing closes the message');

  await page.evaluate(() => { for (let i = 0; i < 5; i++) setTimeout(() => { throw new Error('test fault in a callback'); }); });
  await page.waitForTimeout(400);
  ok(!(await dialog.isVisible()), 'the same fault repeating does not reopen the message');
  ok(await page.evaluate(() => window.__mlErrors.find((r) => r.message === 'test fault in a callback').count) === 6, 'repeats are counted');

  await page.evaluate(() => { Promise.reject(new Error('test rejection')); });
  await dialog.waitFor({ timeout: 5000 });
  ok(logs.some((l) => l.includes('[MONEY LINE] rejection: test rejection')), 'an unhandled rejection is logged and shown');
  await page.getByRole('button', { name: 'Keep playing' }).click();

  const before = await page.evaluate(() => window.__ml.state.tick);
  await page.evaluate(() => window.__ml.ui.getState().set({ speed: 1 }));
  await page.waitForTimeout(1500);
  ok(await page.evaluate(() => window.__ml.state.tick) > before, 'the game keeps running after the player resumes');
  await page.close();
}
await browser.close();
console.log('\nErrors are caught, logged and shown; the game does not fail silently.');
