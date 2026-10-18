/**
 * 开发用端到端测试（不参与运行）：
 * 用一个极简 DOM 仿真 + mock AudioContext，把 index.html / audio.js / app.js
 * 真正跑起来，检查启动、触键、和弦、刮奏、翻页、换布局、录音回放等路径。
 *
 *   node tools/dom-sim.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let failures = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failures++; console.log('  ✗ ' + m); };
const assert = (cond, msg) => cond ? ok(msg) : bad(msg);

/* ================= mock Web Audio ================= */
function param(name) {
  const p = { value: 0 };
  ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime',
   'setTargetAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime'].forEach(k => {
    p[k] = v => {
      if (typeof v === 'number' && !isFinite(v)) throw new Error(name + '.' + k + ' 参数非法: ' + v);
      return p;
    };
  });
  return p;
}
const node = extra => Object.assign({
  connect() { return this; }, disconnect() {},
  start(t) { if (t !== undefined && !isFinite(t)) throw new Error('start 时间非法'); },
  stop(t) { if (t !== undefined && !isFinite(t)) throw new Error('stop 时间非法'); }
}, extra);
let oscCount = 0;
class MockCtx {
  constructor() { this.sampleRate = 48000; this.currentTime = 0; this.state = 'running'; this.destination = node(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  createGain() { return node({ gain: param('gain') }); }
  createOscillator() { oscCount++; return node({ type: 'sine', frequency: param('freq'), detune: param('detune') }); }
  createBiquadFilter() { return node({ type: 'lowpass', frequency: param('filter.freq'), Q: param('Q'), gain: param('filter.gain') }); }
  createConvolver() { return node({ buffer: null }); }
  createDynamicsCompressor() {
    return node({ threshold: param('t'), knee: param('k'), ratio: param('r'), attack: param('a'), release: param('rel') });
  }
  createBufferSource() { return node({ buffer: null, loop: false }); }
  createBuffer(ch, len, rate) {
    const d = []; for (let i = 0; i < ch; i++) d.push(new Float32Array(len));
    return { length: len, sampleRate: rate, getChannelData: i => d[i] };
  }
}

/* ================= 极简 DOM ================= */
const VOID = new Set(['meta', 'link', 'input', 'br', 'img', 'hr']);
const camel = s => s.replace(/-([a-z])/g, (m, c) => c.toUpperCase());

function makeEl(tag) {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    childNodes: [],
    parentNode: null,
    attrs: {},
    dataset: {},
    style: { setProperty(k, v) { this[k] = v; } },
    _handlers: {},
    _text: '',
    _html: ''
  };
  el.classList = {
    _list: () => el.className.split(/\s+/).filter(Boolean),
    contains(c) { return this._list().indexOf(c) >= 0; },
    add() { const l = this._list(); for (const c of arguments) if (l.indexOf(c) < 0) l.push(c); el.className = l.join(' '); },
    remove() { let l = this._list(); for (const c of arguments) l = l.filter(x => x !== c); el.className = l.join(' '); },
    toggle(c, force) {
      const on = force === undefined ? !this.contains(c) : !!force;
      if (on) this.add(c); else this.remove(c);
      return on;
    }
  };
  Object.defineProperty(el, 'children', { get: () => el.childNodes.filter(n => n.nodeType === 1) });
  Object.defineProperty(el, 'parentElement', { get: () => (el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null) });
  Object.defineProperty(el, 'textContent', {
    get: () => el._text,
    set(v) { el._text = String(v); el.childNodes = []; }
  });
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html,
    set(v) { el._html = String(v); el.childNodes = []; }
  });
  el.appendChild = c => { c.parentNode = el; el.childNodes.push(c); return c; };
  el.removeChild = c => { el.childNodes = el.childNodes.filter(x => x !== c); return c; };
  el.setAttribute = (k, v) => { el.attrs[k] = String(v); if (k === 'id') el.id = String(v); };
  el.getAttribute = k => (k in el.attrs ? el.attrs[k] : null);
  el.addEventListener = (t, h) => { (el._handlers[t] = el._handlers[t] || []).push(h); };
  el.removeEventListener = (t, h) => { el._handlers[t] = (el._handlers[t] || []).filter(x => x !== h); };
  el.getBoundingClientRect = () => ({ top: 100, left: 0, right: 60, bottom: 160, width: 60, height: 60 });
  el.querySelectorAll = sel => findAll(el, sel);
  el.querySelector = sel => findAll(el, sel)[0] || null;
  el.closest = sel => { let n = el; while (n) { if (n.nodeType === 1 && matches(n, sel)) return n; n = n.parentNode; } return null; };
  el.matches = sel => matches(el, sel);
  el.contains = other => { let n = other; while (n) { if (n === el) return true; n = n.parentNode; } return false; };
  el.clientWidth = 0;
  el.clientHeight = 0;
  return el;
}

