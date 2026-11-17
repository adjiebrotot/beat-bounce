import './style.css';
import { App } from './ui/app.ts';

const root = document.getElementById('app');
if (root) {
  const app = new App(root);
  // the dev server exposes the app for the smoke test (tools/smoke.mjs)
  if (import.meta.env.DEV) (window as unknown as { __bb: App }).__bb = app;
  app.start().catch((e: unknown) => {
    root.textContent = `Beat Bounce could not start: ${e instanceof Error ? e.message : String(e)}. WebGL 2 is needed.`;
    console.error(e);
  });
}
