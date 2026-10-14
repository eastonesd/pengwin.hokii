import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
let html = await readFile(path.join(root, 'dist/index.html'), 'utf8');
const css = (await readFile(path.join(root, 'dist/styles.css'), 'utf8')).replace(/<\/style/gi, '<\\/style');
html = html.replace('<link rel="stylesheet" href="styles.css">', `<style>${css}</style>`);
for (const name of ['engine.js','app.js']) {
  const code = (await readFile(path.join(root, 'dist', name), 'utf8')).replace(/<\/script/gi, '<\\/script');
  html = html.replace(`<script src="${name}"></script>`, `<script>${code}</script>`);
}
const target = path.join(root, '..', 'Hokii錢掌櫃_離線展示.html');
await writeFile(target, html, 'utf8');
console.log(target);
