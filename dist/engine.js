(function (root) {
  'use strict';

  const DAY = 86400000;
  const levels = { green: 0, yellow: 1, red: 2, gray: 3 };
  const isNumber = value => typeof value === 'number' && Number.isFinite(value);
  const cents = value => Math.round(value * 100);
  const money = value => value / 100;
  const cleanAccount = value => String(value || '').replace(/[\s-]/g, '');
  const present = value => typeof value === 'string' && value.trim().length > 0;
  const dateValue = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    const parsed = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : null;
  };
  const today = () => {
    const now = new Date();
    return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  };
  const shift = (date, offset) => new Date(dateValue(date) + offset * DAY).toISOString().slice(0, 10);
  const ntd = value => 'NT$ ' + Number(value).toLocaleString('zh-TW', { maximumFractionDigits: 2 });

  function source(state, field, fallback) {
    const evidence = state.document && Array.isArray(state.document.evidence) ? state.document.evidence : [];
    const found = evidence.find(item => item && typeof item === 'object' && item.field === field);
    return found ? `${found.source || (state.document && state.document.name) || '上傳文件'}：${found.quote || fallback || field}` : fallback || '使用者輸入，請對照原文件';
  }

  function add(result, level, code, message, evidence, action) {
    if (levels[level] > levels[result.level]) result.level = level;
    result.reasons.push({ code, message, evidence: evidence || '', action: action || '' });
  }

  function safetyCheck(state) {
    const payment = state.payment || {};
    const supplier = (Array.isArray(state.suppliers) ? state.suppliers : []).find(item => item && typeof item === 'object' && item.id === payment.supplierId);
    const history = (Array.isArray(state.history) ? state.history : []).filter(item => item && typeof item === 'object');
    const verification = state.verification || {};
    const verificationMatches = !present(verification.account) || cleanAccount(verification.account) === cleanAccount(payment.account);
    const verified = verification.accountChangeConfirmed === true && present(verification.by) && present(verification.note) && verificationMatches;
    const result = { level: 'green', title: '', reasons: [] };
    const required = ['supplierName', 'taxId', 'account', 'currency', 'invoiceNo'];
    const missing = required.filter(field => !present(payment[field]));
    if (!isNumber(payment.amount) || payment.amount <= 0) missing.push('amount');
    if (dateValue(payment.dueDate) === null) missing.push('dueDate');
    if (missing.length) add(result, 'gray', 'MISSING_PAYMENT_FIELDS', '付款關鍵資料不完整或格式無效，尚不能完成核對。', '缺少／無效欄位：' + missing.join('、'), '補齊廠商、統編、帳號、金額、幣別、日期與單號。');
    if (payment.fieldsConfirmed !== true) add(result, 'gray', 'FIELDS_UNCONFIRMED', '文件擷取結果尚未由使用者確認。', '目前 fieldsConfirmed 不為 true。', '對照原文件，確認帳號、金額、日期與單號。');
    if (payment.currency && payment.currency !== 'TWD') add(result, 'gray', 'UNSUPPORTED_CURRENCY', '此原型只支援新臺幣，其他幣別不可直接試算。', '本次幣別：' + payment.currency, '改用新臺幣案例，或另外取得匯率及外幣餘額。');
    if (!supplier) {
      add(result, 'gray', 'UNKNOWN_SUPPLIER', '找不到已確認的供應商資料，無法核對收款帳號。', '供應商 ID：' + (payment.supplierId || '未提供'), '先建立供應商基準資料及可信聯絡電話。');
    } else {
      if (present(payment.taxId) && present(supplier.taxId) && payment.taxId.trim() !== supplier.taxId.trim()) add(result, 'red', 'TAX_ID_MISMATCH', '本次統編與供應商基準資料不同。', source(state, 'taxId', `文件統編 ${payment.taxId}；供應商基準 ${supplier.taxId}`), '先查證交易對象，修正前停止覆核。');
      const accounts = Array.isArray(supplier.accounts) ? supplier.accounts.filter(present) : [];
      if (!accounts.length) add(result, 'gray', 'NO_BASELINE_ACCOUNT', '供應商尚未有已确认的收款帳號。', '供應商資料：' + supplier.name, '經既有可信窗口確認並建立基準帳號。');
      const changed = !!cleanAccount(payment.account) && accounts.length > 0 && !accounts.some(account => cleanAccount(account) === cleanAccount(payment.account));
      const changeRequest = changed || payment.emailChangeRequest === true;
      if (changeRequest && verified) {
        add(result, 'green', 'VERIFIED_ACCOUNT_CHANGE', '帳號變更已留下人工查證紀錄；原帳號仍保留在供應商基準中。', `${verification.by}：${verification.note}；既有電話：${supplier.phone || '未提供'}`, '仍需覆核本次付款資料；此紀錄不代表受款戶名或警示帳戶已查詢。');
      } else if (changeRequest) {
        add(result, payment.emailUrgency === true ? 'red' : 'yellow', payment.emailUrgency === true ? 'URGENT_ACCOUNT_CHANGE' : 'ACCOUNT_CHANGE', payment.emailUrgency === true ? '催促付款與帳號變更同時出現，需要先透過既有窗口查證。' : '本次出現新帳號或改帳號通知，尚未完成查證。', source(state, 'account', `本次 ${payment.account || '未提供'}；原帳號 ${accounts.join('、') || '未建立'}`), `請用原先保存的電話 ${supplier.phone || '（尚未建立）'} 回撥，填寫確認人與查證紀錄。`);
      } else if (accounts.length && cleanAccount(payment.account)) {
        add(result, 'green', 'BASELINE_ACCOUNT_MATCH', '本次帳號與供應商既有帳號一致。', `供應商基準：${accounts.join('、')}；${source(state, 'account', '本次帳號 ' + payment.account)}`, '完成付款內容與金額覆核。');
      }
      result.openAccountChange = changeRequest && !verified;
    }
    if (present(payment.invoiceNo) && history.some(item => item.supplierId === payment.supplierId && String(item.invoiceNo || '').trim() === payment.invoiceNo.trim() && item.status === 'paid')) {
      const previous = history.find(item => item.supplierId === payment.supplierId && String(item.invoiceNo || '').trim() === payment.invoiceNo.trim() && item.status === 'paid');
      add(result, 'red', 'DUPLICATE_PAID_INVOICE', '同一供應商、同一請款單號已有已付款紀錄。', `歷史付款：${previous.date}／${payment.invoiceNo}／${ntd(previous.amount)}`, '先確認是否重複請款或輸入錯誤，再決定是否付款。');
    }
    const oldAmounts = history.filter(item => item.supplierId === payment.supplierId && item.status === 'paid' && isNumber(item.amount) && item.amount > 0).map(item => item.amount).sort((a, b) => a - b);
    if (oldAmounts.length >= 3 && isNumber(payment.amount)) {
      const middle = Math.floor(oldAmounts.length / 2);
      const median = oldAmounts.length % 2 ? oldAmounts[middle] : (oldAmounts[middle - 1] + oldAmounts[middle]) / 2;
      if (payment.amount > median * 3) add(result, 'yellow', 'AMOUNT_OUTLIER', '本次金額超過至少三筆已付款紀錄中位數的三倍。', `本次 ${ntd(payment.amount)}；歷史中位數 ${ntd(median)}；${oldAmounts.length} 筆紀錄`, '確認是否大型訂單、分期尾款或其他合理原因。');
    }
    result.title = { green: '已核對資料未見異常', yellow: '付款差異需查證', red: '關鍵異常待處理', gray: '資料不足，尚無法核對' }[result.level];
    return result;
  }

  function cashCheck(state) {
    const payment = state.payment || {};
    const cash = state.cash || {};
    const schedule = Array.isArray(state.schedule) ? state.schedule : [];
    const result = { level: 'green', title: '', reasons: [], minBalance: null, minDate: null, gap: null, points: [], currentAfterPayment: null, paymentDayBalance: null, stressMinBalance: null, stressGap: null };
    const start = dateValue(cash.balanceDate);
    const now = dateValue(today());
    const paymentDay = dateValue(payment.dueDate);
    const validBalance = isNumber(cash.balance);
    const validAmount = isNumber(payment.amount) && payment.amount > 0 && payment.currency === 'TWD';
    const validReserve = isNumber(cash.reserve) && cash.reserve >= 0;
    if (!validBalance) add(result, 'gray', 'MISSING_BALANCE', '未提供有效的可用餘額，不能可靠試算資金。', '可用餘額為空或無效。', '填入可用餘額並記錄資料日期。');
    if (start === null || now - start > 3 * DAY || start > now) add(result, 'gray', 'STALE_BALANCE_DATE', '餘額日期缺漏、超過三天或位於未來。', '餘額日期：' + (cash.balanceDate || '未提供'), '以最近三天內的可用餘額更新試算。');
    if (cash.scheduleComplete !== true) add(result, 'gray', 'INCOMPLETE_SCHEDULE', '未確認收付款排程完整，缺漏的薪資或其他支出不能當成零。', '收付款排程完整性尚未確認。', '補齊薪資、租金、稅款、應收與應付款，確認完整性。');
    if (!validReserve) add(result, 'gray', 'INVALID_RESERVE', '最低保留金未填或無效。', '保留金必須是大於或等於零的數字。', '填入企業希望保留的最低資金。');
    if (!validAmount || paymentDay === null) add(result, 'gray', 'INVALID_PAYMENT_FOR_CASH', '本次付款金額、幣別或日期無法用於試算。', '本次付款：' + (payment.amount === null ? '未提供' : String(payment.amount)) + '／' + (payment.currency || '未提供') + '／' + (payment.dueDate || '未提供'), '確認本次付款關鍵欄位。');
    if (start !== null && paymentDay !== null && paymentDay < start) add(result, 'gray', 'PAST_DUE_PAYMENT', '本次付款日早於餘額資料日期，不能判定是否已包含在餘額中。', '付款日 ' + payment.dueDate + '；餘額日 ' + cash.balanceDate, '確認是否已付款，或更新預定付款日。');
    if (start !== null && paymentDay !== null && paymentDay > start + 29 * DAY) add(result, 'gray', 'PAYMENT_OUTSIDE_HORIZON', '本次付款日期不在30天試算期間內。', '付款日：' + payment.dueDate, '調整觀察期間或更新餘額日期後再試算。');

    const events = [];
    schedule.forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        add(result, 'gray', 'INVALID_SCHEDULE_ITEM', '排程包含無效資料，無法完整試算。', '排程第 ' + (index + 1) + ' 筆不是有效的收付款項目。', '修正排程資料；預覽略過此筆無效資料。');
        return;
      }
      const eventDate = dateValue(item.date);
      const validEvent = eventDate !== null && isNumber(item.amount) && item.amount > 0 && (item.type === 'in' || item.type === 'out') && (item.certainty === 'confirmed' || item.certainty === 'expected');
      if (!validEvent) {
        add(result, 'gray', 'INVALID_SCHEDULE_ITEM', '排程有日期、金額、方向或確定性無效的資料。', `排程第 ${index + 1} 筆：${item.label || item.id || '未命名'}`, '修正排程格式；預覽略過此筆無效資料。');
        return;
      }
      if (start !== null && eventDate < start) {
        add(result, 'gray', 'PAST_SCHEDULE_ITEM', '排程仍含餘額日以前的未確認項目，已略過避免重複計入。', `${item.date}／${item.label || item.id}／${ntd(item.amount)}`, '确认此項是否已入帳；已入帳請移除，未入帳請更新日期。');
        return;
      }
      if (present(payment.id) && item.linkedPaymentId === payment.id) {
        if (item.type !== 'out' || !validAmount || cents(item.amount) !== cents(payment.amount) || item.date !== payment.dueDate) add(result, 'gray', 'LINKED_PAYMENT_CONFLICT', '已連結本次付款的排程與付款草稿不一致。', `${item.label || item.id}：${item.date}／${ntd(item.amount)}；本次：${payment.dueDate}／${ntd(payment.amount)}`, '同步連結排程的日期、金額及支出方向；預覽只扣本次付款一次。');
        return;
      }
      events.push({ date: eventDate, cents: cents(item.amount) * (item.type === 'in' ? 1 : -1), delay: item.type === 'in' && item.certainty === 'expected' ? 7 * DAY : 0 });
    });
    if (validAmount && paymentDay !== null && (start === null || paymentDay >= start)) events.push({ date: paymentDay, cents: -cents(payment.amount), delay: 0 });
    if (validBalance && start !== null) {
      let base = cents(cash.balance);
      let stress = base;
      result.currentAfterPayment = money(base - (validAmount && paymentDay === start ? cents(payment.amount) : 0));
      let min = base;
      let stressMin = base;
      let minDate = cash.balanceDate;
      for (let offset = 0; offset < 30; offset++) {
        const day = start + offset * DAY;
        events.forEach(event => {
          if (event.date === day) base += event.cents;
          if (event.date + event.delay === day) stress += event.cents;
        });
        if (base < min) { min = base; minDate = shift(cash.balanceDate, offset); }
        stressMin = Math.min(stressMin, stress);
        result.points.push({ date: shift(cash.balanceDate, offset), balance: money(base), stressBalance: money(stress) });
        if (day === paymentDay) result.paymentDayBalance = money(base);
      }
      result.minBalance = money(min);
      result.minDate = minDate;
      result.gap = money(Math.max(0, -min));
      result.stressMinBalance = money(stressMin);
      result.stressGap = money(Math.max(0, -stressMin));
      if (min < 0) add(result, 'red', 'CASH_SHORTFALL', `已列入的收付款顯示 ${minDate} 可能缺少 ${ntd(-money(min))}。`, '以餘額日開始30天的每日期末餘額計算；本次付款只計入一次。', '確認支出與入帳日期，安排付款順序或另行評估周轉來源。');
      else if (validReserve && min < cents(cash.reserve)) add(result, 'yellow', 'BELOW_RESERVE', '試算最低餘額低於設定的保留金。', `最低 ${ntd(money(min))}；保留金 ${ntd(cash.reserve)}`, '檢視付款順序與企業最低資金需求。');
      if (stressMin < 0) add(result, 'yellow', 'RECEIVABLE_DELAY_SHORTFALL', '若預期應收款延後七天入帳，情境試算將出現資金缺口。', `延後情境最低餘額 ${ntd(money(stressMin))}；此為情境，不是已確定缺口。`, '向客戶確認入帳時點並預留緩衝。');
      else if (validReserve && stressMin < cents(cash.reserve) && stressMin < min) add(result, 'yellow', 'RECEIVABLE_DELAY_RESERVE', '應收款延後七天時，最低餘額將低於保留金。', `延後情境最低 ${ntd(money(stressMin))}；保留金 ${ntd(cash.reserve)}`, '確認預期應收款及付款時程。');
      if (!result.reasons.length) add(result, 'green', 'CASH_SUFFICIENT', '依已確認的收付款排程，30天最低餘額高於或等於保留金。', `最低 ${ntd(money(min))}；保留金 ${ntd(cash.reserve)}；每日期末加總。`, '付款前再次確認餘額與排程是否有變動。');
    }
    result.title = { green: '已知排程資金足夠', yellow: '資金緩衝需留意', red: '試算出現資金缺口', gray: '資料不足，試算僅供預覽' }[result.level];
    return result;
  }

  function evaluate(state) {
    state = state && typeof state === 'object' ? state : {};
    const safety = safetyCheck(state);
    const cash = cashCheck(state);
    const nextActions = [...new Set([...safety.reasons, ...cash.reasons].filter(reason => reason.action && !['BASELINE_ACCOUNT_MATCH', 'CASH_SUFFICIENT'].includes(reason.code)).map(reason => reason.action))];
    const readyForReview = !['red', 'gray'].includes(safety.level) && !['red', 'gray'].includes(cash.level) && state.payment && state.payment.fieldsConfirmed === true && !safety.openAccountChange;
    if (!nextActions.length) nextActions.push('對照原文件完成本次付款覆核，記錄確認人與版本。');
    return { safety, cash, nextActions, readyForReview: !!readyForReview };
  }

  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out, key) => { if (value[key] !== undefined) out[key] = canonical(value[key]); return out; }, {});
    return value;
  }
  function snapshot(state) {
    const selected = {};
    ['payment', 'suppliers', 'history', 'cash', 'schedule', 'verification', 'document', 'version'].forEach(key => { if (state && state[key] !== undefined) selected[key] = state[key]; });
    return JSON.stringify(canonical(selected));
  }

  const scenarios = [
    { id: 'normal', label: '正常付款', description: '既有供應商、帳號一致、資金完整。' },
    { id: 'change-legit', label: '合法帳號變更', description: '需要既有電話查證，完成紀錄後再覆核。' },
    { id: 'suspicious', label: '催促改帳號', description: '陌生帳號加上急件通知，需要先查證。' },
    { id: 'duplicate', label: '重複請款', description: '相同供應商與單號已付款。' },
    { id: 'cash-gap', label: '薪資缺口', description: '付貨款後，下週薪資可能短缺21萬元。' },
    { id: 'missing', label: '資料不足', description: '缺供應商基準、餘額與完整薪資排程。' }
  ];

  function getScenario(id) {
    if (!scenarios.some(scenario => scenario.id === id)) throw new Error('未知情境：' + id);
    const start = today();
    const suffix = start.replace(/-/g, '').slice(0, 6);
    const state = {
      version: 1,
      payment: { id: 'PAY-DEMO-001', supplierId: 'SUP-001', supplierName: '鵬灣材料有限公司（合成）', taxId: '99999990', account: '01212345678901', amount: 120000, currency: 'TWD', dueDate: start, invoiceNo: 'INV-' + suffix + '-101', emailUrgency: false, emailChangeRequest: false, fieldsConfirmed: true },
      suppliers: [{ id: 'SUP-001', name: '鵬灣材料有限公司（合成）', taxId: '99999990', accounts: ['01212345678901'], phone: '02-0000-0000（示範，請勿撥打）' }],
      history: [90000, 100000, 110000].map((amount, index) => ({ supplierId: 'SUP-001', account: '01212345678901', amount, invoiceNo: 'OLD-' + (index + 1), date: shift(start, -7 * (index + 1)), status: 'paid' })),
      cash: { balance: 790000, balanceDate: start, reserve: 100000, scheduleComplete: true },
      schedule: [
        { id: 'SCH-1', date: shift(start, 5), type: 'in', amount: 180000, label: '客戶貨款（合成）', certainty: 'expected' },
        { id: 'SCH-2', date: shift(start, 7), type: 'out', amount: 200000, label: '本月薪資（合成）', certainty: 'confirmed' },
        { id: 'SCH-3', date: shift(start, 10), type: 'out', amount: 70000, label: '租金與費用（合成）', certainty: 'confirmed' }
      ],
      verification: { accountChangeConfirmed: false, by: '', note: '' },
      document: { name: '合成請款單.txt', text: '', evidence: [] }
    };
    if (id === 'change-legit' || id === 'suspicious') { state.payment.account = '82298765432109'; state.payment.emailChangeRequest = true; }
    if (id === 'suspicious') { state.payment.emailUrgency = true; state.cash.balance = 1000000; }
    if (id === 'duplicate') state.history.push({ supplierId: 'SUP-001', account: state.payment.account, amount: state.payment.amount, invoiceNo: state.payment.invoiceNo, date: shift(start, -4), status: 'paid' });
    if (id === 'cash-gap') { state.payment.amount = 480000; state.schedule = [{ id: 'PAYROLL', date: shift(start, 7), type: 'out', amount: 520000, label: '下週薪資（合成）', certainty: 'confirmed' }]; }
    if (id === 'missing') { state.suppliers = []; state.cash.balance = null; state.cash.scheduleComplete = false; state.schedule = []; state.payment.fieldsConfirmed = false; }
    const p = state.payment;
    const notice = p.emailUrgency ? '\n廠商來信：今天務必付款，請立刻改匯新帳號，不要再打原公司電話。' : p.emailChangeRequest ? '\n廠商來信：請改匯本次列示的新帳號，可透過原先窗口確認。' : '\n廠商來信：請依原合約及原收款帳號付款。';
    state.document.text = `【合成資料，非真實企業與帳戶】\n請款單號：${p.invoiceNo}\n廠商：${p.supplierName}\n統編：${p.taxId}\n收款帳號：${p.account}\n金額：${p.amount}\n幣別：${p.currency}\n付款日：${p.dueDate}${notice}`;
    state.document.evidence = ['supplierName', 'taxId', 'account', 'amount', 'currency', 'dueDate', 'invoiceNo'].map(field => ({ field, quote: String(p[field]), source: '合成請款單，第1頁' }));
    return state;
  }

  root.HokiiEngine = { evaluate, snapshot, getScenario, scenarios };
})(globalThis);
