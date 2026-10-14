(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };
  const Engine = window.HokiiEngine;
  const moneyFormat = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 });
  const levelLabel = { green: '已核對', yellow: '需要查證', red: '待處理', gray: '資料不足' };
  const fieldNames = { supplierName: '供應商', taxId: '統一編號', account: '收款帳號', amount: '付款金額', currency: '幣別', dueDate: '付款日期', invoiceNo: '請款單號' };
  let state;
  let evaluation;
  let activeScenario = 'normal';
  let scenarioModified = false;
  let approval = null;
  let invalidatedAt = null;
  let selectedFile = null;
  let fileObjectUrl = null;
  let activeTab = 'text';
  let api = { configured: false, model: '', checked: false };
  let busy = false;
  let toastTimeout;
  let extractionAbort = null;
  let extractionSerial = 0;

  function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined && content !== null) element.textContent = String(content);
    return element;
  }
  function replace(id, content) { $(id).replaceChildren(content); }
  function numberOrNull(value) {
    if (value === '' || value === null || value === undefined) return null;
    const parsed = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  function money(value) { return typeof value === 'number' && Number.isFinite(value) ? moneyFormat.format(value) : '—'; }
  function cleanAccount(value) { return String(value || '').replace(/[\s-]/g, ''); }
  function today() {
    const date = new Date();
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  function shortDate(value) { return validDate(value) ? value.slice(5).replace('-', '/') : '未提供'; }
  function uniqueId(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }
  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(function () { $('toast').hidden = true; }, 4800);
  }
  function setExtractionNote(message, style) {
    $('extractionNote').textContent = message;
    $('extractionNote').className = 'inline-note' + (style ? ' ' + style : '');
  }
  function clearApproval() {
    if (approval) {
      approval = null;
      invalidatedAt = new Date().toISOString();
      try { localStorage.removeItem('hokii-mvp-last-review'); } catch (_) {}
      toast('付款資料已變更，先前的覆核已失效，請重新確認。');
    }
  }
  function mutate(options) {
    options = options || {};
    if (options.payment) state.payment.fieldsConfirmed = false;
    if (options.identity) {
      state.verification.accountChangeConfirmed = false;
      state.verification.account = '';
      state.verification.note = '';
      $('reviewNote').value = '';
      $('accountChangeConfirmed').checked = false;
    }
    clearApproval();
    state.version = (Number(state.version) || 0) + 1;
    scenarioModified = !!activeScenario;
    render();
  }
  function normalizeState(value) {
    const result = value && value.state ? value.state : value;
    result.payment = result.payment || {};
    result.payment.id = result.payment.id || uniqueId('PAY');
    result.suppliers = Array.isArray(result.suppliers) ? result.suppliers : [];
    result.history = Array.isArray(result.history) ? result.history : [];
    result.cash = result.cash || { balance: null, balanceDate: today(), reserve: 100000, scheduleComplete: false };
    result.schedule = Array.isArray(result.schedule) ? result.schedule : [];
    result.verification = result.verification || { accountChangeConfirmed: false, by: '', note: '' };
    result.document = result.document || { name: '', text: '', evidence: [] };
    result.document.evidence = Array.isArray(result.document.evidence) ? result.document.evidence : [];
    return result;
  }
  function cancelExtraction() {
    extractionSerial++;
    if (extractionAbort) extractionAbort.abort();
    extractionAbort = null;
    busy = false;
    $('analyzeButton').disabled = false;
    $('analyzeLabel').textContent = '用 AI 整理欄位';
  }
  function clearFile() {
    selectedFile = null;
    if (fileObjectUrl) URL.revokeObjectURL(fileObjectUrl);
    fileObjectUrl = null;
    $('documentFile').value = '';
    $('selectedFileName').textContent = '尚未選擇文件';
    $('sourceFilePreview').replaceChildren();
  }
  function loadScenario(id, announce) {
    cancelExtraction();
    clearFile();
    activeScenario = id;
    scenarioModified = false;
    state = normalizeState(Engine.getScenario(id));
    approval = null;
    invalidatedAt = null;
    $('apiConsent').checked = false;
    $('baselineAccount').value = '';
    $('baselinePhone').value = '';
    setExtractionNote('內建合成示範已預填欄位，並非 AI 辨識結果。修改帳號或金額，就能看看提醒如何改變。');
    switchTab('text');
    fillInputs();
    render();
    if (announce) toast('已載入「' + Engine.scenarios.find(function (item) { return item.id === id; }).label + '」合成情境。');
  }
  function loadBlank(announce, keepFile) {
    cancelExtraction();
    if (!keepFile) clearFile();
    activeScenario = null;
    scenarioModified = false;
    state = normalizeState({
      version: 1,
      payment: { id: uniqueId('PAY'), supplierId: '', supplierName: '', taxId: '', account: '', amount: null, currency: 'TWD', dueDate: today(), invoiceNo: '', emailUrgency: false, emailChangeRequest: false, fieldsConfirmed: false },
      suppliers: [], history: [],
      cash: { balance: null, balanceDate: today(), reserve: 100000, scheduleComplete: false },
      schedule: [], verification: { accountChangeConfirmed: false, account: '', by: '', note: '' },
      document: { name: '人工輸入', text: '', evidence: [], provider: 'manual' }
    });
    approval = null;
    invalidatedAt = null;
    $('apiConsent').checked = false;
    $('baselineAccount').value = '';
    $('baselinePhone').value = '';
    setExtractionNote(api.configured ? '可貼上文字或上傳文件，再使用 AI 整理；也能直接人工填入下方欄位。' : 'AI 尚未啟用，請人工填入下方欄位。空白案例的供應商與金流資料皆需自行建立。');
    fillInputs();
    render();
    if (announce) toast('已建立空白案例。請補齊付款、供應商基準及資金資料。');
  }
  function fillInputs() {
    document.querySelectorAll('[data-payment]').forEach(function (input) {
      const value = state.payment[input.dataset.payment];
      if (input.type === 'checkbox') input.checked = value === true;
      else input.value = value === null || value === undefined ? '' : String(value);
    });
    $('documentText').value = state.document.text || '';
    $('cashBalance').value = state.cash.balance === null || state.cash.balance === undefined ? '' : state.cash.balance;
    $('cashReserve').value = state.cash.reserve === null || state.cash.reserve === undefined ? '' : state.cash.reserve;
    $('balanceDate').value = state.cash.balanceDate || '';
    $('scheduleComplete').checked = state.cash.scheduleComplete === true;
    $('reviewBy').value = state.verification.by || '';
    $('reviewNote').value = state.verification.note || '';
    $('accountChangeConfirmed').checked = state.verification.accountChangeConfirmed === true;
    $('newDate').value = state.cash.balanceDate || today();
  }
  function switchTab(tab) {
    activeTab = tab;
    $('textTab').classList.toggle('active', tab === 'text');
    $('fileTab').classList.toggle('active', tab === 'file');
    $('textTab').setAttribute('aria-selected', String(tab === 'text'));
    $('fileTab').setAttribute('aria-selected', String(tab === 'file'));
    $('textPanel').hidden = tab !== 'text';
    $('filePanel').hidden = tab !== 'file';
  }
  function renderChips() {
    document.querySelectorAll('.scenario-chip').forEach(function (button) {
      button.classList.toggle('active', button.dataset.scenario === activeScenario);
      button.setAttribute('aria-pressed', String(button.dataset.scenario === activeScenario));
    });
    const scenario = Engine.scenarios.find(function (item) { return item.id === activeScenario; });
    $('dataMode').textContent = scenario ? (scenarioModified ? '合成案例 · 已修改' : '合成示範資料') : '手動／上傳案例';
    $('scenarioDescription').textContent = scenario ? scenario.description : '資料由您提供；無法查詢銀行警示帳戶與受款戶名。';
    $('resetScenario').textContent = scenario ? '重設此情境' : '清空此案例';
  }
  function renderBaseline() {
    const supplier = state.suppliers.find(function (item) { return item.id === state.payment.supplierId; });
    const box = node('div');
    box.append(node('h4', '', '既有供應商基準 · 人工建立'));
    if (supplier) {
      box.append(node('p', '', supplier.name + ' · 統編 ' + (supplier.taxId || '未提供')));
      box.append(node('p', '', '原帳號：' + (supplier.accounts || []).join('、')));
      box.append(node('p', '', '可信窗口：' + (supplier.phone || '未提供')));
      const history = state.history.filter(function (item) { return item.supplierId === supplier.id && item.status === 'paid'; });
      box.append(node('p', '', '已付款紀錄：' + history.length + ' 筆 · 此基準不代表銀行戶名查驗'));
    } else {
      box.append(node('p', 'no-baseline', '尚無已確認的基準。請從既有合約或可信窗口建立，才能比對本次帳號。'));
    }
    replace('supplierBaseline', box);
  }
  function renderDocumentEvidence() {
    const container = $('documentEvidence');
    container.replaceChildren();
    $('documentBadge').textContent = state.document.provider === 'openai' ? 'OpenAI 辨識' : (activeScenario ? '合成文件' : '人工／上傳');
    $('documentBadge').className = 'tiny-badge' + (state.document.provider === 'openai' ? ' real-ai' : '');
    if (!state.document.evidence.length) {
      container.append(node('p', 'empty-hint', '尚無擷取依據。可查看原文，人工核對欄位；資料不足時掌櫃會顯示灰燈。'));
      return;
    }
    state.document.evidence.forEach(function (evidence) {
      if (!evidence || typeof evidence !== 'object') return;
      const button = node('button', 'evidence-link');
      button.type = 'button';
      button.append(node('span', '', (fieldNames[evidence.field] || '文件內容') + ' ↗'));
      button.append(node('p', '', evidence.quote || '原文未提供'));
      button.append(node('small', '', evidence.source || state.document.name || '本次文件'));
      button.addEventListener('click', function () { openSource(evidence.source || '原文依據', String(evidence.quote || '') + '\n\n──── 本次文件原文 ────\n' + (state.document.text || '附件請見下方預覽。')); });
      container.append(button);
    });
  }
  function humanEvidence(value) {
    let text = String(value || '');
    Object.keys(fieldNames).forEach(function (key) { text = text.replace(new RegExp(key, 'g'), fieldNames[key]); });
    return text.replace('目前 fieldsConfirmed 不為 true。', '尚未由使用者確認欄位。').replace('供應商 ID：', '供應商資料編號：');
  }
  function renderSignal(kind, result) {
    $(kind + 'Signal').className = 'signal-card level-' + result.level;
    $(kind + 'Level').textContent = levelLabel[result.level] + (kind === 'cash' && result.level !== 'gray' ? ' · 30 天試算' : '');
    $(kind + 'Title').textContent = result.title;
    const captions = kind === 'safety' ? {
      green: '在已完成的核對中未見異常，仍需人工覆核。',
      yellow: '先查清楚差異，留下可信窗口的確認紀錄。',
      red: '請先處理關鍵異常，再決定是否付款。',
      gray: '缺漏資料不能當作已通過，請先補齊。'
    } : {
      green: '依目前排程，餘額高於設定的保留金。',
      yellow: '資金接近保留金，或預期收款延後就有壓力。',
      red: '排程出現負餘額，請檢視付款與入帳日期。',
      gray: '餘額或排程尚不完整，數字僅供預覽。'
    };
    $(kind + 'Caption').textContent = captions[result.level];
  }
  function renderFindings() {
    const all = evaluation.safety.reasons.map(function (reason) { return { reason: reason, axis: '付款', level: evaluation.safety.level }; }).concat(evaluation.cash.reasons.map(function (reason) { return { reason: reason, axis: '資金', level: evaluation.cash.level }; }));
    const priority = { red: 0, gray: 1, yellow: 2, green: 3 };
    all.sort(function (a, b) { return priority[a.level] - priority[b.level]; });
    $('findingCount').textContent = all.length + ' 項核對依據';
    const container = $('findingsList');
    container.replaceChildren();
    all.forEach(function (item) {
      const reason = item.reason;
      const article = node('article', 'finding level-' + item.level);
      article.append(node('span', 'finding-symbol', item.level === 'green' ? '✓' : (item.level === 'gray' ? '?' : '!')));
      const body = node('div');
      body.append(node('p', 'finding-message', reason.message));
      if (reason.evidence) body.append(node('p', 'finding-evidence', humanEvidence(reason.evidence)));
      if (reason.action) body.append(node('p', 'finding-action', '下一步：' + reason.action));
      const button = node('button', 'finding-source', item.axis + '依據 ↗');
      button.type = 'button';
      button.addEventListener('click', function () {
        openSource(item.axis + '核對依據', reason.message + '\n\n依據：' + humanEvidence(reason.evidence) + '\n\n建議：' + reason.action + '\n\n──── 本次文件原文 ────\n' + (state.document.text || '尚未提供文字原文；請核對附件或人工輸入來源。'));
      });
      body.append(button);
      article.append(body);
      container.append(article);
    });
    const next = node('div');
    next.className = 'next-actions-content';
    next.append(node('strong', '', '掌櫃建議'));
    next.append(node('p', '', evaluation.nextActions.length ? evaluation.nextActions.join(' ') : '付款前再對照一次原文，並記錄人工覆核結果。'));
    $('nextActions').replaceChildren(next);
    $('nextActions').style.display = 'block';
    next.style.display = 'flex';
    next.style.gap = '8px';
  }
  function renderCash() {
    const cash = evaluation.cash;
    const paymentDayBalance = cash.paymentDayBalance !== undefined ? cash.paymentDayBalance : ((cash.points || []).find(function (point) { return point.date === state.payment.dueDate; }) || {}).balance;
    $('afterPayment').textContent = money(paymentDayBalance);
    $('afterPayment').classList.toggle('negative', typeof paymentDayBalance === 'number' && paymentDayBalance < 0);
    $('paymentDateLabel').textContent = shortDate(state.payment.dueDate) + ' · 含同日收付款';
    $('minBalance').textContent = money(cash.minBalance);
    $('minBalance').classList.toggle('negative', typeof cash.minBalance === 'number' && cash.minBalance < 0);
    $('minDate').textContent = cash.minDate ? shortDate(cash.minDate) + (cash.level === 'gray' ? ' · 資料不全，僅預覽' : ' · 當日期末') : '等待資料';
    $('cashGap').textContent = money(cash.gap);
    $('cashGap').classList.toggle('negative', typeof cash.gap === 'number' && cash.gap > 0);
    renderChart(cash);
    renderSchedule();
  }
  function svgNode(tag, attrs, content) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (key) { element.setAttribute(key, String(attrs[key])); });
    if (content !== undefined) element.textContent = String(content);
    return element;
  }
  function compactMoney(value) {
    if (Math.abs(value) >= 10000) return moneyFormat.format(value / 10000) + '萬';
    return moneyFormat.format(value);
  }
  function renderChart(cash) {
    const container = $('cashChart');
    container.replaceChildren();
    const points = (cash.points || []).filter(function (point) { return Number.isFinite(point.balance) && Number.isFinite(point.stressBalance); });
    if (!points.length) {
      container.append(node('p', 'empty-hint', '填入餘額與資料日期，掌櫃就能開始試算。'));
      container.setAttribute('aria-label', '尚未提供有效餘額，無法繪製現金趨勢');
      return;
    }
    const width = 600, height = 181, left = 50, right = 8, top = 17, bottom = 25;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const values = points.reduce(function (all, point) { return all.concat([point.balance, point.stressBalance]); }, [0, Number(state.cash.reserve) || 0]);
    const low = Math.min.apply(null, values), high = Math.max.apply(null, values);
    const span = Math.max(10000, high - low);
    const min = low - span * 0.1, max = high + span * 0.15;
    const x = function (i) { return left + i / Math.max(1, points.length - 1) * plotWidth; };
    const y = function (value) { return top + (max - value) / (max - min) * plotHeight; };
    const svg = svgNode('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'presentation', 'aria-hidden': 'true' });
    for (let i = 0; i < 4; i++) {
      const value = max - (max - min) * i / 3;
      const lineY = y(value);
      svg.append(svgNode('line', { x1: left, y1: lineY, x2: width - right, y2: lineY, stroke: '#edf0f4', 'stroke-width': 1 }));
      svg.append(svgNode('text', { x: left - 8, y: lineY + 3, fill: '#99a5b4', 'text-anchor': 'end', 'font-size': 9 }, compactMoney(Math.round(value))));
    }
    if (low < 0) {
      svg.append(svgNode('line', { x1: left, y1: y(0), x2: width - right, y2: y(0), stroke: '#df9188', 'stroke-width': 1, 'stroke-dasharray': '3 4' }));
      svg.append(svgNode('text', { x: left + 5, y: y(0) - 4, fill: '#bf7068', 'font-size': 8 }, '0 元'));
    }
    if (Number.isFinite(state.cash.reserve) && state.cash.reserve > 0) svg.append(svgNode('line', { x1: left, y1: y(state.cash.reserve), x2: width - right, y2: y(state.cash.reserve), stroke: '#b6c8b9', 'stroke-width': 1, 'stroke-dasharray': '2 4' }));
    const linePath = points.map(function (point, i) { return (i ? 'L' : 'M') + x(i).toFixed(2) + ' ' + y(point.balance).toFixed(2); }).join(' ');
    const areaPath = linePath + ' L' + x(points.length - 1).toFixed(2) + ' ' + (height - bottom) + ' L' + left + ' ' + (height - bottom) + ' Z';
    svg.append(svgNode('path', { d: areaPath, fill: cash.level === 'red' ? '#fbede8' : '#eaf0f5', opacity: 0.8 }));
    const stressPath = points.map(function (point, i) { return (i ? 'L' : 'M') + x(i).toFixed(2) + ' ' + y(point.stressBalance).toFixed(2); }).join(' ');
    svg.append(svgNode('path', { d: stressPath, fill: 'none', stroke: '#d4a371', 'stroke-width': 1.7, 'stroke-dasharray': '4 4', 'stroke-linejoin': 'round' }));
    svg.append(svgNode('path', { d: linePath, fill: 'none', stroke: cash.level === 'red' ? '#b96550' : '#355879', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    const minIndex = points.findIndex(function (point) { return point.balance === cash.minBalance; });
    if (minIndex >= 0) svg.append(svgNode('circle', { cx: x(minIndex), cy: y(points[minIndex].balance), r: 3.5, fill: cash.minBalance < 0 ? '#b54641' : '#355879', stroke: '#fff', 'stroke-width': 1.5 }));
    [0, Math.floor((points.length - 1) / 2), points.length - 1].forEach(function (i) { svg.append(svgNode('text', { x: x(i), y: height - 4, fill: '#99a5b4', 'text-anchor': i === 0 ? 'start' : (i === points.length - 1 ? 'end' : 'middle'), 'font-size': 9 }, shortDate(points[i].date))); });
    container.append(svg);
    container.setAttribute('aria-label', '30 天現金流，最低餘額 ' + money(cash.minBalance) + ' 元，發生於 ' + (cash.minDate || '未提供') + '。預期收款延後 7 天的最低餘額為 ' + money(cash.stressMinBalance) + ' 元。');
  }
  function scheduleRow(item, isPayment) {
    const row = node('tr');
    const description = node('td');
    description.append(node('strong', '', item.label || '未命名'));
    description.append(node('small', '', shortDate(item.date) + ' · ' + (isPayment ? '已自動計入一次' : (item.certainty === 'expected' ? '預期' : '已確認'))));
    row.append(description);
    const typeCell = node('td');
    typeCell.append(node('span', 'type-tag ' + (isPayment ? 'linked' : (item.type === 'in' ? 'incoming' : '')), isPayment ? '本筆' : (item.type === 'in' ? '收入' : '支出')));
    row.append(typeCell);
    row.append(node('td', 'amount-cell ' + (item.type === 'in' ? 'incoming' : 'outgoing'), (item.type === 'in' ? '+' : '−') + money(item.amount)));
    const action = node('td');
    if (!isPayment) {
      const button = node('button', 'remove-schedule', '×');
      button.type = 'button';
      button.title = '移除「' + (item.label || '排程') + '」';
      button.setAttribute('aria-label', button.title);
      button.addEventListener('click', function () {
        state.schedule = state.schedule.filter(function (entry) { return entry.id !== item.id; });
        state.cash.scheduleComplete = false;
        $('scheduleComplete').checked = false;
        mutate();
        toast('已移除此排程。請重新確認未來收付款是否完整。');
      });
      action.append(button);
    } else action.append(node('span', '', '—'));
    row.append(action);
    return row;
  }
  function renderSchedule() {
    const body = $('scheduleRows');
    body.replaceChildren();
    if (state.payment.amount !== null && state.payment.amount > 0) body.append(scheduleRow({ label: '本次付款 · ' + (state.payment.supplierName || '供應商待填'), date: state.payment.dueDate, type: 'out', amount: state.payment.amount, certainty: 'confirmed' }, true));
    state.schedule.slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); }).forEach(function (item) {
      if (item.linkedPaymentId === state.payment.id && item.type === 'out' && item.amount === state.payment.amount && item.date === state.payment.dueDate) return;
      body.append(scheduleRow(item, false));
    });
    if (!body.children.length) {
      const row = node('tr');
      const cell = node('td', 'empty-hint', '尚無收付款排程；請補齊薪資、租金、稅款等。');
      cell.colSpan = 4;
      row.append(cell);
      body.append(row);
    }
  }
  function renderReview() {
    const status = $('reviewStatus');
    status.className = 'review-status';
    if (approval) {
      status.classList.add('approved');
      status.querySelector('span').textContent = '已覆核 · ' + approval.by + ' · v' + state.version;
      $('reviewHelp').textContent = '本次覆核已記錄，尚未執行匯款。可下載核對紀錄；修改關鍵資料後會失效。';
    } else if (invalidatedAt) {
      status.classList.add('invalidated');
      status.querySelector('span').textContent = '資料已變更 · 需要重新覆核';
      $('reviewHelp').textContent = '先前的覆核已失效。請核對修改後資料，再重新記錄。';
    } else {
      status.querySelector('span').textContent = '尚未完成覆核 · v' + state.version;
      $('reviewHelp').textContent = evaluation.readyForReview ? '目前已具備覆核資料，請填入覆核人姓名。' : '先處理灰燈／紅燈及尚未查證的帳號變更，再記錄覆核完成。仍可下載待處理紀錄。';
    }
    $('approveButton').disabled = !!approval || !evaluation.readyForReview || !String(state.verification.by || '').trim();
    $('approveButton').textContent = approval ? '✓ 本次已完成覆核' : '記錄覆核完成';
  }
  function render() {
    evaluation = Engine.evaluate(state);
    renderChips();
    renderBaseline();
    renderDocumentEvidence();
    renderSignal('safety', evaluation.safety);
    renderSignal('cash', evaluation.cash);
    renderFindings();
    renderCash();
    renderReview();
    $('confirmationBadge').textContent = state.payment.fieldsConfirmed ? '欄位已確認' : '待人工確認';
    $('confirmationBadge').className = 'tiny-badge' + (state.payment.fieldsConfirmed ? ' confirmed' : '');
    $('confirmFields').textContent = state.payment.fieldsConfirmed ? '✓ 上述欄位已核對' : '我已核對上述欄位';
    $('fieldsConfirmedText').textContent = state.payment.fieldsConfirmed ? '任一關鍵欄位修改後，需重新確認' : '請對照原文確認帳號、金額與付款日';
    $('evaluationTime').textContent = '依目前輸入 · 版本 ' + state.version;
  }
  function openSource(title, text) {
    $('sourceTitle').textContent = title || state.document.name || '本次文件';
    $('sourceContent').textContent = text || state.document.text || '尚未提供文字原文。';
    const preview = $('sourceFilePreview');
    preview.replaceChildren();
    if (selectedFile) {
      if (!fileObjectUrl) fileObjectUrl = URL.createObjectURL(selectedFile);
      if (selectedFile.type === 'application/pdf' || /\.pdf$/i.test(selectedFile.name)) {
        const iframe = node('iframe');
        iframe.src = fileObjectUrl;
        iframe.title = '原始 PDF：' + selectedFile.name;
        preview.append(iframe);
      } else {
        const img = node('img');
        img.src = fileObjectUrl;
        img.alt = '原始上傳文件：' + selectedFile.name;
        preview.append(img);
      }
      const link = node('a', '', '另開原始附件 ↗');
      link.href = fileObjectUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      preview.append(link);
    }
    if (!$('sourceDialog').open) $('sourceDialog').showModal();
  }
  function readDataUrl(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('讀取附件失敗，請重新選擇。')); };
      reader.readAsDataURL(file);
    });
  }
  function redactContacts(text) {
    return String(text || '').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL 已遮罩]').replace(/\b09\d{8}\b/g, '[手機已遮罩]').replace(/0\d{1,2}[- ]\d{6,8}(?:\s*(?:#|分機)\s*\d+)?/g, '[電話已遮罩]');
  }
  async function checkApi() {
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, 5000);
    try {
      const response = await fetch('/api/status', { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) throw new Error('not configured');
      const data = await response.json();
      api = { configured: data.configured === true, model: data.model || '', checked: true };
    } catch (_) { api = { configured: false, model: '', checked: true }; }
    finally { clearTimeout(timeout); }
    $('apiStatus').classList.toggle('connected', api.configured);
    $('apiStatus').replaceChildren(node('i'), document.createTextNode(api.configured ? 'OpenAI 已啟用' : '示範模式 · 可手動輸入'));
    if (!activeScenario) setExtractionNote(api.configured ? '可將本次文件送交 OpenAI 整理，擷取後仍需人工確認。' : '此模式未啟用 AI。可使用合成示範，或手動輸入付款與資金資料。');
  }
  async function extract() {
    if (busy) return;
    if (!api.configured) {
      setExtractionNote('目前未啟用 OpenAI。內建合成示範可完整操作；上傳案例請人工填入欄位。', 'warning');
      toast('AI 尚未啟用。請直接填入下方付款欄位，或選擇合成示範。');
      $('supplierName').focus();
      return;
    }
    if (!$('apiConsent').checked) {
      setExtractionNote('請先確認要送出的內容，並勾選同意傳至 OpenAI API。文字遮罩只處理常見 Email／電話格式；附件以原檔傳送。', 'warning');
      $('apiConsent').focus();
      return;
    }
    const originalText = $('documentText').value.trim();
    if (activeTab === 'file' && !selectedFile) { setExtractionNote('請先選擇 PDF 或圖片。', 'warning'); return; }
    if (activeTab === 'text' && !originalText) { setExtractionNote('請先貼上請款單或廠商通知文字。', 'warning'); $('documentText').focus(); return; }
    busy = true;
    $('analyzeButton').disabled = true;
    $('analyzeLabel').textContent = '掌櫃正在讀文件…';
    const serial = ++extractionSerial;
    const inputVersion = state.version;
    const controller = new AbortController();
    extractionAbort = controller;
    const timeout = setTimeout(function () { controller.abort(); }, 90000);
    try {
      const payload = { text: $('maskText').checked ? redactContacts(originalText) : originalText };
      if (activeTab === 'file' && selectedFile) payload.file = { name: selectedFile.name, type: selectedFile.type || (/\.pdf$/i.test(selectedFile.name) ? 'application/pdf' : 'image/jpeg'), data: await readDataUrl(selectedFile) };
      const response = await fetch('/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
      let result;
      try { result = await response.json(); } catch (_) { throw new Error('AI 服務未回傳可讀結果，請使用人工輸入。'); }
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : ((result.error && result.error.message) || '文件整理失敗，請稍後再試。'));
      if (serial !== extractionSerial) return;
      if (state.version !== inputVersion) { toast('整理期間您已修改資料，這次結果未套用。請重新整理，以保留您的修改。'); return; }
      if (result.provider !== 'openai' || !result.data || typeof result.data !== 'object') throw new Error('此回應沒有確認來自 OpenAI，未套用辨識結果。');
      const data = result.data;
      Object.keys(fieldNames).forEach(function (key) {
        if (key === 'amount') state.payment.amount = numberOrNull(data.amount);
        else state.payment[key] = data[key] === null || data[key] === undefined ? '' : String(data[key]).slice(0, 180);
      });
      state.payment.emailUrgency = data.emailUrgency === true;
      state.payment.emailChangeRequest = data.emailChangeRequest === true;
      const supplier = state.suppliers.find(function (item) { return (state.payment.taxId && item.taxId === state.payment.taxId) || item.name === state.payment.supplierName; });
      state.payment.supplierId = supplier ? supplier.id : '';
      state.document.name = selectedFile && activeTab === 'file' ? selectedFile.name : '貼上請款文字';
      state.document.text = originalText;
      state.document.evidence = Array.isArray(data.evidence) ? data.evidence.slice(0, 30).filter(function (item) { return item && typeof item === 'object'; }).map(function (item) { return { field: String(item.field || '').slice(0, 80), quote: String(item.quote || '').slice(0, 1600), source: String(item.source || state.document.name).slice(0, 160) }; }) : [];
      state.document.provider = 'openai';
      state.document.model = result.model || api.model;
      mutate({ payment: true, identity: true });
      fillInputs();
      setExtractionNote('已由 OpenAI 整理欄位。請對照原文，修正後點選「我已核對上述欄位」；缺漏欄位不會自動補猜。');
      toast('AI 已整理文件，下一步請人工核對帳號、金額與日期。');
    } catch (error) {
      if (serial !== extractionSerial) return;
      setExtractionNote(error.name === 'AbortError' ? '文件整理逾時，請再試一次或人工輸入。' : String(error.message || '文件整理失敗'), 'error');
    } finally {
      clearTimeout(timeout);
      if (serial === extractionSerial) {
        busy = false;
        extractionAbort = null;
        $('analyzeButton').disabled = false;
        $('analyzeLabel').textContent = '用 AI 整理欄位';
      }
    }
  }
  function acceptFile(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('文件超過 8 MB，請縮小檔案後重新上傳。'); $('documentFile').value = ''; return; }
    const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
    if (!allowed.includes(file.type) && !/\.(pdf|png|jpe?g|webp)$/i.test(file.name)) { toast('請使用 PDF、PNG、JPG 或 WebP 文件。'); $('documentFile').value = ''; return; }
    loadBlank(false, false);
    selectedFile = file;
    state.document.name = file.name;
    $('selectedFileName').textContent = file.name + ' · ' + (file.size / 1024 / 1024).toFixed(2) + ' MB';
    switchTab('file');
    render();
    setExtractionNote(api.configured ? '已選擇附件。請確認原檔已去識別化，勾選同意後再送交 AI 整理。' : '已選擇附件，目前未啟用 AI。可查看原檔，並人工填入下方欄位。', api.configured ? '' : 'warning');
    toast('已為這份附件建立空白案例，不會沿用合成的供應商與金流資料。');
  }
  function confirmPayment() {
    const payment = state.payment;
    if (!String(payment.supplierName || '').trim() || !/^\d{8}$/.test(payment.taxId || '') || !cleanAccount(payment.account) || !Number.isFinite(payment.amount) || payment.amount <= 0 || !validDate(payment.dueDate) || !String(payment.invoiceNo || '').trim()) {
      toast('請補齊供應商、8 位統編、帳號、正數金額、付款日及請款單號。');
      $('fieldsConfirmedText').textContent = '關鍵欄位尚不完整，請補齊後再確認';
      return;
    }
    state.payment.fieldsConfirmed = true;
    mutate();
    toast('欄位已標記為人工確認。請繼續處理掌櫃提醒。');
  }
  function saveBaseline() {
    const account = $('baselineAccount').value.trim();
    const phone = $('baselinePhone').value.trim();
    if (!state.payment.supplierName.trim() || !/^\d{8}$/.test(state.payment.taxId || '') || !/^\d{5,30}$/.test(cleanAccount(account)) || !phone) {
      toast('請先填入供應商名稱、8 位統編，以及可信來源的既有帳號與聯絡窗口。');
      return;
    }
    let supplier = state.suppliers.find(function (item) { return item.taxId === state.payment.taxId; });
    if (!supplier) {
      supplier = { id: uniqueId('SUP'), name: state.payment.supplierName, taxId: state.payment.taxId, accounts: [], phone: phone };
      state.suppliers.push(supplier);
    }
    if (!supplier.accounts.some(function (old) { return cleanAccount(old) === cleanAccount(account); })) supplier.accounts.push(account);
    supplier.phone = phone;
    state.payment.supplierId = supplier.id;
    mutate({ identity: true });
    toast('已保存人工確認的基準。原帳號已保留；這不是銀行戶名查驗。');
  }
  function addSchedule(event) {
    event.preventDefault();
    const amount = numberOrNull($('newAmount').value);
    const date = $('newDate').value;
    const label = $('newLabel').value.trim();
    if (!validDate(date) || !Number.isFinite(amount) || amount <= 0 || !label) { toast('請填入有效日期、項目及正數金額。'); return; }
    state.schedule.push({ id: uniqueId('SCH'), date: date, type: $('newType').value, amount: amount, label: label, certainty: $('newCertainty').value });
    state.cash.scheduleComplete = false;
    $('scheduleComplete').checked = false;
    $('newLabel').value = '';
    $('newAmount').value = '';
    mutate();
    toast('已加入排程。請重新確認未來收付款是否完整。');
  }
  function parseCsv(text) {
    const rows = [];
    let row = [], value = '', quoted = false;
    text = String(text).replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        if (quoted && text[i + 1] === '"') { value += '"'; i++; }
        else if (quoted || !value.length) quoted = !quoted;
        else throw new Error('CSV 引號格式錯誤。請使用下載範本。');
      } else if (char === ',' && !quoted) { row.push(value); value = ''; }
      else if ((char === '\n' || char === '\r') && !quoted) {
        if (char === '\r' && text[i + 1] === '\n') i++;
        row.push(value);
        if (row.some(function (cell) { return cell.trim(); })) rows.push(row);
        row = []; value = '';
      } else value += char;
    }
    if (quoted) throw new Error('CSV 有未結束的引號。');
    row.push(value);
    if (row.some(function (cell) { return cell.trim(); })) rows.push(row);
    return rows;
  }
  async function importCsv(file) {
    if (!file) return;
    if (file.size > 1024 * 1024) { toast('CSV 請小於 1 MB，最多匯入 1,000 筆。'); return; }
    try {
      const rows = parseCsv(await file.text());
      if (rows.length < 2) throw new Error('CSV 至少需要欄位列與一筆資料。');
      if (rows.length > 1001) throw new Error('每次最多匯入 1,000 筆排程。');
      const headers = rows.shift().map(function (header) { return header.trim().toLowerCase(); });
      const aliases = { date: ['date', '日期'], type: ['type', '收付', '類型'], amount: ['amount', '金額'], label: ['label', '項目', '名稱'], certainty: ['certainty', '確定性'], linkedPaymentId: ['linkedpaymentid'] };
      const positions = {};
      Object.keys(aliases).forEach(function (key) { positions[key] = headers.findIndex(function (header) { return aliases[key].includes(header); }); });
      if (['date', 'type', 'amount', 'label'].some(function (key) { return positions[key] < 0; })) throw new Error('需要 date,type,amount,label 欄位，請先下載 CSV 範本。');
      const imported = rows.map(function (row, index) {
        const cell = function (key) { return positions[key] < 0 ? '' : String(row[positions[key]] || '').trim(); };
        const types = { in: 'in', out: 'out', '收入': 'in', '支出': 'out' };
        const certainty = { confirmed: 'confirmed', expected: 'expected', '已確認': 'confirmed', '預期': 'expected', '': 'confirmed' }[cell('certainty')];
        const type = types[cell('type').toLowerCase()];
        const rawAmount = cell('amount');
        const amount = numberOrNull(rawAmount);
        if (!validDate(cell('date')) || !type || !certainty || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(rawAmount) || amount <= 0 || !cell('label')) throw new Error('CSV 第 ' + (index + 2) + ' 列有無效日期、收付類型、金額或名稱；尚未匯入任何資料。');
        const result = { id: uniqueId('CSV'), date: cell('date'), type: type, amount: amount, label: cell('label').slice(0, 180), certainty: certainty };
        if (cell('linkedPaymentId') === 'current' || cell('linkedPaymentId') === state.payment.id) result.linkedPaymentId = state.payment.id;
        return result;
      });
      state.schedule = state.schedule.concat(imported);
      state.cash.scheduleComplete = false;
      $('scheduleComplete').checked = false;
      mutate();
      toast('已加入 ' + imported.length + ' 筆排程。請重新確認完整性，勿重複加入本次付款。');
    } catch (error) { toast(error.message || 'CSV 匯入失敗，請使用下載範本。'); }
    finally { $('scheduleCsv').value = ''; }
  }
  function download(content, type, filename) {
    const url = URL.createObjectURL(new Blob([content], { type: type }));
    const link = node('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function record() {
    return {
      product: 'Hokii 錢掌櫃', team: 'Pengwin', exportedAt: new Date().toISOString(),
      mode: activeScenario ? 'synthetic-demo' : 'user-provided',
      disclaimer: '競賽 MVP；未執行匯款、未核貸。未查詢銀行灰名單、警示帳戶及受款戶名。本機紀錄不是銀行授權憑證。',
      version: state.version, state: state, evaluation: evaluation,
      review: approval && approval.snapshot === Engine.snapshot(state) ? { status: 'reviewed', by: approval.by, at: approval.at, note: approval.note, version: approval.version } : { status: invalidatedAt ? 'invalidated' : 'pending', invalidatedAt: invalidatedAt }
    };
  }
  function escapeHtml(value) { return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (char) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]; }); }
  function recordHtml(data) {
    const p = data.state.payment;
    const reasons = data.evaluation.safety.reasons.concat(data.evaluation.cash.reasons);
    const rows = data.state.schedule.map(function (item) { return '<tr><td>' + escapeHtml(item.date) + '</td><td>' + escapeHtml(item.label) + '</td><td>' + (item.type === 'in' ? '收入' : '支出') + '</td><td>' + escapeHtml(money(item.amount)) + '</td><td>' + (item.certainty === 'expected' ? '預期' : '已確認') + '</td></tr>'; }).join('');
    const findings = reasons.map(function (reason) { return '<li><strong>' + escapeHtml(reason.message) + '</strong><p>' + escapeHtml(humanEvidence(reason.evidence)) + '</p><p>下一步：' + escapeHtml(reason.action) + '</p></li>'; }).join('');
    const details = Object.keys(fieldNames).map(function (field) { return '<tr><th>' + escapeHtml(fieldNames[field]) + '</th><td>' + escapeHtml(field === 'amount' ? money(p[field]) : p[field]) + '</td></tr>'; }).join('');
    return '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hokii 付款核對紀錄</title><style>body{font-family:system-ui,"Microsoft JhengHei",sans-serif;color:#182c48;line-height:1.8;max-width:840px;padding:35px;margin:auto;background:#faf9f6}h1{font-size:27px}h2{font-size:18px;margin-top:30px}small,p{color:#68778c;font-size:13px}table{width:100%;border-collapse:collapse;background:white}td,th{padding:10px;border-bottom:1px solid #e7ebf0;font-size:13px;text-align:left}th{width:150px}li{padding-bottom:15px;font-size:13px}li p{margin:3px 0}.status{background:#fff2e6;padding:17px;border:1px solid #ead6c4;border-radius:8px}.source{white-space:pre-wrap;font-size:12px;padding:18px;background:#fff;border:1px solid #e7ebf0;overflow-wrap:anywhere}@media print{body{background:white;padding:15px}h2,table{break-inside:avoid}}</style></head><body><small>Pengwin · Hokii 錢掌櫃 · 競賽 MVP</small><h1>付款核對紀錄</h1><p>匯出時間：' + escapeHtml(new Date(data.exportedAt).toLocaleString('zh-TW')) + ' · 版本 ' + escapeHtml(data.version) + ' · ' + (data.mode === 'synthetic-demo' ? '合成示範資料' : '使用者提供資料') + '</p><div class="status"><strong>' + (data.review.status === 'reviewed' ? '已記錄人工覆核，未執行匯款' : (data.review.status === 'invalidated' ? '先前覆核已失效，需要重新確認' : '尚未完成覆核')) + '</strong><p>覆核人：' + escapeHtml(data.review.by || '未提供') + ' · ' + escapeHtml(data.review.note || '尚未記錄') + '</p></div><h2>本次付款</h2><table>' + details + '</table><h2>雙燈結果</h2><p>付款核對：' + escapeHtml(levelLabel[data.evaluation.safety.level]) + ' · ' + escapeHtml(data.evaluation.safety.title) + '</p><p>資金試算：' + escapeHtml(levelLabel[data.evaluation.cash.level]) + ' · ' + escapeHtml(data.evaluation.cash.title) + '</p><p>30 天最低餘額：NT$ ' + escapeHtml(money(data.evaluation.cash.minBalance)) + ' · 日期：' + escapeHtml(data.evaluation.cash.minDate || '未提供') + ' · 缺口：NT$ ' + escapeHtml(money(data.evaluation.cash.gap)) + '</p><h2>核對依據與建議</h2><ul>' + findings + '</ul><h2>收付款排程（本筆另計一次）</h2><table><tr><th>日期</th><th>項目</th><th>收付</th><th>金額</th><th>確定性</th></tr>' + rows + '</table><h2>本次文件原文</h2><div class="source">' + escapeHtml(data.state.document.text || '未提供文字原文；附件需另外留存。') + '</div><h2>使用範圍</h2><p>' + escapeHtml(data.disclaimer) + '</p></body></html>';
  }
  function approve() {
    const by = $('reviewBy').value.trim();
    if (!by || !evaluation.readyForReview) { toast('請先處理待補資料與異常，並填入覆核人姓名。'); return; }
    if (state.verification.accountChangeConfirmed && !state.verification.note.trim()) { toast('帳號變更查證需要記錄確認方式與可信窗口。'); return; }
    approval = { by: by, note: state.verification.note || '', at: new Date().toISOString(), version: state.version, snapshot: Engine.snapshot(state) };
    invalidatedAt = null;
    try { localStorage.setItem('hokii-mvp-last-review', JSON.stringify({ by: approval.by, at: approval.at, version: approval.version, mode: activeScenario ? 'synthetic-demo' : 'user-provided', note: '本機 MVP 紀錄，非銀行授權' })); } catch (_) {}
    renderReview();
    toast('已記錄人工覆核。掌櫃不執行匯款，請至正式銀行服務完成付款。');
  }
  function fundingSummary() {
    const cash = evaluation.cash;
    const summary = [
      'Hokii 錢掌櫃｜資金需求摘要', 'Pengwin 競賽 MVP · 非貸款核准或撥款保證',
      '資料模式：' + (activeScenario ? '合成示範' : '使用者輸入'), '',
      '餘額資料日：' + (state.cash.balanceDate || '未提供'),
      '可用餘額：NT$ ' + money(state.cash.balance),
      '本次付款：' + (state.payment.supplierName || '未提供') + '／NT$ ' + money(state.payment.amount) + '／' + (state.payment.dueDate || '未提供'),
      '30 天最低餘額：NT$ ' + money(cash.minBalance) + '／' + (cash.minDate || '未提供'),
      '試算資金缺口：NT$ ' + money(cash.gap),
      '預期收款延後 7 天時的缺口：NT$ ' + money(cash.stressGap),
      '資料狀態：' + cash.title,
      '收付款完整性：' + (state.cash.scheduleComplete ? '使用者已確認' : '尚未確認，數字僅供預覽'), '',
      '下一步：核對入帳與付款日期，評估應收款追蹤、付款協調與周轉需求。',
      '申請中的貸款未列入可用資金。實際貸款須由銀行審查、簽約與撥款。',
      '臺企銀官方微企享 e 貸入口：https://www.tbb.com.tw/zh-tw/business/loans/online-apply/microenterprise-online-loans'
    ].join('\n');
    openSource('資金需求摘要', summary);
    download('\uFEFF' + summary, 'text/plain;charset=utf-8', 'Hokii_資金需求摘要_' + today() + '.txt');
  }
  function bindEvents() {
    $('textTab').addEventListener('click', function () { switchTab('text'); });
    $('fileTab').addEventListener('click', function () { switchTab('file'); });
    $('blankCase').addEventListener('click', function () { loadBlank(true); switchTab('text'); });
    $('resetScenario').addEventListener('click', function () { if (activeScenario) loadScenario(activeScenario, true); else loadBlank(true); });
    $('showDocument').addEventListener('click', function () { openSource(state.document.name || '本次文件', state.document.text); });
    $('closeDialog').addEventListener('click', function () { $('sourceDialog').close(); });
    $('sourceDialog').addEventListener('click', function (event) { if (event.target === $('sourceDialog')) { const box = $('sourceDialog').getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $('sourceDialog').close(); } });
    $('documentText').addEventListener('input', function () {
      state.document.text = this.value;
      state.document.evidence = [];
      state.document.provider = 'manual';
      mutate({ payment: true });
      setExtractionNote(activeScenario ? '原文已修改，欄位需要重新核對。供應商與資金仍為合成資料；使用自己的文件請先開始空白案例。' : '原文已修改，請重新整理或人工更新付款欄位。', activeScenario ? 'warning' : '');
    });
    $('documentFile').addEventListener('change', function () { acceptFile(this.files[0]); });
    const drop = $('dropZone');
    ['dragenter', 'dragover'].forEach(function (eventName) { drop.addEventListener(eventName, function (event) { event.preventDefault(); drop.classList.add('dragging'); }); });
    ['dragleave', 'drop'].forEach(function (eventName) { drop.addEventListener(eventName, function (event) { event.preventDefault(); drop.classList.remove('dragging'); }); });
    drop.addEventListener('drop', function (event) { if (event.dataTransfer && event.dataTransfer.files.length) acceptFile(event.dataTransfer.files[0]); });
    $('analyzeButton').addEventListener('click', extract);
    $('confirmFields').addEventListener('click', confirmPayment);
    $('saveBaseline').addEventListener('click', saveBaseline);
    document.querySelectorAll('[data-payment]').forEach(function (input) {
      input.addEventListener(input.type === 'checkbox' || input.tagName === 'SELECT' || input.type === 'date' ? 'change' : 'input', function () {
        const field = input.dataset.payment;
        state.payment[field] = input.type === 'checkbox' ? input.checked : (field === 'amount' ? numberOrNull(input.value) : input.value);
        mutate({ payment: true, identity: ['account', 'taxId', 'supplierName', 'supplierId'].includes(field) });
      });
    });
    [['cashBalance', 'balance'], ['cashReserve', 'reserve']].forEach(function (item) { $(item[0]).addEventListener('input', function () { state.cash[item[1]] = numberOrNull(this.value); mutate(); }); });
    $('balanceDate').addEventListener('change', function () { state.cash.balanceDate = this.value; mutate(); });
    $('scheduleComplete').addEventListener('change', function () { state.cash.scheduleComplete = this.checked; mutate(); });
    $('reviewBy').addEventListener('input', function () { state.verification.by = this.value; mutate(); });
    $('reviewNote').addEventListener('input', function () { state.verification.note = this.value; mutate(); });
    $('accountChangeConfirmed').addEventListener('change', function () { state.verification.accountChangeConfirmed = this.checked; state.verification.account = this.checked ? state.payment.account : ''; mutate(); });
    $('addScheduleForm').addEventListener('submit', addSchedule);
    $('importSchedule').addEventListener('click', function () { $('scheduleCsv').click(); });
    $('scheduleCsv').addEventListener('change', function () { importCsv(this.files[0]); });
    $('downloadCsv').addEventListener('click', function () { download('\uFEFFdate,type,amount,label,certainty\n' + today() + ',out,50000,範例租金支出,confirmed\n' + today() + ',in,100000,範例客戶貨款,expected\n', 'text/csv;charset=utf-8', 'Hokii_收付款排程範本.csv'); });
    $('approveButton').addEventListener('click', approve);
    $('exportHtml').addEventListener('click', function () { download(recordHtml(record()), 'text/html;charset=utf-8', 'Hokii_付款核對紀錄_' + today() + '_v' + state.version + '.html'); toast('已下載核對紀錄，可用瀏覽器開啟或列印成 PDF。'); });
    $('exportJson').addEventListener('click', function () { download(JSON.stringify(record(), null, 2), 'application/json;charset=utf-8', 'Hokii_付款核對紀錄_' + today() + '_v' + state.version + '.json'); });
    $('fundingSummary').addEventListener('click', fundingSummary);
  }
  if (!Engine) {
    $('safetyTitle').textContent = '核對引擎未載入';
    $('cashTitle').textContent = '請重新整理頁面';
    $('scenarioDescription').textContent = '請確認 engine.js 與網站其他檔案位於同一資料夾。';
    return;
  }
  Engine.scenarios.forEach(function (scenario) {
    const button = node('button', 'scenario-chip');
    button.type = 'button';
    button.dataset.scenario = scenario.id;
    button.append(node('span'), document.createTextNode(scenario.label));
    button.title = scenario.description;
    button.addEventListener('click', function () { loadScenario(scenario.id, true); });
    $('scenarioChips').append(button);
  });
  bindEvents();
  loadScenario('normal', false);
  checkApi();
})();
