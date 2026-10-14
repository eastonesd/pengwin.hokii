import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { before, after } from 'node:test';

const project = fileURLToPath(new URL('..', import.meta.url));
const dist = path.join(project, 'dist');
const port = 20000 + Math.floor(Math.random() * 25000);
const origin = 'http://127.0.0.1:' + port;
let child;
let diagnostics = '';
let handler;
const useRealHttp = process.env.HOKII_HTTP_TEST === '1';
const savedEnv = { PORT: process.env.PORT, OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_MODEL: process.env.OPENAI_MODEL };

before(async () => {
  if (!useRealHttp) {
    // Exercise the unchanged server request handler with Node readable streams.
    // This mode requires no socket/network permission. HOKII_HTTP_TEST=1 additionally
    // runs the same suite through a real HTTP listener on the user's computer.
    process.env.PORT = String(port);
    process.env.OPENAI_API_KEY = '';
    process.env.OPENAI_MODEL = 'gpt-5-mini';
    const serverSource = readFileSync(path.join(project, 'server.mjs'), 'utf8');
    assert.ok(serverSource.includes("import http from 'node:http';"));
    assert.ok(serverSource.includes('path.dirname(fileURLToPath(import.meta.url))'));
    globalThis.__HOKII_HTTP_STUB__ = {
      createServer(callback) {
        handler = callback;
        return { listen() {}, on() {} };
      }
    };
    const isolatedSource = serverSource
      .replace("import http from 'node:http';", 'const http = globalThis.__HOKII_HTTP_STUB__;')
      .replace("from './lib/openai.mjs';", `from '${pathToFileURL(path.join(project, 'lib/openai.mjs')).href}';`)
      .replace('path.dirname(fileURLToPath(import.meta.url))', JSON.stringify(project));
    try { await import('data:text/javascript;base64,' + Buffer.from(isolatedSource).toString('base64')); }
    finally { delete globalThis.__HOKII_HTTP_STUB__; }
    assert.equal(typeof handler, 'function');
    return;
  }
  const env = { ...process.env, PORT: String(port), OPENAI_API_KEY: '', OPENAI_MODEL: 'gpt-5-mini' };
  child = spawn(process.execPath, ['server.mjs'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('本機HTTP伺服器未在8秒內啟動。' + diagnostics)); }, 8000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('伺服器提前退出：' + code + ' ' + diagnostics)); });
    child.stdout.on('data', chunk => {
      diagnostics += chunk.toString();
      if (diagnostics.includes(origin)) { clearTimeout(timer); resolve(); }
    });
  });
});
after(async () => {
  if (!useRealHttp) {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await Promise.race([exited, new Promise(resolve => { const timer = setTimeout(resolve, 2000); timer.unref(); })]);
  }
});

function request(route, options = {}) {
  if (useRealHttp) return fetch(origin + route, { ...options, signal: AbortSignal.timeout(7000) });
  return new Promise((resolve, reject) => {
    const req = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]);
    req.url = route;
    req.method = options.method || 'GET';
    req.headers = { host: '127.0.0.1:' + port };
    for (const [name, value] of Object.entries(options.headers || {})) req.headers[name.toLowerCase()] = value;
    const timer = setTimeout(() => reject(new Error('HTTP handler timeout: ' + route)), 7000);
    const res = {
      headersSent: false,
      status: 200,
      headers: {},
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
      end(body) {
        clearTimeout(timer);
        resolve(new Response(body === undefined ? null : body, { status: this.status, headers: this.headers }));
      }
    };
    Promise.resolve(handler(req, res)).catch(error => { clearTimeout(timer); reject(error); });
  });
}
function post(body, extra = {}) {
  return request('/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(extra.headers || {}) }, body: typeof body === 'string' ? body : JSON.stringify(body), ...extra });
}
function localFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix + entry.name;
    return entry.isDirectory() ? localFiles(path.join(directory, entry.name), relative + '/') : [relative];
  });
}

