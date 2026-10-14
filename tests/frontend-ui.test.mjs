import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

// No browser runtime is required. These tests exercise the actual app script
// against a small event-capable DOM. They do not replace visual browser QA.
const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
const engineSource = readFileSync(new URL('../dist/engine.js', import.meta.url), 'utf8');

class Element {
  constructor(tag = 'div', attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.events = {};
    this.attributes = attrs;
    this.style = {};
    this.dataset = {};
    this._value = attrs.value || '';
    this.type = attrs.type || '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.className = attrs.class || '';
    this.textContent = '';
    this.files = [];
    const element = this;
    this.classList = {
      add(...values) {
        const set = new Set(element.className.split(' ').filter(Boolean));
        values.forEach(value => set.add(value));
        element.className = [...set].join(' ');
      },
      remove(...values) { element.className = element.className.split(' ').filter(value => !values.includes(value)).join(' '); },
      toggle(value, force) {
        if (force === undefined) force = !this.contains(value);
        if (force) this.add(value); else this.remove(value);
        return force;
      },
      contains(value) { return element.className.split(' ').includes(value); }
    };
    Object.keys(attrs).filter(key => key.startsWith('data-')).forEach(key => {
      this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = attrs[key];
    });
  }
  get value() { return this._value; }
  set value(value) { this._value = String(value ?? ''); }
  append(...elements) { this.children.push(...elements); }
  replaceChildren(...elements) { this.children = elements; }
  addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const found = [];
    function visit(element) {
      for (const child of element.children) {
        if (!(child instanceof Element)) continue;
        if (selector[0] === '.' ? child.classList.contains(selector.slice(1)) : child.tagName.toLowerCase() === selector) found.push(child);
        visit(child);
      }
    }
    visit(this);
    return found;
  }
  trigger(name, extra = {}) {
    return Promise.all((this.events[name] || []).map(callback => callback.call(this, { target: this, preventDefault() {}, ...extra })));
  }
  click() { return this.trigger('click'); }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100 }; }
}

