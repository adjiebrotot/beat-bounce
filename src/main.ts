import './style.css';
import { App } from './ui/app.ts';

const root = document.getElementById('app');
if (root) {
  new App(root).start().catch((e: unknown) => {
    root.textContent = `Beat Bounce could not start: ${e instanceof Error ? e.message : String(e)}. WebGL 2 is needed.`;
    console.error(e);
  });
}