test('status reports unconfigured local mode without exposing a key', async () => {
  const response = await request('/api/status');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.configured, false);
  assert.equal(body.mode, 'local');
  assert.equal(body.model, 'gpt-5-mini');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(!Object.keys(body).some(key => /secret|api.?key/i.test(key)));
});
test('all existing public static files return unchanged bytes', async () => {
  const files = localFiles(dist);
  assert.ok(files.includes('index.html'));
  assert.ok(files.includes('engine.js'));
  assert.ok(files.includes('styles.css'));
  for (const name of files) {
    const response = await request('/' + name.split('/').map(encodeURIComponent).join('/'));
    assert.equal(response.status, 200, name);
    const actual = Buffer.from(await response.arrayBuffer());
    assert.ok(actual.equals(readFileSync(path.join(dist, name))), name + ' bytes');
  }
});
test('frontend relative scripts and stylesheet references exist', async () => {
  const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
  const references = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)].map(match => match[1]).filter(name => !/^(https?:|data:)/i.test(name));
  assert.ok(references.length >= 2);
  for (const name of references) {
    const response = await request('/' + name.replace(/^\//, ''));
    assert.equal(response.status, 200, 'Missing referenced asset: ' + name);
  }
});
test('HEAD returns headers without a document body', async () => {
  const response = await request('/engine.js', { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.equal(await response.text(), '');
});
test('valid extraction request without API key reports 503 without network use', async () => {
  const response = await post({ text: '合成請款單 金額120000 帳號01212345678901' });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /尚未啟用/);
});
test('invalid JSON and unsupported request media fail before extraction', async () => {
  const invalid = await post('{invalid-json');
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /格式/);
  const unsupported = await request('/api/extract', { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: origin }, body: '請款' });
  assert.equal(unsupported.status, 415);
});
test('cross-origin POST and unknown Host are blocked', async () => {
  const crossed = await request('/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ text: '請款' }) });
  assert.equal(crossed.status, 403);
  const badHost = await request('/api/status', { headers: { Host: 'evil.example' } });
  assert.equal(badHost.status, 403);
});
test('API unknown routes and forbidden methods return specific HTTP status', async () => {
  assert.equal((await request('/api/no-such-api')).status, 404);
  assert.equal((await request('/index.html', { method: 'POST' })).status, 405);
  assert.equal((await request('/no-such-file.txt')).status, 404);
});
test('static traversal and malformed URL do not expose backend source', async () => {
  const traversal = await request('/%2e%2e%2fserver.mjs');
  assert.equal(traversal.status, 403);
  const malformed = await request('/%ZZ');
  assert.equal(malformed.status, 400);
  const backslash = await request('/%5cserver.mjs');
  assert.equal(backslash.status, 400);
});
test('invalid empty or wrong-type request body reports a validation error', async () => {
  for (const body of [{}, [], null, { file: { name: 'a.png', type: 'image/png', data: 'data:image/png;base64,AAAA' } }]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
});
test('request body limit returns 413 instead of accepting oversized input', async () => {
  const oversized = JSON.stringify({ text: 'x'.repeat(12 * 1024 * 1024 + 1) });
  const response = await post(oversized);
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /太大|8MB/);
});
test('two in-flight extractions prevent a third after body reading', { skip: useRealHttp }, async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const gates = [];
  let started = 0;
  const extracted = {
    supplierId: null, supplierName: '合成供應商', taxId: null, account: '01200000000000',
    amount: 120000, currency: 'TWD', dueDate: null, invoiceNo: null,
    emailUrgency: false, emailChangeRequest: false, evidence: []
  };
  process.env.OPENAI_API_KEY = 'fake-handler-test-key';
  globalThis.fetch = async url => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    started++;
    await new Promise(resolve => gates.push(resolve));
    return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(extracted) }] }] }), { status: 200 });
  };
  let first;
  let second;
  try {
    first = post({ text: '合成文件一' });
    second = post({ text: '合成文件二' });
    const third = post({ text: '合成文件三' });
    const response = await third;
    assert.equal(response.status, 429);
    assert.equal(started, 2);
    gates.forEach(resolve => resolve());
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
  } finally {
    gates.forEach(resolve => resolve());
    if (first) await first;
    if (second) await second;
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalKey;
  }
});