function descendants(rootEl) {
  const out = [];
  (function walk(n) { n.childNodes.forEach(c => { if (c.nodeType === 1) { out.push(c); walk(c); } }); })(rootEl);
  return out;
}
function matches(el, part) {
  if (!el || el.nodeType !== 1) return false;
  const re = /([.#]?[\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let m, any = false, good = true;
  while ((m = re.exec(part))) {
    any = true;
    if (m[2]) {
      const key = camel(m[2].replace(/^data-/, ''));
      const v = (key in el.dataset) ? el.dataset[key] : el.attrs[m[2]];
      if (m[3] === undefined) { if (v == null) good = false; }
      else if (String(v) !== m[3]) good = false;
    } else {
      const tok = m[1];
      if (tok[0] === '#') { if (el.id !== tok.slice(1)) good = false; }
      else if (tok[0] === '.') { if (!el.classList.contains(tok.slice(1))) good = false; }
      else if (el.tagName !== tok.toUpperCase()) good = false;
    }
  }
  return any && good;
}
function matchChain(el, parts) {
  let i = parts.length - 1;
  if (!matches(el, parts[i])) return false;
  i--;
  while (i >= 0) {
    let p = el.parentNode, found = false;
    while (p) { if (p.nodeType === 1 && matches(p, parts[i])) { found = true; break; } p = p.parentNode; }
    if (!found) return false;
    el = p; i--;
  }
  return true;
}
function findAll(rootEl, sel) {
  const parts = sel.trim().split(/\s+/);
  return descendants(rootEl).filter(el => matchChain(el, parts));
}
function parseHTML(html) {
  const rootEl = makeEl('html-root');
  const stack = [rootEl];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].slice(0, 4) === '<!--') continue;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
      }
      continue;
    }
    const el = makeEl(tag);
    const ar = /([\w:-]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = ar.exec(m[3] || ''))) {
      const k = a[1], v = a[2] === undefined ? '' : a[2];
      el.attrs[k] = v;
      if (k === 'id') el.id = v;
      else if (k === 'class') el.className = v;
      else if (k.indexOf('data-') === 0) el.dataset[camel(k.slice(5))] = v;
    }
    stack[stack.length - 1].appendChild(el);
    if (!(m[4] === '/') && !VOID.has(tag)) stack.push(el);
  }
  return rootEl;
}

/* ================= 组装沙箱 ================= */
const htmlRoot = parseHTML(read('index.html'));
const bodyEl = findAll(htmlRoot, 'body')[0] || htmlRoot;

const documentEl = makeEl('document');
documentEl.readyState = 'complete';
documentEl.hidden = false;
documentEl._point = null;
documentEl.elementFromPoint = () => documentEl._point;
documentEl.documentElement = htmlRoot;
bodyEl.children.forEach(c => documentEl.appendChild(c));
documentEl.querySelector = sel => findAll(documentEl, sel)[0] || null;
documentEl.querySelectorAll = sel => findAll(documentEl, sel);
documentEl.createElement = tag => makeEl(tag);
documentEl.addEventListener = (t, h) => { (documentEl._handlers[t] = documentEl._handlers[t] || []).push(h); };

