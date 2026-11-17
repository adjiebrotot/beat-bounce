#!/usr/bin/env node
// Smoke test of the editor in headless Chromium. It starts the Vite dev server, loads the demo,
// waits for the layout and the sound, adds and drags wall text, reloads to check the autosave,
// takes screenshots (desktop and phone width), and stops the server and the browser at the end.
//
//   pnpm smoke                 screenshots in out/smoke/
//   pnpm smoke --render        also renders a 10 s draft MP4 (slow without a GPU)
//
// Playwright comes from the project or from a global install; Chromium uses SwiftShader (software
// WebGL) unless --gpu is given.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out', 'smoke');
const PORT = 5199;
const args = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try { return require('playwright'); } catch { return require(path.join(execSync('npm root -g').toString().trim(), 'playwright')); }
}

const server = spawn(path.join(ROOT, 'node_modules', '.bin', 'vite'), ['--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
let browser;
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail.push(what); };
try {
  await new Promise((r) => setTimeout(r, 2500));
  const { chromium } = loadPlaywright();
  browser = await chromium.launch({ args: args.includes('--gpu') ? ['--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  const bb = (fn, arg) => page.evaluate(fn, arg);
  const settled = async () => {
    for (let i = 0; i < 120; i++) {
      await page.waitForTimeout(1000);
      const busy = await bb(() => !window.__bb?.engine?.plan || window.__bb.engine.planning || window.__bb.engine.synthing || /Looking/.test(document.querySelector('.vp-status')?.textContent ?? ''));
      if (!busy) return;
    }
  };
  await settled();
  await page.waitForTimeout(3000);
  await settled();
  const stats = await bb(() => ({ ...window.__bb.engine.plan.stats, ornaments: window.__bb.store.project.ornaments.length, audio: !!window.__bb.engine.audio }));
  console.log('demo:', JSON.stringify(stats));
  check(stats.hits > 100, 'the demo plans its bounces');
  check(stats.forced === 0, 'the demo layout has no collisions');
  check(stats.ornaments === 5, 'the demo hangs five pieces of art');
  check(stats.audio, 'the sound is ready');
  await bb((t) => window.__bb.player.seek(t), 16);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, 'desktop.png') });

  await page.getByRole('tab', { name: /Wall art/ }).click();
  await page.getByRole('button', { name: 'T  Text' }).click();
  await page.waitForTimeout(1000);
  const sel = await page.locator('svg.handles polygon.selection').boundingBox();
  check(!!sel, 'a new text shows the selection handles');
  const before = await bb(() => { const p = window.__bb.store.project; return p.ornaments[p.ornaments.length - 1]; });
  if (sel) {
    const cx = sel.x + sel.width / 2, cy = sel.y + sel.height / 2;
    await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx - 100, cy + 50, { steps: 8 }); await page.mouse.up();
  }
  await page.waitForTimeout(800);
  const after = await bb((id) => window.__bb.store.project.ornaments.find((o) => o.id === id), before.id);
  check(after && (after.x !== before.x || after.y !== before.y), 'dragging moves the text on the wall');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  const undone = await bb((id) => window.__bb.store.project.ornaments.find((o) => o.id === id), before.id);
  check(undone && undone.x === before.x, 'undo puts the text back');
  await page.locator('.inspector textarea').fill('Saved text');
  await page.waitForTimeout(1500);

  await page.reload();
  await settled();
  const kept = await bb(() => window.__bb.store.project.ornaments.some((o) => o.kind === 'text' && o.text === 'Saved text'));
  check(kept, 'the project survives a reload');

  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(`http://127.0.0.1:${PORT}/`);
  await phone.waitForTimeout(8000);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 1, 'no sideways scroll at phone width');
  await phone.screenshot({ path: path.join(OUT, 'phone.png'), fullPage: false });
  await phone.close();

  if (args.includes('--render')) {
    await page.getByRole('button', { name: 'Render MP4' }).click();
    await page.locator('dialog select').selectOption('720');
    await page.getByRole('radio', { name: '30 fps' }).click();
    await page.getByRole('radio', { name: 'Draft' }).click();
    await page.getByRole('radio', { name: 'First 10 s (test)' }).click();
    const dl = page.waitForEvent('download', { timeout: 1_800_000 });
    await page.locator('dialog').getByRole('button', { name: 'Render', exact: true }).click();
    const d = await dl;
    const file = path.join(OUT, d.suggestedFilename());
    await d.saveAs(file);
    check(fs.statSync(file).size > 100_000, `the render downloads ${path.basename(file)}`);
  }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
} finally {
  await browser?.close();
  server.kill();
}
console.log(fail.length ? `\n${fail.length} check(s) failed` : `\nall checks passed; screenshots in ${path.relative(ROOT, OUT)}/`);
process.exit(fail.length ? 1 : 0);
