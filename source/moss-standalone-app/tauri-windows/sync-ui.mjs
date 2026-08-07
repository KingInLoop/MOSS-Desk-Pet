import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(root, '..', 'src');
const destination = path.join(root, 'frontend', 'src');

await mkdir(destination, { recursive: true });
for (const filename of ['styles.css', 'animation-config.js', 'renderer.js']) {
  await cp(path.join(source, filename), path.join(destination, filename));
}

const electronHtml = await readFile(path.join(source, 'index.html'), 'utf8');
const tauriHtml = electronHtml
  .replace('<script src="animation-config.js"></script>', '<script src="tauri-bridge.js"></script>\n    <script src="animation-config.js"></script>');
await writeFile(path.join(destination, 'index.html'), tauriHtml);
await cp(path.join(root, 'tauri-bridge.js'), path.join(destination, 'tauri-bridge.js'));
await cp(path.join(root, '..', 'assets', 'pets'), path.join(root, 'frontend', 'assets', 'pets'), { recursive: true, force: true });
