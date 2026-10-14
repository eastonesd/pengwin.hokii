import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractInvoice, RequestError } from './lib/openai.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.env.PORT || 8787);
const model = process.env.OPENAI_MODEL || 'gpt-5-mini';
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml' };
let activeExtractions = 0;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let settled = false;
    const chunks = [];
    req.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > 12 * 1024 * 1024) {
        settled = true;
        chunks.length = 0;
        reject(new RequestError('請求太大，單一文件請控制在8MB內。', 413));
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new RequestError('資料格式不正確。')); }
    });
    req.on('error', () => { if (!settled) { settled = true; reject(new RequestError('上傳中斷，請重試。')); } });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const host = (req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return json(res, 403, { error: '此MVP只接受本機存取。' });
    if (url.pathname === '/api/status' && req.method === 'GET') return json(res, 200, { configured: !!process.env.OPENAI_API_KEY, model, mode: 'local' });
    if (url.pathname === '/api/extract' && req.method === 'POST') {
      if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return json(res, 403, { error: '僅限本機工作台提出辨識請求。' });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: '請使用JSON格式。' });
      if (activeExtractions >= 2) return json(res, 429, { error: '已有兩份文件辨識中，請稍後再試。' });
      const body = await readJson(req);
      if (activeExtractions >= 2) return json(res, 429, { error: '已有兩份文件辨識中，請稍後再試。' });
      activeExtractions++;
      try { return json(res, 200, await extractInvoice(body, { model })); } finally { activeExtractions--; }
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: '沒有這個API。' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '不支援此請求方式。' });
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: '路徑不正確。' }); }
    if (pathname.includes('\0') || pathname.includes('\\')) return json(res, 400, { error: '路徑不正確。' });
    const target = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!target.startsWith(root + path.sep)) return json(res, 403, { error: '不能讀取這個檔案。' });
    let data;
    try { data = await readFile(target); } catch { return json(res, 404, { error: '找不到檔案。' }); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    if (!res.headersSent) json(res, error.status || 500, { error: error instanceof RequestError ? error.message : '處理時出現問題，請重試。' });
    else res.end();
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Hokii 錢掌櫃：http://127.0.0.1:${port}`);
  console.log(process.env.OPENAI_API_KEY ? `OpenAI文件辨識已啟用（${model}）。` : '示範模式：內建案例與手動輸入可用；OpenAI文件辨識尚未設定金鑰。');
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `連接埠${port}已使用，請設定PORT後重試。` : '無法啟動本機服務。'); process.exitCode = 1; });
