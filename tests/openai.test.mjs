import test from 'node:test';
import assert from 'node:assert/strict';
import { extractInvoice, prepareInput, validateExtraction } from '../lib/openai.mjs';

const sample = {supplierId:null,supplierName:'測試紙箱',taxId:'01234567',account:'001234567890',amount:120000,currency:'TWD',dueDate:'2026-10-14',invoiceNo:'AB12345678',emailUrgency:true,emailChangeRequest:true,evidence:[{field:'account',quote:'帳號001234567890',source:'測試.txt'}]};

test('缺金鑰清楚報錯，不冒充已完成AI辨識', async () => {
  await assert.rejects(extractInvoice({text:'請款'}, {apiKey:''}), error => error.status === 503);
});
test('禁止遠端URL及偽裝PDF、超長文字與不支援格式', () => {
  assert.throws(() => prepareInput({file:{name:'x.pdf',type:'application/pdf',data:'https://example.test/a.pdf'}}));
  assert.throws(() => prepareInput({file:{name:'x.pdf',type:'application/pdf',data:'data:application/pdf;base64,YWJj'}}));
  assert.throws(() => prepareInput({text:'a'.repeat(60001)}));
  assert.throws(() => prepareInput({file:{name:'x.exe',type:'application/octet-stream',data:'data:application/octet-stream;base64,YWJj'}}));
});
test('Responses請求使用服務端金鑰、strict schema、store=false且保留帳號前導零', async () => {
  let sent;
  const result = await extractInvoice({text:'帳號001234567890'}, {apiKey:'fake-unit-test-key',fetchFn:async (url, options) => {
    sent = {url,options,body:JSON.parse(options.body)};
    return {ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(sample)}]}]})};
  }});
  assert.equal(sent.url, 'https://api.openai.com/v1/responses');
  assert.equal(sent.body.store, false);
  assert.equal(sent.body.text.format.strict, true);
  assert.equal(result.data.account,'001234567890');
  assert.equal(result.verified,false);
  assert.equal(sent.options.headers.Authorization,'Bearer fake-unit-test-key');
});
test('拒絕把帳號數字、負金額及不完整輸出當成有效辨識', async () => {
  assert.throws(()=>validateExtraction({...sample,account:123}));
  assert.throws(()=>validateExtraction({...sample,amount:-3}));
  await assert.rejects(extractInvoice({text:'x'}, {apiKey:'fake',fetchFn:async()=>({ok:true,json:async()=>({status:'incomplete'})})}));
});
test('上游額度或拒絕處理有明確錯誤，不回傳敏感內容', async () => {
  await assert.rejects(extractInvoice({text:'x'}, {apiKey:'fake',fetchFn:async()=>({ok:false,status:429,json:async()=>({error:{message:'private upstream message'}})})}),error=>error.message.includes('額度') && !error.message.includes('private'));
  await assert.rejects(extractInvoice({text:'x'}, {apiKey:'fake',fetchFn:async()=>({ok:true,json:async()=>({output:[{content:[{type:'refusal',refusal:'no'}]}]})})}),error=>error.status===422);
});
test('非boolean通知與缺漏原文依據必須報502，不能靜默轉成安全資料', () => {
  for (const overrides of [
    { emailUrgency: 'true' }, { emailChangeRequest: null }, { evidence: null },
    { evidence: [null] }, { evidence: [{ field: 'account', quote: 123, source: 'x' }] },
    { evidence: [{ field: 'account', quote: '帳號' }] }
  ]) assert.throws(() => validateExtraction({ ...sample, ...overrides }), error => error.status === 502);
});
test('完整辨識可保留未知欄位null，但依然未被人工驗證', () => {
  const result = validateExtraction({ ...sample, supplierId: null, dueDate: null, amount: null, evidence: [] });
  assert.equal(result.supplierId, null);
  assert.equal(result.dueDate, null);
  assert.equal(result.amount, null);
});