function createApp(options = {}) {
  const ids = {}, all = [], downloads = [], stored = new Map();
  for (const match of html.matchAll(/<(\w+)\b([^>]*)>/g)) {
    const attrs = {};
    for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]] = attr[2];
    if (!attrs.id) continue;
    ids[attrs.id] = new Element(match[1], attrs);
    all.push(ids[attrs.id]);
  }
  ids.reviewStatus.append(new Element('i'), new Element('span'));
  const document = {
    getElementById(id) { assert.ok(ids[id], 'Referenced DOM ID must exist: ' + id); return ids[id]; },
    createElement(tag) { return new Element(tag); },
    createElementNS(_namespace, tag) { return new Element(tag); },
    createTextNode(text) { return { textContent: String(text) }; },
    querySelectorAll(selector) {
      if (selector === '[data-payment]') return all.filter(element => element.dataset.payment);
      if (selector === '.scenario-chip') return ids.scenarioChips.children;
      return [];
    },
    body: new Element('body')
  };
  const context = {
    document, console, Intl, Date, Math, Set, Number, String, Array, Object, JSON, RegExp, Promise, Blob, AbortController,
    URL: { createObjectURL(blob) { downloads.push(blob); return 'blob:test-' + downloads.length; }, revokeObjectURL() {} },
    FileReader: class {},
    fetch: async (url) => {
      if (url === '/api/status') return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ configured: options.configured === true, model: 'test-model' }) };
      return options.extractFetch ? options.extractFetch() : { ok: true, json: async () => options.extraction };
    },
    localStorage: { setItem(key, value) { stored.set(key, value); }, removeItem(key) { stored.delete(key); } },
    setTimeout() { return 1; }, clearTimeout() {}
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(engineSource, context);
  vm.runInContext(appSource, context);
  return {
    ids, downloads, stored,
    input(id, value, event = 'input') { ids[id].value = value; return ids[id].trigger(event); },
    checkbox(id, value) { ids[id].checked = value; return ids[id].trigger('change'); },
    scenario(id) { return ids.scenarioChips.children.find(element => element.dataset.scenario === id).click(); }
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('normal payment can be reviewed; amount edit invalidates review and field confirmation', () => {
  const app = createApp();
  assert.match(app.ids.safetySignal.className, /green/);
  assert.match(app.ids.cashSignal.className, /green/);
  app.input('reviewBy', '測試覆核人');
  assert.equal(app.ids.approveButton.disabled, false);
  app.ids.approveButton.click();
  assert.match(app.ids.reviewStatus.className, /approved/);
  app.input('amount', 130000);
  assert.match(app.ids.reviewStatus.className, /invalidated/);
  assert.equal(app.ids.confirmationBadge.textContent, '待人工確認');
});

test('legitimate account change requires callback record; another account edit clears callback', () => {
  const app = createApp();
  app.scenario('change-legit');
  assert.match(app.ids.safetySignal.className, /yellow/);
  app.input('reviewBy', '王小鵬');
  app.input('reviewNote', '依原先保存電話回撥確認');
  app.checkbox('accountChangeConfirmed', true);
  assert.match(app.ids.safetySignal.className, /green/);
  assert.equal(app.ids.approveButton.disabled, false);
  app.ids.approveButton.click();
  app.input('account', '000123456789');
  assert.equal(app.ids.accountChangeConfirmed.checked, false);
  assert.equal(app.ids.reviewNote.value, '');
  assert.match(app.ids.reviewStatus.className, /invalidated/);
});

test('duplicate invoice is red and cannot complete review', () => {
  const app = createApp();
  app.scenario('duplicate');
  assert.match(app.ids.safetySignal.className, /red/);
  app.input('reviewBy', '覆核人');
  assert.equal(app.ids.approveButton.disabled, true);
});

test('payroll gap scenario is red and calculates NT$210000 exactly', () => {
  const app = createApp();
  app.scenario('cash-gap');
  assert.match(app.ids.cashSignal.className, /red/);
  assert.equal(app.ids.cashGap.textContent, '210,000');
});

test('missing data produces gray signals rather than a completed review', () => {
  const app = createApp();
  app.scenario('missing');
  assert.match(app.ids.safetySignal.className, /gray/);
  assert.match(app.ids.cashSignal.className, /gray/);
  assert.equal(app.ids.approveButton.disabled, true);
});

function completeBlank(app) {
  app.ids.blankCase.click();
  app.input('supplierName', '測試材料有限公司');
  app.input('taxId', '12345678');
  app.input('invoiceNo', 'TEST001');
  app.input('account', '001234567890');
  app.input('amount', '50000');
  app.ids.baselineAccount.value = '001234567890';
  app.ids.baselinePhone.value = '02-1234-5678 會計窗口';
  app.ids.saveBaseline.click();
  app.ids.confirmFields.click();
  app.input('cashBalance', '1000000');
  app.checkbox('scheduleComplete', true);
  app.input('reviewBy', '手動覆核人');
}

test('blank case has no synthetic supplier; manual baseline supports review and preserves leading zero', () => {
  const app = createApp();
  app.ids.blankCase.click();
  assert.match(app.ids.safetySignal.className, /gray/);
  completeBlank(app);
  assert.match(app.ids.safetySignal.className, /green/);
  assert.equal(app.ids.account.value, '001234567890');
  assert.match(app.ids.cashSignal.className, /green/);
  assert.equal(app.ids.approveButton.disabled, false);
  app.ids.approveButton.click();
  assert.match(app.ids.reviewStatus.className, /approved/);
});

test('new schedule resets completeness and invalidates the existing review', () => {
  const app = createApp();
  completeBlank(app);
  app.ids.approveButton.click();
  app.ids.newLabel.value = '薪資';
  app.ids.newAmount.value = '200000';
  app.ids.addScheduleForm.trigger('submit');
  assert.equal(app.ids.scheduleComplete.checked, false);
  assert.match(app.ids.reviewStatus.className, /invalidated/);
  assert.match(app.ids.cashSignal.className, /gray/);
});

test('unconfigured AI does not pretend that extraction occurred', () => {
  const app = createApp();
  app.ids.analyzeButton.click();
  assert.match(app.ids.extractionNote.textContent, /未啟用/);
  assert.equal(app.ids.documentBadge.textContent, '合成文件');
});

test('AI extraction leaves unrecognized currency empty rather than inventing TWD', async () => {
  const date = new Date();
  const due = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  const app = createApp({ configured: true, extraction: {
    provider: 'openai', model: 'test-model',
    data: { supplierName: '供應商', taxId: '12345678', account: '00123456789', amount: 50000, currency: null, dueDate: due, invoiceNo: 'TEST-AI', evidence: [] }
  } });
  await settle();
  app.ids.blankCase.click();
  app.input('documentText', '請款五萬元，但未載明幣別。');
  app.checkbox('apiConsent', true);
  await app.ids.analyzeButton.click();
  assert.equal(app.ids.currency.value, '');
  assert.equal(app.ids.documentBadge.textContent, 'OpenAI 辨識');
  assert.match(app.ids.safetySignal.className, /gray/);
});

test('an extraction finishing after the user edits payment cannot overwrite that edit', async () => {
  let resolveExtraction;
  const app = createApp({ configured: true, extractFetch: () => new Promise(resolve => { resolveExtraction = resolve; }) });
  await settle();
  app.checkbox('apiConsent', true);
  const pending = app.ids.analyzeButton.click();
  app.input('amount', 88888);
  resolveExtraction({ ok: true, json: async () => ({ provider: 'openai', data: { amount: 99999 } }) });
  await pending;
  assert.equal(app.ids.amount.value, '88888');
  assert.match(app.ids.toast.textContent, /未套用/);
});

test('CSV schedule importer accepts quoted commas and rejects bad rows atomically', async () => {
  const app = createApp();
  app.ids.scheduleCsv.files = [{ size: 180, text: async () => '\uFEFFdate,type,amount,label,certainty\n' + app.ids.balanceDate.value + ',out,"10,000","薪資,第一批",confirmed\n' }];
  app.ids.scheduleCsv.trigger('change');
  await settle();
  assert.match(app.ids.toast.textContent, /已加入 1 筆/);
  assert.equal(app.ids.scheduleComplete.checked, false);
  const count = app.ids.scheduleRows.children.length;
  app.ids.scheduleCsv.files = [{ size: 180, text: async () => 'date,type,amount,label\n' + app.ids.balanceDate.value + ',out,5000,有效列\nnot-a-date,out,5000,無效列\n' }];
  app.ids.scheduleCsv.trigger('change');
  await settle();
  assert.match(app.ids.toast.textContent, /尚未匯入任何資料/);
  assert.equal(app.ids.scheduleRows.children.length, count);
});

test('exported HTML escapes untrusted document text and supplier name', async () => {
  const app = createApp();
  app.input('documentText', '<svg onload="alert(1)">測試</svg>');
  app.input('supplierName', '<img src=x onerror="alert(1)">');
  app.ids.exportHtml.click();
  const output = await app.downloads[0].text();
  assert.match(output, /&lt;svg/);
  assert.match(output, /&lt;img/);
  assert.doesNotMatch(output, /<svg|<img/);
  app.ids.exportJson.click();
  const json = JSON.parse(await app.downloads[1].text());
  assert.equal(json.review.status, 'pending');
  assert.match(json.disclaimer, /未執行匯款/);
});
