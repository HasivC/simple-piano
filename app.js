/*!
 * PIANO —— 界面与演奏交互
 * 3×N 矩形键矩阵 / 分页扩展音域 / 多点触控 / 刮奏 / 录音回放
 */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);

  /* ================= 音阶与音高 ================= */

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const nameOf = m => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

  const SCALES = {
    major: { label: '自然大调', steps: [0, 2, 4, 5, 7, 9, 11] },
    minor: { label: '自然小调', steps: [0, 2, 3, 5, 7, 8, 10] },
    penta: { label: '五声音阶', steps: [0, 2, 4, 7, 9] },
    chromatic: { label: '半音阶（全音域）', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }
  };

  const DEFAULTS = {
    preset: 0,
    cols: 5, rows: 3,
    scale: 'major',
    baseOct: 3,
    pages: 3,
    page: 0,
    sustain: false,
    velocity: false,
    names: false,
    highlight: true,
    vibrate: true,
    volume: 0.8,
    reverb: 1.0
  };
  const S = Object.assign({}, DEFAULTS);

  const SKEY = 'piano.settings.v1';
  const RKEY = 'piano.recording.v1';

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SKEY);
      if (raw) Object.assign(S, JSON.parse(raw));
    } catch (e) {}
    S.cols = (S.cols === 7 || S.cols === 5) ? S.cols : 5;
    S.rows = 3;
    S.pages = clamp(S.pages | 0, 1, 4);
    S.page = clamp(S.page | 0, 0, S.pages - 1);
    S.baseOct = clamp(S.baseOct | 0, 1, 5);
    S.preset = clamp(S.preset | 0, 0, PianoAudio.presets.length - 1);
  }
  /* 设置写入做防抖（拖动滑杆时避免频繁写盘），但页面隐藏/关闭时立即落盘 */
  let saveTimer = 0;
  let savePending = false;
  function flushSave() {
    if (!savePending) return;
    savePending = false;
    clearTimeout(saveTimer);
    try { localStorage.setItem(SKEY, JSON.stringify(S)); } catch (e) {}
  }
  function saveSettings() {
    savePending = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 200);
  }

  const pageSize = () => S.rows * S.cols;
  const pageCount = () => S.pages;

  /* 第 page 页第 i 个键对应的 MIDI 音高。
     翻页时整体升高一个八度（音阶内即 n 个音级），所以每页形状一致、都从主音起，
     相邻页自然重叠，最高不超过钢琴音域。 */
  function noteAt(page, i) {
    const scale = SCALES[S.scale] || SCALES.major;
    const steps = scale.steps;
    const n = steps.length;
    const abs = page * n + i;
    const oct = Math.floor(abs / n);
    const deg = ((abs % n) + n) % n;
    return (S.baseOct + 1) * 12 + oct * 12 + steps[deg];
  }

  function rangeText() {
    return nameOf(noteAt(0, 0)) + ' – ' + nameOf(noteAt(S.pages - 1, pageSize() - 1));
  }

  /* ================= DOM ================= */

  const board = $('#board');
  const stage = $('.stage');
  const dotsEl = $('#dots');
  const sheet = $('#sheet');
  const backdrop = $('#backdrop');
  const toastEl = $('#toast');
  const hintEl = $('#hint');
  const presetChip = $('#presetChip');
  const rangeHint = $('#rangeHint');
  const recInfo = $('#recInfo');

  /* ================= 录音数据 ================= */
  let R = { events: [], dur: 0 };
  let recOn = false;
  let recStart = 0;
  let recId = 0;

  function loadRecording() {
    try {
      const raw = localStorage.getItem(RKEY);
      if (raw) {
        const o = JSON.parse(raw);
        if (o && Array.isArray(o.events)) R = { events: o.events, dur: o.dur || 0 };
      }
    } catch (e) {}
  }
  function saveRecording() {
    try { localStorage.setItem(RKEY, JSON.stringify(R)); } catch (e) {}
  }

  /* ================= 键盘构建 ================= */
  let layouts = [];

  function buildBoard() {
    board.innerHTML = '';
    board.classList.toggle('show-names', !!S.names);
    const rows = S.rows, cols = S.cols;

    for (let r = rows - 1; r >= 0; r--) {
      const rowEl = document.createElement('div');
      rowEl.className = 'row';
      rowEl.dataset.row = String(r);
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const midi = noteAt(S.page, i);
        const key = document.createElement('div');
        key.className = 'key';
        key.dataset.midi = String(midi);
        key.dataset.index = String(i);
        if (S.highlight && midi % 12 === 0) key.classList.add('root');
        const lbl = document.createElement('span');
        lbl.className = 'lbl';
        lbl.textContent = S.names ? nameOf(midi) : '';
        key.appendChild(lbl);
        rowEl.appendChild(key);
      }
      board.appendChild(rowEl);
    }
    layout();
  }

  /* 计算键位尺寸：同时满足宽度与高度约束。
     唯一的改动是三行不再错位，所以宽度约束里不再需要为错位预留那半格。 */
  function layout() {
    const rows = S.rows, cols = S.cols;
    const bw = board.clientWidth, bh = board.clientHeight;
    if (!bw || !bh) return;
    const rowEls = $$('.row', board);
    let gap = 10, cell = 40;
    for (let it = 0; it < 4; it++) {
      const availW = bw - 12 - (cols - 1) * gap;
      const availH = bh - 10 - (rows - 1) * gap;
      const next = Math.min(availW / cols, availH / rows);
      cell = clamp(next, 22, 260);
      gap = clamp(cell * .14, 5, 16);
    }
    const rowW = cols * cell + (cols - 1) * gap;
    board.style.gap = gap + 'px';
    board.style.setProperty('--gap', gap + 'px');
    board.style.setProperty('--cell', cell + 'px');
    rowEls.forEach(function (el) {
      el.style.width = rowW + 'px';
      el.style.height = cell + 'px';
      el.style.gridTemplateColumns = 'repeat(' + cols + ', ' + cell + 'px)';
      el.style.transform = '';   /* 三行对齐，不做半格错位 */
    });
  }

  /* ================= 发声与触控 ================= */

  const pointers = new Map();   /* pointerId -> {el, voice, ...} */
  const active = new Set();     /* 当前按下的 pointerId（含按在键间空隙上的） */
  const sustained = new Set();  /* 延音踏板下仍在响的音 */
  let swipe = null;             /* 翻页手势 */

  function velOf(el, e) {
    if (!S.velocity || !e || e.clientY == null) return .85;
    const rect = el.getBoundingClientRect();
    if (!rect.height) return .85;
    const t = clamp((e.clientY - rect.top) / rect.height, 0, 1);
    return .38 + .62 * t;
  }

  function startVoice(id, el, e) {
    const prev = pointers.get(id);
    if (prev) {
      if (prev.el === el) return;
      endVoice(id, true);
    }
    if (!el) return;
    PianoAudio.resume();

    const midi = parseInt(el.dataset.midi, 10);
    const vel = velOf(el, e);
    const voice = PianoAudio.play(midi, vel, null, S.preset);
    el.classList.add('on');

    const st = { el: el, voice: voice, midi: midi, vel: vel, evId: 0, t: 0 };
    if (recOn) {
      st.evId = ++recId;
      st.t = performance.now() / 1000 - recStart;
      R.events.push({ id: st.evId, t: st.t, midi: midi, vel: vel, dur: 0, p: S.preset });
    }
    pointers.set(id, st);
    if (S.vibrate && navigator.vibrate) { try { navigator.vibrate(6); } catch (err) {} }
  }

  function endVoice(id, useSustain) {
    const st = pointers.get(id);
    if (!st) return;
    pointers.delete(id);
    st.el.classList.remove('on');

    if (useSustain && S.sustain) {
      sustained.add(st.voice);
    } else if (st.voice) {
      st.voice.release();
    }

    if (recOn && st.evId) {
      for (let i = R.events.length - 1; i >= 0; i--) {
        if (R.events[i].id === st.evId) {
          R.events[i].dur = Math.max(.08, performance.now() / 1000 - recStart - st.t);
          break;
        }
      }
    }
  }

  function releaseSustained() {
    sustained.forEach(function (v) { if (v) v.release(); });
    sustained.clear();
  }

  function releaseEverything() {
    Array.from(pointers.keys()).forEach(function (id) { endVoice(id, false); });
    releaseSustained();
    active.clear();
  }

  /* 整个琴键舞台都可按下：按在键上立刻发声，按在空隙上再滑到键上也能发声 */
  stage.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    hideHint();
    active.add(e.pointerId);
    const el = e.target.closest ? e.target.closest('.key') : null;
    if (el) startVoice(e.pointerId, el, e);
  });

  window.addEventListener('pointermove', function (e) {
    if (!active.has(e.pointerId)) return;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const key = under && under.closest ? under.closest('.key') : null;
    const cur = pointers.get(e.pointerId);
    if (key) {
      if (!cur || cur.el !== key) {
        startVoice(e.pointerId, key, e);
        swipe = null;   /* 已经在刮奏，取消翻页手势 */
      }
    } else if (cur) {
      endVoice(e.pointerId, true);   /* 手指滑出琴键 -> 收音 */
    }
  }, { passive: true });

  function upHandler(e) {
    active.delete(e.pointerId);
    if (!pointers.has(e.pointerId)) return;
    endVoice(e.pointerId, true);
  }
  window.addEventListener('pointerup', upHandler);
  window.addEventListener('pointercancel', upHandler);
  window.addEventListener('blur', function () { releaseEverything(); });

  /* ================= 电脑键盘映射 ================= */
  const KEYROWS = ['zxcvbnm', 'asdfghj', 'qwertyu'];

  function keyIndexFromChar(ch) {
    const k = ch.toLowerCase();
    for (let r = 0; r < KEYROWS.length; r++) {
      const c = KEYROWS[r].indexOf(k);
      if (c >= 0 && c < S.cols) return r * S.cols + c;
    }
    return -1;
  }

  window.addEventListener('keydown', function (e) {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    const id = 'k:' + e.key;
    if (e.key === 'ArrowLeft' || e.key === ',') { setPage(S.page - 1); return; }
    if (e.key === 'ArrowRight' || e.key === '.') { setPage(S.page + 1); return; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return;
    if (e.repeat) return;
    const idx = keyIndexFromChar(e.key);
    if (idx < 0) return;
    const el = board.querySelector('.key[data-index="' + idx + '"]');
    if (!el) return;
    e.preventDefault();
    hideHint();
    startVoice(id, el, null);
  });

  window.addEventListener('keyup', function (e) {
    const id = 'k:' + e.key;
    if (pointers.has(id)) endVoice(id, true);
  });

  /* ================= 翻页 ================= */

  function setPage(p) {
    const n = pageCount();
    const np = ((p % n) + n) % n;
    if (np === S.page) return;
    releaseEverything();
    S.page = np;
    saveSettings();
    buildBoard();
    renderDots();
  }

  function renderDots() {
    dotsEl.innerHTML = '';
    for (let i = 0; i < pageCount(); i++) {
      const d = document.createElement('button');
      d.className = 'dot' + (i === S.page ? ' active' : '');
      d.setAttribute('aria-label', '第 ' + (i + 1) + ' 页');
      d.addEventListener('click', function () { setPage(i); });
      dotsEl.appendChild(d);
    }
    if (rangeHint) rangeHint.textContent = rangeText();
  }

  /* ================= 底部栏 ================= */

  $('#btnPrev').addEventListener('click', function () { setPage(S.page - 1); });
  $('#btnNext').addEventListener('click', function () { setPage(S.page + 1); });

  const btnSustain = $('#btnSustain');
  btnSustain.addEventListener('click', function () {
    S.sustain = !S.sustain;
    btnSustain.classList.toggle('active', S.sustain);
    if (!S.sustain) releaseSustained();
    saveSettings();
  });

  const btnNames = $('#btnNames');
  btnNames.addEventListener('click', function () {
    S.names = !S.names;
    btnNames.classList.toggle('active', S.names);
    buildBoard();
    syncSheet();
    saveSettings();
  });

  /* 左右滑动翻页（在非琴键区域；已经开始刮奏则取消） */
  window.addEventListener('touchstart', function (e) {
    if (e.target.closest && e.target.closest('.key')) { swipe = null; return; }
    if (e.target.closest && (e.target.closest('.sheet') || e.target.closest('button'))) { swipe = null; return; }
    const t = e.touches[0];
    swipe = { x: t.clientX, y: t.clientY, t: Date.now() };
  }, { passive: true });
  window.addEventListener('touchend', function (e) {
    if (!swipe) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
    const dt = Date.now() - swipe.t;
    if (dt < 600 && Math.abs(dx) > 46 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      setPage(S.page + (dx < 0 ? 1 : -1));
    }
    swipe = null;
  }, { passive: true });

  /* ================= 提示 ================= */
  let hintGone = false;
  function hideHint() {
    if (hintGone) return;
    hintGone = true;
    if (hintEl) hintEl.classList.add('gone');
  }

  let toastTimer = 0;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 1700);
  }

  /* ================= 底部面板 ================= */

  function openSheet(tab) {
    sheet.classList.add('open');
    backdrop.classList.add('show');
    if (tab) selectTab(tab);
  }
  function closeSheet() {
    sheet.classList.remove('open');
    backdrop.classList.remove('show');
  }
  backdrop.addEventListener('click', closeSheet);
  $('#btnSettings').addEventListener('click', function () { openSheet('play'); });
  presetChip.addEventListener('click', function () { openSheet('timbre'); });
  $$('.tabs button', sheet).forEach(function (b) {
    b.addEventListener('click', function () { selectTab(b.dataset.tab); });
  });
  function selectTab(name) {
    $$('.tabs button', sheet).forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
    $$('.pane', sheet).forEach(function (p) { p.classList.toggle('active', p.dataset.pane === name); });
    sheet.scrollTop = 0;
  }

  /* ---- 音色列表 ---- */
  const presetGrid = $('#presetGrid');
  PianoAudio.presets.forEach(function (p, i) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.innerHTML = '<b>' + p.name + '</b><i>' + p.tag + '</i>';
    b.addEventListener('click', function () {
      S.preset = i;
      $$('.preset', presetGrid).forEach(function (x, xi) { x.classList.toggle('active', xi === i); });
      presetChip.textContent = p.name;
      saveSettings();
      PianoAudio.resume();
      const v = PianoAudio.play(72, .8, null, i);
      setTimeout(function () { v.release(); }, 900);
      if (S.vibrate && navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }
    });
    presetGrid.appendChild(b);
  });

  /* ---- 通用开关 / 选项控件 ---- */
  function bindToggle(sel, key, after) {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('click', function () {
      S[key] = !S[key];
      el.classList.toggle('active', !!S[key]);
      saveSettings();
      if (after) after();
    });
  }
  bindToggle('#optSustain', 'sustain', function () {
    btnSustain.classList.toggle('active', S.sustain);
    if (!S.sustain) releaseSustained();
  });
  bindToggle('#optVelocity', 'velocity');
  bindToggle('#optNames', 'names', function () {
    btnNames.classList.toggle('active', S.names);
    buildBoard();
  });
  bindToggle('#optHighlight', 'highlight', buildBoard);
  bindToggle('#optVibrate', 'vibrate');

  function bindChoice(sel, key, cast, after) {
    const wrap = $(sel);
    if (!wrap) return;
    $$('button', wrap).forEach(function (b) {
      b.addEventListener('click', function () {
        S[key] = cast ? cast(b.dataset.v) : b.dataset.v;
        $$('button', wrap).forEach(function (x) { x.classList.toggle('active', x === b); });
        saveSettings();
        if (after) after();
      });
    });
  }
  bindChoice('#optCols', 'cols', Number, function () {
    S.page = 0;
    buildBoard(); renderDots(); syncSheet();
  });
  bindChoice('#optScale', 'scale', null, function () {
    S.page = 0;
    buildBoard(); renderDots(); syncSheet();
  });
  bindChoice('#optOct', 'baseOct', Number, function () {
    S.page = 0;
    buildBoard(); renderDots(); syncSheet();
  });
  bindChoice('#optPages', 'pages', Number, function () {
    if (S.page >= S.pages) S.page = S.pages - 1;
    buildBoard(); renderDots(); syncSheet();
  });

  /* ---- 滑杆 ---- */
  function bindRange(sel, key, fn) {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('input', function () {
      S[key] = Number(el.value);
      const out = el.parentElement.querySelector('.val');
      if (out) out.textContent = Math.round(S[key] / (Number(el.max) || 1) * 100) + '%';
      saveSettings();
      if (fn) fn(S[key]);
    });
  }
  bindRange('#optVolume', 'volume', function (v) { PianoAudio.setVolume(v); });
  bindRange('#optReverb', 'reverb', function (v) { PianoAudio.setReverb(v); });

  /* ---- 录音 ---- */
  const btnRec = $('#btnRec');
  const btnPlay = $('#btnPlay');

  function setRecUI() {
    btnRec.classList.toggle('rec-on', recOn);
    btnRec.textContent = recOn ? '■' : '●';
    btnRec.setAttribute('aria-label', recOn ? '停止录音' : '开始录音');
    const rb = $('#recToggle');
    if (rb) {
      rb.textContent = recOn ? '■ 停止录音' : '● 开始录音';
      rb.classList.toggle('rec-on', recOn);
    }
    btnPlay.style.display = R.events.length ? '' : 'none';
    if (recInfo) {
      recInfo.textContent = R.events.length
        ? ('已录 ' + R.events.length + ' 个音 · 时长 ' + R.dur.toFixed(1) + ' 秒')
        : '还没有录音。点击「开始录音」，然后尽情弹奏。';
    }
  }

  function toggleRec() {
    if (recOn) {
      recOn = false;
      R.dur = Math.max(.2, performance.now() / 1000 - recStart);
      saveRecording();
      setRecUI();
      toast('录音结束 · 共 ' + R.events.length + ' 个音');
    } else {
      releaseEverything();
      R = { events: [], dur: 0 };
      recId = 0;
      recOn = true;
      recStart = performance.now() / 1000;
      setRecUI();
      toast('开始录音');
    }
  }
  btnRec.addEventListener('click', toggleRec);
  const recToggle = $('#recToggle');
  if (recToggle) recToggle.addEventListener('click', toggleRec);

  /* ---- 回放 ---- */
  let playToken = 0;
  let playTimers = [];
  let loopOn = false;

  function clearPlayTimers() {
    playTimers.forEach(clearTimeout);
    playTimers = [];
  }
  function stopPlayback() {
    playToken++;
    clearPlayTimers();
    PianoAudio.stopAll();
    setPlayUI(false);
  }
  function setPlayUI(playing) {
    btnPlay.textContent = playing ? '⏸' : '▶';
    btnPlay.classList.toggle('playing', playing);
    const pb = $('#recPlay');
    if (pb) pb.textContent = playing ? '⏸ 停止' : '▶ 播放';
  }
  function flashKey(midi) {
    const el = board.querySelector('.key[data-midi="' + midi + '"]');
    if (!el) return;
    el.classList.add('on');
    setTimeout(function () { el.classList.remove('on'); }, 170);
  }
  function playRecording(loop) {
    if (!R.events.length) { toast('还没有录音'); return; }
    PianoAudio.resume();
    stopPlayback();
    const token = ++playToken;
    const t0 = PianoAudio.now() + .18;
    const notes = R.events.slice().sort(function (a, b) { return a.t - b.t; });
    for (let i = 0; i < notes.length; i++) {
      const ev = notes[i];
      const v = PianoAudio.play(ev.midi, ev.vel == null ? .85 : ev.vel, t0 + ev.t, ev.p == null ? S.preset : ev.p);
      if (v && v.release) v.release(t0 + ev.t + Math.max(.12, ev.dur || .4));
      (function (midi, at) {
        playTimers.push(setTimeout(function () {
          if (token === playToken) flashKey(midi);
        }, Math.max(0, at * 1000 + 180)));
      })(ev.midi, ev.t);
    }
    const endMs = (R.dur + .7) * 1000;
    if (loop) {
      playTimers.push(setTimeout(function () {
        if (token === playToken) playRecording(true);
      }, endMs));
    } else {
      playTimers.push(setTimeout(function () {
        if (token === playToken) setPlayUI(false);
      }, endMs));
    }
    setPlayUI(true);
  }
  btnPlay.addEventListener('click', function () {
    if (btnPlay.classList.contains('playing')) stopPlayback();
    else playRecording(loopOn);
  });
  const recPlay = $('#recPlay');
  if (recPlay) {
    recPlay.addEventListener('click', function () {
      if (btnPlay.classList.contains('playing')) stopPlayback();
      else playRecording(loopOn);
    });
  }
  const recLoop = $('#recLoop');
  if (recLoop) {
    recLoop.addEventListener('click', function () {
      loopOn = !loopOn;
      recLoop.classList.toggle('active', loopOn);
    });
  }
  const recClear = $('#recClear');
  if (recClear) {
    recClear.addEventListener('click', function () {
      stopPlayback();
      R = { events: [], dur: 0 };
      saveRecording();
      setRecUI();
      toast('已清空录音');
    });
  }

  /* ================= 同步面板状态 ================= */
  function syncSheet() {
    $$('#optCols button').forEach(function (b) { b.classList.toggle('active', Number(b.dataset.v) === S.cols); });
    $$('#optScale button').forEach(function (b) { b.classList.toggle('active', b.dataset.v === S.scale); });
    $$('#optOct button').forEach(function (b) { b.classList.toggle('active', Number(b.dataset.v) === S.baseOct); });
    $$('#optPages button').forEach(function (b) { b.classList.toggle('active', Number(b.dataset.v) === S.pages); });
    $$('.preset', presetGrid).forEach(function (x, i) { x.classList.toggle('active', i === S.preset); });
    presetChip.textContent = PianoAudio.presets[S.preset].name;
    [['#optSustain', S.sustain], ['#optVelocity', S.velocity], ['#optNames', S.names],
     ['#optHighlight', S.highlight], ['#optVibrate', S.vibrate]].forEach(function (pair) {
      const el = $(pair[0]);
      if (el) el.classList.toggle('active', !!pair[1]);
    });
    const vol = $('#optVolume'), rev = $('#optReverb');
    if (vol) {
      vol.value = S.volume;
      const o = vol.parentElement.querySelector('.val');
      if (o) o.textContent = Math.round(S.volume * 100) + '%';
    }
    if (rev) {
      rev.value = S.reverb;
      const o = rev.parentElement.querySelector('.val');
      if (o) o.textContent = Math.round(S.reverb * 100) + '%';
    }
    btnSustain.classList.toggle('active', S.sustain);
    btnNames.classList.toggle('active', S.names);
    if (rangeHint) rangeHint.textContent = rangeText();
    setRecUI();
  }

  /* ================= 启动 ================= */
  function boot() {
    loadSettings();
    loadRecording();

    PianoAudio.setVolume(S.volume);
    PianoAudio.setReverb(S.reverb);

    buildBoard();
    renderDots();
    syncSheet();
    setRecUI();
    setPlayUI(false);

    if (window.ResizeObserver) {
      new ResizeObserver(layout).observe(board);
    }
    window.addEventListener('resize', layout);
    window.addEventListener('orientationchange', function () { setTimeout(layout, 250); });

    /* 首次交互解锁音频（iOS 要求） */
    const unlock = function () {
      PianoAudio.resume();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('touchstart', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('touchstart', unlock, { passive: true });
    window.addEventListener('keydown', unlock);

    /* 阻止舞台区域滚动 / 缩放 */
    document.addEventListener('touchstart', function (e) {
      if (e.target.closest && e.target.closest('.stage')) e.preventDefault();
    }, { passive: false });
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { releaseEverything(); flushSave(); }
    });
    window.addEventListener('pagehide', flushSave);
    window.addEventListener('beforeunload', flushSave);

    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }

    /* 供 Android 外壳的返回键调用：
       有关闭得掉的东西就自己处理；否则回调 PianoShell.exitApp() 让系统退出 App。
       浏览器里 window.PianoShell 不存在，直接返回 false。 */
    window.__skyBack = function () {
      if (btnPlay.classList.contains('playing')) { stopPlayback(); return true; }
      if (sheet.classList.contains('open')) { closeSheet(); return true; }
      if (window.PianoShell && window.PianoShell.exitApp) {
        try { window.PianoShell.exitApp(); } catch (e) {}
        return true;
      }
      return false;
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
