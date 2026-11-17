const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '../extensi', name), 'utf8').replace(/\r\n/g, '\n');
const content = source('content.js');
const section = (start, end) => {
  const a = content.indexOf(start), b = content.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Missing source section ${start}`);
  return content.slice(a, b);
};
const noop = () => {};
function context(extra) { return vm.createContext({ console, setTimeout, clearTimeout, logDebugEvent: noop, ...extra }); }
async function capture(activeId, duringCapture = noop) {
  let listener, activated, removed = false, captures = 0;
  const c = context({ importScripts: noop, chrome: {
    runtime: { id: 'test', onInstalled: { addListener: noop }, onMessage: { addListener: f => listener = f } },
    contextMenus: { onClicked: { addListener: noop } },
    tabs: {
      onActivated: { addListener: f => activated = f, removeListener: () => removed = true },
      query: async () => [{ id: activeId, url: 'https://quiz.invalid' }],
      captureVisibleTab: async () => { captures++; duringCapture(activated); return 'data:image/png;base64,test'; }
    }
  }});
  vm.runInContext(source('background.js'), c);
  const response = await new Promise(resolve => listener({ action: 'captureVisibleTab' }, { tab: { id: 1, windowId: 5 } }, resolve));
  assert.equal(removed, true);
  return { response, captures };
}
test('screenshot refuses a background requester', async () => {
  const { response, captures } = await capture(2);
  assert.equal(response.success, false); assert.equal(captures, 0); assert.equal(response.dataUrl, undefined);
});
test('screenshot discards switch-away-and-back during capture', async () => {
  const { response } = await capture(1, emit => { emit({ windowId: 5, tabId: 2 }); emit({ windowId: 5, tabId: 1 }); });
  assert.equal(response.success, false); assert.equal(response.dataUrl, undefined);
});
test('screenshot accepts stable requesting tab', async () => {
  const { response } = await capture(1);
  assert.equal(response.success, true); assert.equal(response.tabId, 1);
});
test('update checker uses saved baseUrl without DOM or localStorage', async () => {
  let fetched, badge;
  const c = context({ chrome: {
    runtime: { getManifest: () => ({ version: '1.3' }) },
    storage: { local: { get: (keys, cb) => cb({ baseUrl: 'https://server.invalid/', apiKey: 'dummy' }) } },
    action: { setBadgeText: v => badge = v.text }
  }, fetch: async url => { fetched = url; return { ok: true, json: async () => ({ version: '1.4' }) }; }});
  c.self = c; vm.runInContext(source('shared/update-check.js'), c);
  await c.KamusMiniUpdate.run();
  assert.equal(fetched, 'https://server.invalid/api/v1/extension/latest'); assert.equal(badge, '!');
  assert.equal((await c.KamusMiniUpdate.check('https://server.invalid', 'dummy')).serverUrl, 'https://server.invalid');
});
test('popup update check waits for DOM when script is loaded in head', async () => {
  let ready, fetched = 0;
  const c = context({ document: { readyState: 'loading', addEventListener: (name, cb) => ready = cb, getElementById: () => ({}) }, chrome: {
    runtime: { getManifest: () => ({ version: '1.3' }) }, storage: { local: { get: (keys, cb) => cb({ apiKey: 'dummy' }) } }, action: { setBadgeText: noop }
  }, fetch: async () => { fetched++; return { ok: false }; }});
  c.self = c; vm.runInContext(source('shared/update-check.js'), c);
  assert.equal(fetched, 0); ready(); await new Promise(setImmediate); assert.equal(fetched, 1);
});
test('running-state broadcast starts only owner tab and stops previous owner', async () => {
  const contexts = [];
  for (let tabId = 1; tabId <= 2; tabId++) {
    let cb, starts = 0, stateWrites = [];
    const c = context({ chrome: { runtime: { sendMessage: (msg, done) => done({ tabId }) }, storage: { local: { get: (keys, done) => done({ agentState: { tabId: 1, status: 'running' } }), set: patch => stateWrites.push(patch) }, onChanged: { addListener: f => cb = f } } }, isManagedByTopFrame: () => false, getQuizDocument: () => ({ querySelector: () => ({}) }), logAgentActivity: noop, startAgentLoop: () => starts++ });
    vm.runInContext(section('// Agent state belongs', 'function resolveQuizDocAndScope'), c);
    vm.runInContext(section('chrome.storage.onChanged.addListener(async', '// ---- KEYDOWN AUTO-SEARCH'), c);
    await cb({ agentState: { newValue: { tabId: 1, status: 'running' } } }, 'local');
    assert.equal(starts, tabId === 1 ? 1 : 0);
    vm.runInContext("setAgentState({agentState:{status:'completed'}})", c);
    assert.equal(stateWrites[0].agentState.tabId, tabId);
    contexts.push({ c, cb });
  }
  await contexts[0].cb({ agentState: { newValue: { tabId: 2, status: 'running' } } }, 'local');
  assert.equal(vm.runInContext('isAgentRunning', contexts[0].c), false);
});
function aiContext(stop) {
  let applied = 0;
  const c = context({ isAgentRunning: true, detectQuizInputType: () => 'choice', extractExpectedMultiChoiceCount: () => 0, checkForImageTags: () => false, buildQuestionFingerprint: () => '', logAgentActivity: noop, logDebugEvent: noop, buildDirectAiPrompts: () => ({}), mergeCapturedDebugPreview: noop, parseAiResponse: () => ({ choice: 'A' }), callConfiguredAiApi: async () => { stop(c); return { rawReply: 'dummy' }; }, applyAnswerToQuizDom: async () => { applied++; return { success: true }; } });
  vm.runInContext(section('async function solveWithDirectAI(', '// TWO-LEVEL NESTED FALLBACK'), c);
  return { c, applied: () => applied };
}
test('late AI response cannot apply after Stop or after a new run starts', async () => {
  for (const restart of [false, true]) {
    let generation = 1;
    const { c, applied } = aiContext(c => { c.isAgentRunning = false; generation++; if (restart) c.isAgentRunning = true; });
    await c.solveWithDirectAI('1', 'Question', [], { aiApiKey: 'dummy', ocrEnabled: false }, { querySelector: () => null }, { shouldContinue: () => c.isAgentRunning && generation === 1 });
    assert.equal(applied(), 0);
  }
});
test('Stop interrupts gradual typing', async () => {
  let running = true, writes = 0;
  const c = context({}); vm.runInContext(section('async function typeTextGradually(', '/**\n * Type answer'), c);
  await c.typeTextGradually('A long answer that requires multiple chunks', () => { writes++; running = false; }, () => running);
  assert.equal(writes, 1);
});
test('failed question stays unsolved and stops before navigation in full auto', async () => {
  const doc = { querySelector: () => ({}) }; let toast, nav = 0, state;
  const c = context({ isAgentRunning: true, isSolvingActive: false, agentGeneration: 1, isExtensionValid: () => true, isManagedByTopFrame: () => false, getQuizDocument: () => doc, handleProactiveCaptchaCheck: () => false, getPageQuestions: () => [{}], solvedQuestionKeys: new Set(), getQuestionIdentityFromElement: () => ({ qNum: '1', questionKey: 'q1' }), getCurrentQuestionIdentity: () => ({ questionKey: 'q1' }), showToast: (title, msg) => toast = msg, solveQuestionFlow: async () => ({ success: false }), clearPendingAgentTimer: noop, setAgentState: patch => state = patch.agentState, attachNextButtonSniffer: noop, findQuizNavigationTarget: () => { nav++; }, chrome: { storage: { local: { get: (keys, cb) => cb({ navigationMode: 'full_auto' }) } } }, logAgentActivity: noop });
  vm.runInContext(section('async function startAgentLoop()', '// ACTIVE HEARTBEAT'), c); await c.startAgentLoop();
  assert.equal(c.solvedQuestionKeys.has('q1'), false); assert.equal(c.isAgentRunning, false); assert.equal(nav, 0); assert.match(toast, /Gagal/); assert.equal(state.status, 'idle');
});
test('successful question is marked solved', async () => {
  const doc = { querySelector: () => ({}) }; let toast;
  const c = context({ isAgentRunning: true, isSolvingActive: false, agentGeneration: 1, isExtensionValid: () => true, isManagedByTopFrame: () => false, getQuizDocument: () => doc, handleProactiveCaptchaCheck: () => false, getPageQuestions: () => [{}], solvedQuestionKeys: new Set(), getQuestionIdentityFromElement: () => ({ qNum: '1', questionKey: 'q1' }), getCurrentQuestionIdentity: () => ({ questionKey: 'q1' }), showToast: (title, msg) => toast = msg, solveQuestionFlow: async () => ({ success: true }), attachNextButtonSniffer: noop, chrome: { storage: { local: { get: (keys, cb) => cb({ navigationMode: 'semi_auto' }) } } }, logAgentActivity: noop });
  vm.runInContext(section('async function startAgentLoop()', '// ACTIVE HEARTBEAT'), c); await c.startAgentLoop();
  assert.equal(c.solvedQuestionKeys.has('q1'), true); assert.match(toast, /Dipilih/);
});

test('answer application refuses cancelled cloud or direct run before reading DOM', async () => {
  const c = context({ isAgentRunning: false });
  vm.runInContext(section('async function applyAnswerToQuizDom(', '// ---- HELPER: CONVERT BLOB'), c);
  assert.equal((await c.applyAnswerToQuizDom({choice: 'A'}, 0.6, null, () => false)).success, false);
  assert.equal((await c.applyAnswerToQuizDom({answer: 'Answer'})).success, false);
});
test('startup ignores legacy and foreign-tab states but restores owned state', async () => {
  let stored = { status: 'running' };
  const c = context({ chrome: { runtime: { sendMessage: (msg, cb) => cb({tabId: 1}) }, storage: { local: { get: (keys, cb) => cb({agentState: stored}) } } } });
  vm.runInContext(section('// Agent state belongs', '// ---- GLOBAL AGENT STATE'), c);
  const read = () => new Promise(resolve => c.getAgentState(resolve));
  assert.equal((await read()).agentState.status, undefined);
  stored = { tabId: 2, status: 'running' };
  assert.equal((await read()).agentState.status, undefined);
  stored = { tabId: 1, status: 'running' };
  assert.equal((await read()).agentState.status, 'running');
});

function choiceContext({ disabled = false, cancelled = false, type = 'radio' } = {}) {
  const input = { type, disabled, isConnected: true, checked: false, matches: () => disabled, click() { if (!disabled && !cancelled) this.checked = true; }, dispatchEvent: noop };
  const row = { querySelector: selector => selector.includes('input') ? input : null, closest: () => null, parentElement: null, setAttribute: noop, style: {} };
  const doc = { querySelectorAll: () => [row] };
  const c = context({ Event, document: doc, isAgentRunning: true, getQuizDocument: () => doc, getOptionLetterForElement: () => 'A', uncheckCheckboxRow: noop });
  vm.runInContext(section('function clickInputOption(', 'function escapeHtmlForEditor('), c);
  vm.runInContext(section('function selectOptionByLetter(', 'async function applyAnswerToQuizDom('), c);
  vm.runInContext(section('function selectOptionsByLetters(', '// Cabut centang'), c);
  return { c, input, row, doc };
}
test('choice selector reports failure for disabled or cancelled click', () => {
  for (const opts of [{disabled: true}, {cancelled: true}]) {
    const {c, input, doc} = choiceContext(opts);
    assert.equal(c.selectOptionByLetter('A', doc).success, false);
    assert.equal(input.checked, false);
  }
});
test('choice selector reports success only after checked state changes', () => {
  const {c, input, doc} = choiceContext();
  assert.equal(c.selectOptionByLetter('A', doc).success, true);
  assert.equal(input.checked, true);
});
test('checkbox selection does not count failed clicks or missing choices', () => {
  const {c, doc} = choiceContext({type: 'checkbox', cancelled: true});
  assert.equal(c.selectOptionsByLetters(['A'], doc).count, 0);
  assert.equal(c.selectOptionsByLetters(['A'], doc).success, false);
  const valid = choiceContext({type: 'checkbox'});
  assert.equal(valid.c.selectOptionsByLetters(['A', 'B'], valid.doc).success, false);
});

function imageSolverContext({ questionType = 'choice', failVision = false, failCapture = false } = {}) {
  const calls = [], applied = [], stats = { cacheReads: 0, ocrCalls: 0, captures: 0 };
  const scope = { querySelector: selector => selector.includes('checkbox') && questionType === 'choice' ? {} : null };
  const c = context({ console: { ...console, warn: noop },
    isAgentRunning: true, detectQuizInputType: () => questionType, extractExpectedMultiChoiceCount: () => 2,
    checkForImageTags: () => true, buildQuestionFingerprint: () => 'fingerprint',
    logAgentActivity: noop, mergeCapturedDebugPreview: noop, saveCapturedDebugPreview: noop,
    getOcrCache: async () => { stats.cacheReads++; return { cleanMarkdown: 'OCR question', diagramImages: [], stats: {} }; },
    KamusMiniOcr: { runPaddleOcr: async () => { stats.ocrCalls++; throw new Error('unexpected OCR call'); } },
    captureFormulationElement: async () => { stats.captures++; return failCapture ? null : { type: 'image/png', size: 100 }; },
    extractContentImagesFallback: async () => null,
    blobToBase64: async () => 'a'.repeat(100),
    callConfiguredAiApi: async args => { calls.push(args); if (failVision) throw new Error('Vision rejected'); return {rawReply: '{}', model: 'test', durationMs: 15000}; },
    parseAiResponse: () => questionType === 'essay' ? {answer: 'Essay answer', choice: ''} : {choice: 'A, C', answer: 'Two choices'},
    applyAnswerToQuizDom: async (answer, threshold, doc) => { applied.push({answer, doc}); return {success: true}; }
  });
  vm.runInContext(section('function formatMultiAnswerRule(', '// QUESTION FINGERPRINT'), c);
  vm.runInContext(section('async function solveWithDirectAI(', '// TWO-LEVEL NESTED FALLBACK'), c);
  return {c, scope, calls, applied, stats};
}
test('default speed mode sends image directly and skips OCR including cached OCR', async () => {
  for (const questionType of ['choice', 'essay']) {
    const {c, scope, calls, applied, stats} = imageSolverContext({questionType});
    const result = await c.solveWithDirectAI('2', 'Question', ['A. One', 'B. Two', 'C. Three'], {aiProvider: 'custom', aiCustomModel: 'test', ocrEnabled: true, paddleOcrToken: 'dummy'}, scope);
    assert.equal(result.success, true); assert.equal(stats.cacheReads, 0); assert.equal(stats.ocrCalls, 0); assert.equal(stats.captures, 1);
    assert.equal(calls.length, 1); assert.equal(calls[0].images.length, 1); assert.equal(calls[0].images[0].base64.length, 100);
    assert.equal(applied[0].doc, scope);
    assert.match(calls[0].userPrompt, questionType === 'essay' ? /essay/ : /CHECKBOX/);
  }
});
test('OCR-first mode still uses cached OCR', async () => {
  const {c, scope, calls, stats} = imageSolverContext();
  const result = await c.solveWithDirectAI('1', 'Question', ['A. One'], {imageProcessingMode: 'ocr_first', aiProvider: 'custom', ocrEnabled: true, paddleOcrToken: 'dummy'}, scope);
  assert.equal(result.success, true); assert.equal(stats.cacheReads, 1); assert.equal(stats.captures, 0); assert.equal(calls[0].images.length, 0);
  assert.match(calls[0].userPrompt, /OCR question/);
});
test('speed mode does not retry without image or silently fall back to OCR', async () => {
  for (const flags of [{failVision: true}, {failCapture: true}]) {
    const {c, scope, calls, applied, stats} = imageSolverContext(flags);
    const result = await c.solveWithDirectAI('1', 'Question', ['A. One'], {aiProvider: 'custom', ocrEnabled: true, paddleOcrToken: 'dummy'}, scope);
    assert.equal(result.success, false); assert.equal(applied.length, 0); assert.equal(stats.ocrCalls, 0); assert.equal(calls.length, flags.failVision ? 1 : 0);
  }
});
test('text-only provider keeps OCR path even when speed is selected', async () => {
  const {c, scope, stats} = imageSolverContext();
  const result = await c.solveWithDirectAI('1', 'Question', ['A. One'], {imageProcessingMode: 'vision_first', aiProvider: 'groq', aiApiKey: 'dummy', ocrEnabled: true, paddleOcrToken: 'dummy'}, scope);
  assert.equal(result.success, true); assert.equal(stats.cacheReads, 1); assert.equal(stats.captures, 0);
});

function cloudSolverContext(response = { res: {ok: true}, body: {choice: 'A, C', answer: 'Two answers', imageProcessingMode: 'vision_first', timings: {ocrMs: 0, databaseMs: 0, aiMs: 15, totalMs: 20}} }) {
  const requests = [], applications = [], scopes = [], logs = [];
  let directCalls = 0;
  const c = context({
    console: {...console, error: noop}, isAgentRunning: true,
    chrome: {storage: {local: {get: (keys, cb) => cb({selectedModelId: 'chosen-model'})}}},
    detectQuizInputType: scope => scope.kind,
    scrapeQuestionText: () => 'Choose two', scrapeOptionsText: () => ['A. One', 'B. Two', 'C. Three'], extractExpectedMultiChoiceCount: () => 2,
    captureFormulationElement: async scope => { scopes.push(scope); return {type: 'image/png'}; },
    KamusMiniCloud: {searchAnswerImage: async (key, args) => {requests.push(args); return response}},
    applyAnswerToQuizDom: async (answer, threshold, scope, shouldContinue) => { if (!shouldContinue()) return {success:false}; applications.push({answer, scope}); return {success: true}; },
    logAgentActivity: msg => logs.push(msg), logDebugEvent: noop,
    solveWithDirectAI: async () => {directCalls++; return {success:true}},
  });
  vm.runInContext(section('async function executeFallback2(', '// ---- QUIZ NAVIGATION HELPERS'), c);
  const scope = {kind:'choice', querySelector: () => ({})};
  const run = (config = {}, target = scope) => c.executeFallback2('2','https://server.invalid','dummy',0.7,target,{config, questionText:'Choose two',options:['A. One','B. Two','C. Three'],shouldContinue:()=>c.isAgentRunning});
  return {c, run, scope, requests, applications, scopes, logs, directCalls:()=>directCalls};
}
test('Cloud speed payload includes model, image, options and question type for each isolated scope', async () => {
  const f = cloudSolverContext();
  for (const kind of ['choice','essay']) {
    const target = {kind, querySelector: () => kind === 'choice' ? {} : null};
    const result = await f.run({imageProcessingMode:'vision_first'},target);
    assert.equal(result.success,true); assert.equal(result.mode,'Cloud AI Vision');
    const req = f.requests.at(-1);
    assert.equal(req.imageProcessingMode,'vision_first'); assert.equal(req.questionType,kind); assert.equal(req.modelId,'chosen-model');
    assert.equal(req.options.length,3); assert.equal(req.isMultiChoice,kind==='choice');
    assert.equal(f.applications.at(-1).scope,target); assert.equal(f.scopes.at(-1),target);
  }
});
test('Cloud speed never falls back to Direct AI or OCR on error or old-server response', async () => {
  for (const response of [
    {res:{ok:false},body:{reasonCode:'VISION_UNSUPPORTED',message:'Select a Vision model'}},
    {res:{ok:true},body:{answer:'Old backend ignored mode'}},
  ]) {
    const f = cloudSolverContext(response); const result = await f.run({aiProvider:'custom',aiApiKey:'configured'});
    assert.equal(result.success,false); assert.equal(f.requests.length,1); assert.equal(f.applications.length,0); assert.equal(f.directCalls(),0);
    assert.ok(result.error);
  }
});
test('Cloud OCR-first toggle sends legacy processing mode', async () => {
  const f=cloudSolverContext({res:{ok:true},body:{answer:'One',choice:'A',imageProcessingMode:'ocr_first'}});
  const result=await f.run({imageProcessingMode:'ocr_first'});
  assert.equal(f.requests[0].imageProcessingMode,'ocr_first'); assert.equal(result.mode,'Cloud Math OCR');
});
test('Cloud client serializes the mode and question context into multipart fields', async () => {
  const c=context({FormData,Blob}); c.self=c;
  vm.runInContext(source('ai-cloud-client.js'),c);
  let fd;
  await c.KamusMiniCloud.searchAnswerImage('dummy',{imageBlob:new Blob(['image']),modelId:'model',imageProcessingMode:'vision_first',questionText:'Question',options:['A. One'],questionType:'essay',isMultiChoice:false},async (url,init)=>{fd=init.body;return {ok:true,status:200,json:async()=>({answer:'Answer'})}});
  assert.equal(fd.get('imageProcessingMode'),'vision_first'); assert.equal(fd.get('questionType'),'essay');
  assert.deepEqual(JSON.parse(fd.get('options')),['A. One']); assert.equal(fd.get('isMultiChoice'),'false');
});


test('question summaries have stable attempts, bounded retention and complete checkbox context', async () => {
  const state = {}; const session = new Map();
  const c = context({ self: {}, crypto: require('node:crypto').webcrypto, sessionStorage: { getItem: k => session.get(k), setItem: (k,v) => session.set(k,v) }, chrome: { runtime: {}, storage: { local: { get: (_keys,cb) => cb(structuredClone(state)), set: (patch,cb) => { Object.assign(state,patch); cb(); } } } } });
  vm.runInContext(source('question-logs.js'),c);
  const logs = c.self.KamusQuestionLogs;
  let firstSession;
  for (let i=0;i<55;i++) { logs.begin(i,`scope-${i}`); const ctx=logs.context('choice',true,2); firstSession ||= ctx.sessionId; assert.equal(ctx.sessionId,firstSession); assert.equal(ctx.isMultiChoice,true); logs.event('AI','INFO','Resolved'); logs.answer({answer:'One and Three',choice:'A, C'}); logs.finish({success:true,mode:'Cloud AI Vision'},1500); }
  await new Promise(resolve => setTimeout(resolve,25));
  assert.equal(state.questionSummaries.length,50); assert.equal(state.questionSummaries[0].qNum,5);
  assert.equal(new Set(state.questionSummaries.map(r=>r.attemptId)).size,50);
  assert.ok(state.questionSummaries.every(r=>r.answer==='One and Three' && r.choice==='A, C' && r.status==='success' && r.totalDurationMs===1500));
  session.set('kamusCloudLastActivity',String(Date.now()-31*60000)); logs.begin(56,'scope-56'); assert.notEqual(logs.context('essay',false,0).sessionId,firstSession);
});


test('background log writer serializes frames and bounds previews and stage data', async () => {
 const state={}; const c=context({chrome:{runtime:{},storage:{local:{get:(_k,cb)=>setTimeout(()=>cb(structuredClone(state)),1),set:(patch,cb)=>setTimeout(()=>{Object.assign(state,patch);cb()},1)}}}});
 vm.runInContext(source('shared/question-log-store.js'),c);
 const store=c.KamusQuestionLogStore;
 await Promise.all(Array.from({length:60},(_,i)=>store.write({identity:{id:'frame-'+i,qNum:i},patch:{answer:'x'.repeat(20000)},event:{message:'Done',data:{large:'x'.repeat(10000)}}})));
 assert.equal(state.questionSummaries.length,50); assert.equal(state.questionSummaries[0].id,'frame-10'); assert.equal(state.questionSummaries[0].answer.length,12000); assert.equal(state.questionSummaries[0].stages[0].data.truncated,true);
 await Promise.all(Array.from({length:7},(_,i)=>store.write({identity:{id:'preview-'+i},preview:'data:image/jpeg;base64,AAAA'})));
 assert.equal(state.questionPreviews.length,5);
 await store.write({identity:{id:'oversize'},preview:'data:image/jpeg;base64,'+'A'.repeat(200*1024)}); assert.equal(state.questionPreviews.length,5); assert.ok(!state.questionPreviews.some(p=>p.id==='oversize'));
});
