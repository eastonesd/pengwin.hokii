import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const base = new URL('../dist/', import.meta.url);
const html = readFileSync(new URL('index.html', base), 'utf8');
const app = readFileSync(new URL('app.js', base), 'utf8');
test('瀏覽器腳本必須可以解析，避免整個展示頁空白', () => {
  assert.doesNotThrow(() => new vm.Script(app, {filename:'app.js'}));
  assert.doesNotThrow(() => new vm.Script(readFileSync(new URL('engine.js', base), 'utf8'), {filename:'engine.js'}));
});
test('前端使用的固定DOM id都存在且不重複', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const m of app.matchAll(/\$\(['"]([a-zA-Z][\w-]*)['"]\)/g)) assert.ok(ids.includes(m[1]), 'Missing DOM id: '+m[1]);
});
test('未信任的文件與匯出內容必須安全插入，不能用innerHTML', () => {
  assert.ok(!/\.innerHTML\s*=/.test(app));
  assert.ok(app.includes('textContent'));
  assert.ok(/escapeHtml|escapeHTML|escape/.test(app), 'HTML export must escape content');
});
test('頁面没有API金鑰，且以明確標籤區分合成資料及OpenAI辨識', () => {
  assert.ok(!/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/.test(html+app));
  assert.ok(html.includes('非臺灣企銀正式服務'));
  assert.ok(app.includes("state.document.provider === 'openai'"));
  assert.ok(html.includes('銀行灰名單'));
  assert.ok(html.includes('8 MB'));
});
