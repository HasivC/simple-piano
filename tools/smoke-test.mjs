/**
 * 开发用冒烟测试（不参与运行）：
 *   1. 用 mock AudioContext 跑通 audio.js 的全部音色，检查有没有运行时异常；
 *   2. 交叉校验 app.js 里用到的 #id 是否都存在于 index.html。
 *
 *   node tools/smoke-test.mjs
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

/* ---------------- mock Web Audio ---------------- */
function param() {
  const p = { value: 0 };
  ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime',
   'setTargetAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime',
   'setValueCurveAtTime'].forEach(k => {
    p[k] = function (v) {
      if (v !== undefined && typeof v !== 'number') throw new Error(k + ' 收到非数字参数');
      if (typeof v === 'number' && !isFinite(v)) throw new Error(k + ' 收到 ' + v);
      return p;
    };
  });
  return p;
}
function node(extra) {
  return Object.assign({
    connect() { return this; },
    disconnect() {},
    start(t) { if (t !== undefined && !isFinite(t)) throw new Error('start 时间非法'); },
    stop(t) { if (t !== undefined && !isFinite(t)) throw new Error('stop 时间非法'); }
  }, extra);
}
const created = { osc: 0, gain: 0, filter: 0 };

class MockCtx {
  constructor() {
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.state = 'running';
    this.destination = node();
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  createGain() { created.gain++; return node({ gain: param() }); }
  createOscillator() {
    created.osc++;
    return node({ type: 'sine', frequency: param(), detune: param() });
  }
  createBiquadFilter() {
    created.filter++;
    return node({ type: 'lowpass', frequency: param(), Q: param(), gain: param() });
  }
  createConvolver() { return node({ buffer: null, normalize: true }); }
  createDynamicsCompressor() {
    return node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() });
  }
  createBufferSource() { return node({ buffer: null, loop: false, playbackRate: param() }); }
  createBuffer(ch, len, rate) {
    const data = [];
    for (let i = 0; i < ch; i++) data.push(new Float32Array(len));
    return { numberOfChannels: ch, length: len, sampleRate: rate, getChannelData: i => data[i] };
  }
}

/* ---------------- 1. 引擎冒烟 ---------------- */
console.log('audio.js 引擎冒烟测试');
const sandbox = { window: { AudioContext: MockCtx }, console, setTimeout, clearTimeout };
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(read('audio.js'), sandbox, { filename: 'audio.js' });
const Sky = sandbox.window.PianoAudio;

if (!Sky) bad('PianoAudio 未挂载');
else ok('PianoAudio 已挂载，音色数 = ' + Sky.presets.length);

Sky.setVolume(0.8);
Sky.setReverb(1);

const midis = [24, 36, 48, 60, 69, 84, 96, 108];
Sky.presets.forEach((p, i) => {
  try {
    const before = created.osc;
    midis.forEach(m => {
      const v = Sky.play(m, 0.9, null, i);
      v.release();
    });
    // 排程回放路径（未来时间）
    const v2 = Sky.play(60, 0.7, Sky.now() + 5, i);
    v2.release(Sky.now() + 5.5);
    v2.stop();
    if (created.osc === before) throw new Error('没有创建任何振荡器');
    ok('音色 ' + (i + 1) + ' ' + p.name + ' 正常');
  } catch (e) {
    bad('音色 ' + p.name + ' 抛错: ' + e.message);
  }
});

try {
  Sky.stopAll();
  ok('stopAll 正常');
} catch (e) { bad('stopAll 抛错: ' + e.message); }

/* 非法输入不应崩溃 */
try {
  Sky.play(60, 0, null, 999);
  Sky.play(127, 1.5, null, -5);
  ok('越界参数被安全处理');
} catch (e) { bad('越界参数抛错: ' + e.message); }

/* ---------------- 2. DOM 选择器交叉校验 ---------------- */
console.log('\nDOM 选择器交叉校验');
const html = read('index.html');
const app = read('app.js');

const htmlIds = new Set();
html.replace(/id="([^"]+)"/g, (m, id) => { htmlIds.add(id); return m; });

const usedIds = new Set();
app.replace(/\$\$?\('#([A-Za-z0-9_-]+)/g, (m, id) => { usedIds.add(id); return m; });

const missing = [...usedIds].filter(id => !htmlIds.has(id));
if (missing.length) bad('app.js 引用了 index.html 中不存在的 id: ' + missing.join(', '));
else ok('app.js 引用的 ' + usedIds.size + ' 个 id 全部存在');

/* data-v 取值校验 */
const expect = {
  optCols: ['5', '7'],
  optScale: ['major', 'minor', 'penta', 'chromatic'],
  optOct: ['1', '2', '3', '4', '5'],
  optPages: ['1', '2', '3', '4']
};
Object.keys(expect).forEach(id => {
  const re = new RegExp('id="' + id + '"[\\s\\S]*?</div>');
  const block = (html.match(re) || [''])[0];
  const vals = [...block.matchAll(/data-v="([^"]+)"/g)].map(m => m[1]);
  const same = vals.length === expect[id].length && vals.every((v, i) => v === expect[id][i]);
  if (same) ok(id + ' 选项完整 -> ' + vals.join(','));
  else bad(id + ' 选项不符，期望 ' + expect[id].join(',') + ' 实得 ' + vals.join(','));
});

/* 音色面板 grid 是否被定义 */
if (/\.preset-grid\s*{/.test(read('styles.css'))) ok('styles.css 含 .preset-grid');
else bad('styles.css 缺少 .preset-grid');

/* 关键 CSS 变量/类是否齐全 */
['.key', '.key.on', '.row', '.board', '.sheet', '.dot.active', '.toast'].forEach(sel => {
  const re = new RegExp('\\' + sel.replace('.', '.') + '\\s*[{,]');
  if (re.test(read('styles.css'))) ok('styles.css 含 ' + sel);
  else bad('styles.css 缺少 ' + sel);
});

console.log('\n' + (failures ? '失败 ' + failures + ' 项' : '全部通过'));
process.exit(failures ? 1 : 0);