const winHandlers = {};
function fireWindow(type, ev) {
  (winHandlers[type] || []).forEach(h => h(Object.assign({ type, preventDefault() {}, target: bodyEl }, ev)));
}
function fire(el, type, ev) {
  (el._handlers[type] || []).forEach(h => h(Object.assign({
    type, target: el, preventDefault() {}, stopPropagation() {}
  }, ev)));
}
function fireBubble(el, type, ev) {
  let n = el;
  while (n) {
    (n._handlers[type] || []).forEach(h => h(Object.assign({
      type, target: el, preventDefault() {}, stopPropagation() {}
    }, ev)));
    n = n.parentNode;
  }
}

const store = {};
const g = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => Date.now() },
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  },
  navigator: {},
  location: { protocol: 'file:', href: 'file:///index.html' },
  document: documentEl,
  ResizeObserver: class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} },
  AudioContext: MockCtx,
  /* 视口尺寸：竖屏 390×844，横屏时翻转（琴键尺寸只认短边，所以必须模拟它） */
  innerWidth: 390,
  innerHeight: 844,
  requestAnimationFrame: cb => setTimeout(cb, 16),
  addEventListener(t, h) { (winHandlers[t] = winHandlers[t] || []).push(h); },
  removeEventListener(t, h) { winHandlers[t] = (winHandlers[t] || []).filter(x => x !== h); }
};
g.window = g;
g.self = g;
g.globalThis = g;

/* 先把 #board 的可视尺寸准备好（模拟 390×844 手机） */
const boardEl = documentEl.querySelector('#board');
boardEl.clientWidth = 390;
boardEl.clientHeight = 520;

vm.createContext(g);

console.log('启动（DOM 仿真 / 390×520 键位区）');
try {
  vm.runInContext(read('audio.js'), g, { filename: 'audio.js' });
  vm.runInContext(read('app.js'), g, { filename: 'app.js' });
  ok('audio.js + app.js 执行无异常');
} catch (e) {
  bad('启动抛错: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | '));
  process.exit(1);
}

const rows = () => boardEl.children;
const allKeys = () => descendants(boardEl).filter(el => el.classList.contains('key'));
const keyByIndex = i => boardEl.querySelector('.key[data-index="' + i + '"]');
/* 从行的内联样式里解出键的宽/高 */
const keySize = () => ({
  w: parseFloat(/repeat\(\d+,\s*([\d.]+)px\)/.exec(rows()[0].style.gridTemplateColumns)[1]),
  h: parseFloat(rows()[0].style.height)
});

/* ---------- 结构与音域 ---------- */
console.log('\n键位结构');
assert(rows().length === 3, '3 行键位');
assert(rows()[0].children.length === 5, '每行 5 键');
assert(allKeys().length === 15, '共 15 键');
assert(rows().every(r => !r.style.transform), '三行完全对齐，不再是错位的平行四边形');
const ksPortrait = keySize();
assert(ksPortrait.w > 0 && ksPortrait.h > 0,
  '键尺寸已算出 = ' + ksPortrait.w.toFixed(1) + ' × ' + ksPortrait.h.toFixed(1));
assert(Math.abs(ksPortrait.w - ksPortrait.h) < 0.5,
  '键还是原来的正方形（去掉错位不改变键的形状）');
const blockH = rows().length * ksPortrait.h + (rows().length - 1) * parseFloat(boardEl.style['--gap']);
const blockW = parseFloat(rows()[0].style.width);
assert(blockH <= 520 - 8, '三行总高 ' + blockH.toFixed(1) + ' ≤ 键位区高度');
assert(blockW <= 390 - 8, '整排宽 ' + blockW.toFixed(1) + ' ≤ 键位区宽度');

/* 最低音键在左下角（data-index=0），DOM 里排最后一行 */
assert(Number(keyByIndex(0).dataset.midi) === 48, '左下角 = C3 (48)，实际 ' + keyByIndex(0).dataset.midi);
assert(Number(keyByIndex(14).dataset.midi) === 72, '右上角 = C5 (72)，实际 ' + keyByIndex(14).dataset.midi);
assert(keyByIndex(0).closest('.row').dataset.row === '0', '最低音所在行 = 第 0 行（底部）');

/* ---------- 触键 ---------- */
console.log('\n触键与发声');
let before = oscCount;
fireBubble(keyByIndex(0), 'pointerdown', { pointerId: 1, clientX: 30, clientY: 130 });
assert(oscCount > before, '按下琴键创建了振荡器');
assert(keyByIndex(0).classList.contains('on'), '按下的键高亮');
fireWindow('pointerup', { pointerId: 1 });
assert(!keyByIndex(0).classList.contains('on'), '抬手后高亮消失');

console.log('\n多指和弦');
before = oscCount;
const chord = [3, 7, 11].map(keyByIndex);
chord.forEach((k, i) => fireBubble(k, 'pointerdown', { pointerId: 20 + i }));
assert(oscCount - before >= 6, '三指同时按下各自发声');
assert(chord.every(k => k.classList.contains('on')), '三个键同时高亮');
[0, 1, 2].forEach(i => fireWindow('pointerup', { pointerId: 20 + i }));
assert(chord.every(k => !k.classList.contains('on')), '和弦抬手全部收音');

/* ---------- 刮奏 ---------- */
console.log('\n刮奏（滑过琴键）');
fireBubble(keyByIndex(0), 'pointerdown', { pointerId: 9 });
documentEl._point = keyByIndex(1);
fireWindow('pointermove', { pointerId: 9, clientX: 70, clientY: 130 });
assert(keyByIndex(1).classList.contains('on') && !keyByIndex(0).classList.contains('on'), '滑到相邻键自动切换发声');
documentEl._point = null;
fireWindow('pointermove', { pointerId: 9, clientX: 200, clientY: 400 });
assert(!keyByIndex(1).classList.contains('on'), '滑出琴键后收音');
fireWindow('pointerup', { pointerId: 9 });

/* ---------- 延音 ---------- */
console.log('\n延音踏板');
const susBtn = documentEl.querySelector('#btnSustain');
fire(susBtn, 'click');
assert(susBtn.classList.contains('active'), '延音点亮');
fireBubble(keyByIndex(5), 'pointerdown', { pointerId: 11 });
fireWindow('pointerup', { pointerId: 11 });
assert(!keyByIndex(5).classList.contains('on'), '延音下抬手视觉仍恢复（声音延续）');
fire(susBtn, 'click');
assert(!susBtn.classList.contains('active'), '再次点击关闭延音');

/* ---------- 翻页 ---------- */
console.log('\n翻页与音域');
const p0 = Number(keyByIndex(0).dataset.midi);
fire(documentEl.querySelector('#btnNext'), 'click');
const p1 = Number(keyByIndex(0).dataset.midi);
assert(p1 === p0 + 12, '下一页正好升高一个八度 (' + p0 + ' -> ' + p1 + ')');
assert(Number(keyByIndex(14).dataset.midi) === 84, '第 2 页音域 = C4–C6');
fire(documentEl.querySelector('#btnPrev'), 'click');
assert(Number(keyByIndex(0).dataset.midi) === p0, '上一页回到原音域');
assert(documentEl.querySelectorAll('#dots .dot').length === 3, '3 个页点');
assert(documentEl.querySelectorAll('#dots .dot.active').length === 1, '恰有 1 个页点高亮');

/* ---------- 电脑键盘 ---------- */
console.log('\n电脑键盘映射');
before = oscCount;
fireWindow('keydown', { key: 'q', repeat: false });
assert(oscCount > before, '按 Q 触发发声');
assert(keyByIndex(10).classList.contains('on'), 'Q = 顶行第一键 (index 10)');
fireWindow('keyup', { key: 'q' });
assert(keyByIndex(0).classList.contains('on') === false, '抬起 Q 后收音');
fireWindow('keydown', { key: '.', repeat: false });
assert(Number(keyByIndex(0).dataset.midi) === p1, '按 . 翻到下一页');
fireWindow('keydown', { key: ',', repeat: false });
assert(Number(keyByIndex(0).dataset.midi) === p0, '按 , 翻回上一页');

/* ---------- 3×7 ---------- */
console.log('\n切换到 3×7');
fire(documentEl.querySelectorAll('#optCols button').find(b => b.dataset.v === '7'), 'click');
assert(rows().length === 3 && rows()[0].children.length === 7, '变为 3 行 × 7 键');
assert(allKeys().length === 21, '共 21 键');
assert(Number(keyByIndex(20).dataset.midi) > 72, '3×7 单页音域更宽（最高 ' + keyByIndex(20).dataset.midi + '）');
fire(documentEl.querySelectorAll('#optCols button').find(b => b.dataset.v === '5'), 'click');
assert(rows()[0].children.length === 5, '切回 3×5');

/* ---------- 音阶 / 八度 / 页数 ---------- */
console.log('\n音阶 / 八度 / 页数');
fire(documentEl.querySelectorAll('#optScale button').find(b => b.dataset.v === 'chromatic'), 'click');
assert(Number(keyByIndex(1).dataset.midi) === 49, '半音阶第二键 = C#3 (49)，实际 ' + keyByIndex(1).dataset.midi);
fire(documentEl.querySelectorAll('#optScale button').find(b => b.dataset.v === 'major'), 'click');
fire(documentEl.querySelectorAll('#optOct button').find(b => b.dataset.v === '4'), 'click');
assert(Number(keyByIndex(0).dataset.midi) === 60, '起始八度 C4 (60)');
fire(documentEl.querySelectorAll('#optOct button').find(b => b.dataset.v === '3'), 'click');
fire(documentEl.querySelectorAll('#optPages button').find(b => b.dataset.v === '4'), 'click');
assert(documentEl.querySelectorAll('#dots .dot').length === 4, '页数改为 4');
fire(documentEl.querySelectorAll('#optPages button').find(b => b.dataset.v === '3'), 'click');

/* ---------- 音色 ---------- */
console.log('\n音色');
const presets = documentEl.querySelectorAll('.preset');
assert(presets.length === 14, '音色按钮 14 个（已删掉星河琴）');
fire(presets[5], 'click');
assert(presets[5].classList.contains('active'), '选中的音色高亮');
assert(documentEl.querySelector('#presetChip').textContent.indexOf('钟琴') >= 0, '顶部音色标签同步');
fire(presets[0], 'click');
assert(documentEl.querySelector('#presetChip').textContent === '大钢琴', '默认音色是大钢琴');

/* ---------- 音名 ---------- */
console.log('\n显示音名');
fire(documentEl.querySelector('#btnNames'), 'click');
assert(keyByIndex(0).querySelector('.lbl').textContent === 'C3', '首键标注 C3');
fire(documentEl.querySelector('#btnNames'), 'click');
assert(keyByIndex(0).querySelector('.lbl').textContent === '', '关闭后清空标注');

/* ---------- 录音回放 ---------- */
console.log('\n录音与回放');
fire(documentEl.querySelector('#btnRec'), 'click');
fireBubble(keyByIndex(0), 'pointerdown', { pointerId: 31 });
fireWindow('pointerup', { pointerId: 31 });
fireBubble(keyByIndex(4), 'pointerdown', { pointerId: 32 });
fireWindow('pointerup', { pointerId: 32 });
fire(documentEl.querySelector('#btnRec'), 'click');
assert(documentEl.querySelector('#recInfo').textContent.indexOf('2 个音') >= 0,
  '录音信息：' + documentEl.querySelector('#recInfo').textContent);
assert(documentEl.querySelector('#btnPlay').style.display !== 'none', '播放按钮出现');
before = oscCount;
try {
  fire(documentEl.querySelector('#btnPlay'), 'click');
  ok('回放调度无异常（新建 ' + (oscCount - before) + ' 个振荡器）');
} catch (e) { bad('回放抛错: ' + e.message); }
assert(oscCount > before, '回放确实发声');
fire(documentEl.querySelector('#btnPlay'), 'click');           /* 停止 */
fire(documentEl.querySelector('#recLoop'), 'click');
assert(documentEl.querySelector('#recLoop').classList.contains('active'), '循环开关生效');
fire(documentEl.querySelector('#recClear'), 'click');
assert(documentEl.querySelector('#recInfo').textContent.indexOf('还没有录音') >= 0, '清空录音');
fire(documentEl.querySelector('#recLoop'), 'click');

/* ---------- 面板 ---------- */
console.log('\n底部面板');
fire(documentEl.querySelector('#presetChip'), 'click');
assert(documentEl.querySelector('#sheet').classList.contains('open'), '点音色标签打开面板');
assert(documentEl.querySelector('.pane[data-pane="timbre"]').classList.contains('active'), '默认切到音色页');
fire(documentEl.querySelectorAll('.tabs button')[2], 'click');
assert(documentEl.querySelector('.pane[data-pane="play"]').classList.contains('active'), '切到演奏页');
fire(documentEl.querySelector('#backdrop'), 'click');
assert(!documentEl.querySelector('#sheet').classList.contains('open'), '点遮罩关闭面板');

/* ---------- 横屏布局：键尺寸必须与竖屏完全一致 ---------- */
console.log('\n横屏布局（视口翻成 844×390，键位区 844×330）');
g.innerWidth = 844;
g.innerHeight = 390;
boardEl.clientWidth = 844;
boardEl.clientHeight = 330;
fireWindow('resize', {});
const ksLand = keySize();
const gapL = parseFloat(boardEl.style['--gap']);
assert(Math.abs(ksLand.w - ksLand.h) < 0.5,
  '横屏下键仍是正方形（' + ksLand.w.toFixed(1) + '×' + ksLand.h.toFixed(1) + '）');
const totalH = 3 * ksLand.h + 2 * gapL;
assert(totalH <= 330 - 8, '三行总高 ' + totalH.toFixed(1) + 'px ≤ 330px，未溢出');
const totalW = 5 * ksLand.w + 4 * gapL;
assert(totalW <= 844 - 8, '整排宽 ' + totalW.toFixed(1) + 'px ≤ 844px，未溢出');
assert(rows().every(r => !r.style.transform), '横屏下三行依然对齐');

/* 3×7 只是列数变化 */
fire(documentEl.querySelectorAll('#optCols button').find(b => b.dataset.v === '7'), 'click');
const ls7 = keySize();
const totalW7 = 7 * ls7.w + 6 * parseFloat(boardEl.style['--gap']);
assert(rows()[0].children.length === 7 && allKeys().length === 21, '横屏 3×7 共 21 键');
assert(totalW7 <= 844 - 8, '横屏 3×7 也放得下（宽 ' + totalW7.toFixed(0) + 'px）');
fire(documentEl.querySelectorAll('#optCols button').find(b => b.dataset.v === '5'), 'click');

g.innerWidth = 390;
g.innerHeight = 844;
boardEl.clientWidth = 390;
boardEl.clientHeight = 520;
fireWindow('resize', {});
const ps = keySize();
assert(ps.w === ksPortrait.w && ps.h === ksPortrait.h, '转回竖屏尺寸与初始一致');

/* 小屏（320×480）要等比缩小，但键形不变、不溢出 */
g.innerWidth = 320;
g.innerHeight = 480;
boardEl.clientWidth = 320;
boardEl.clientHeight = 300;
fireWindow('resize', {});
const small = keySize();
assert(Math.abs(small.w - small.h) < 0.5,
  '小屏下键仍是正方形（' + small.w.toFixed(1) + '×' + small.h.toFixed(1) + '）');
assert(5 * small.w + 4 * parseFloat(boardEl.style['--gap']) <= 320 - 8, '小屏下不溢出宽度');
g.innerWidth = 390;
g.innerHeight = 844;
boardEl.clientWidth = 390;
boardEl.clientHeight = 520;
fireWindow('resize', {});

/* ---------- 持久化 ---------- */
console.log('\n持久化');
documentEl.hidden = true;
(documentEl._handlers['visibilitychange'] || []).forEach(h => h({ type: 'visibilitychange', target: documentEl }));
assert(!!store['piano.settings.v1'], '页面隐藏时设置立即落盘');
const saved = JSON.parse(store['piano.settings.v1'] || '{}');
assert(saved.cols === 5 && saved.rows === 3, '保存的布局正确 (' + saved.cols + '×' + saved.rows + ')');
assert(saved.preset === 0, '保存的音色正确');
assert(!!store['piano.recording.v1'], '录音已写入 localStorage');

console.log('\n' + (failures ? '失败 ' + failures + ' 项' : '全部通过'));
process.exit(failures ? 1 : 0);
