/*!
 * PIANO —— 音色合成引擎
 * 纯 Web Audio API 实现，无任何外部依赖。
 * 每种音色由「谐波表 + 包络 + 滤波 + 调制 + 混响送出」描述。
 */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------
   * 音色定义
   *   harm  谐波表 [比率, 音量, 波形, 该分音衰减时间(秒), 失谐(cents)]
   *   fm    调频：{ratio, index, dec}
   *   atk/dec/sus/rel   音量包络（dec 为衰减时间常数，sus 为持续电平）
   *   filt  低通/带通包络 {type,f,q,env,dec,key}
   *   formants 共振峰 [[频率,Q,强度]]
   *   vib   颤音 {rate,cents,delay}     trem 震音 {rate,depth}
   *   noise 起音噪声 {amount,f,q,dec}
   *   verb  混响送出量(0~1)   vol 单音总音量
   * ------------------------------------------------------------- */
  const H = (r, g, t, d, det) => ({ r: r, g: g, t: t || 'sine', d: d || 0, det: det || 0 });

  const PRESETS = [
    {
      id: 'grand', name: '大钢琴', tag: '明亮',
      harm: [H(1, 1), H(2, .6, 'sine', 3), H(3, .35, 'sine', 2), H(4, .22, 'sine', 1.4), H(5, .12, 'sine', 1), H(6, .08, 'sine', .7)],
      atk: .004, dec: 1.1, sus: .08, rel: .45,
      filt: { f: 6000, q: .5, env: 3.2, dec: .6, key: .6 },
      noise: { amount: .25, f: 2200, q: .9, dec: .02 },
      verb: .32, vol: .9
    },
    {
      id: 'epiano', name: '电钢琴', tag: '温暖',
      harm: [H(1, 1), H(2, .18, 'sine', 2), H(3, .06, 'sine', 1)],
      fm: { ratio: 2, index: 2.2, dec: .5 },
      atk: .005, dec: 1.3, sus: .12, rel: .5,
      filt: { f: 4200, q: .5, env: 2, dec: .7, key: .5 },
      trem: { rate: 4.6, depth: .10 },
      verb: .34, vol: .85
    },
    {
      id: 'box', name: '八音盒', tag: '清脆',
      harm: [H(1, 1), H(2, .2, 'sine', 1.2), H(5.4, .1, 'sine', .7), H(8.9, .05, 'sine', .5)],
      atk: .002, dec: .8, sus: .02, rel: .9,
      filt: { f: 7000, q: .6, env: 1.6, dec: .4, key: .7 },
      verb: .55, vol: .75
    },
    {
      id: 'harp', name: '竖琴', tag: '柔和',
      harm: [H(1, 1), H(2, .4, 'sine', 1.6), H(3, .2, 'sine', 1.1), H(4, .1, 'sine', .8), H(5, .05, 'sine', .6)],
      atk: .004, dec: 1.4, sus: .03, rel: 1.3,
      filt: { f: 5200, q: .6, env: 2.2, dec: .5, key: .5 },
      verb: .45, vol: .85
    },
    {
      id: 'guitar', name: '吉他', tag: '拨弦',
      harm: [H(1, 1), H(2, .55, 'sine', 1.4), H(3, .3, 'sine', 1), H(4, .18, 'sine', .8), H(5, .1, 'sine', .6), H(6, .05, 'sine', .5)],
      atk: .004, dec: .9, sus: .03, rel: .4,
      filt: { f: 4000, q: .7, env: 2.6, dec: .35, key: .5 },
      noise: { amount: .5, f: 1800, q: 1.1, dec: .02 },
      verb: .28, vol: .85
    },
    {
      id: 'bell', name: '钟琴', tag: '悠远',
      harm: [H(1, 1), H(2.76, .5, 'sine', 2.4), H(5.4, .22, 'sine', 1.6), H(8.9, .1, 'sine', 1.1), H(13.3, .04, 'sine', .7)],
      atk: .002, dec: 2.2, sus: .02, rel: 2.2,
      filt: { f: 9000, q: .4, env: 1.4, dec: .8, key: .6 },
      verb: .62, vol: .7
    },
    {
      id: 'flute', name: '长笛', tag: '气声',
      harm: [H(1, 1), H(2, .14, 'sine', 1.5), H(3, .06, 'sine', 1)],
      atk: .07, dec: .9, sus: .85, rel: .22,
      filt: { f: 2600, q: .7, env: 1.6, dec: .3, key: .5 },
      noise: { amount: .16, f: 2600, q: .8, dec: .35 },
      vib: { rate: 5, cents: 9, delay: .3 },
      verb: .36, vol: .8
    },
    {
      id: 'strings', name: '弦乐', tag: '绵长',
      harm: [H(1, 1, 'sawtooth', 0, -6), H(1, .9, 'sawtooth', 0, 7), H(2, .28, 'sine', 2), H(3, .16, 'sine', 1.6), H(4, .09, 'sine', 1.2)],
      atk: .14, dec: 1.2, sus: .85, rel: .55,
      filt: { f: 2400, q: 1.2, env: 2.4, dec: .8, key: .5 },
      vib: { rate: 4.6, cents: 6, delay: .4 },
      verb: .5, vol: .6
    },
    {
      id: 'organ', name: '管风琴', tag: '庄严',
      harm: [H(1, 1), H(2, .6), H(3, .45), H(4, .3), H(6, .2), H(8, .14)],
      atk: .02, dec: .3, sus: .95, rel: .14,
      filt: { f: 5000, q: .5, env: 1.3, dec: .3, key: .5 },
      vib: { rate: 6, cents: 3, delay: .2 },
      verb: .45, vol: .55
    },
    {
      id: 'marimba', name: '马林巴', tag: '木质',
      harm: [H(1, 1), H(3.9, .22, 'sine', .5), H(9.2, .06, 'sine', .3)],
      atk: .002, dec: .42, sus: .012, rel: .4,
      filt: { f: 3600, q: .6, env: 2, dec: .25, key: .6 },
      noise: { amount: .3, f: 1200, q: 1, dec: .015 },
      verb: .3, vol: .9
    },
    {
      id: 'pad', name: '合成铺底', tag: '梦幻',
      harm: [H(1, 1, 'sawtooth', 0, -8), H(1, .95, 'sawtooth', 0, 9), H(2, .2, 'triangle')],
      atk: .35, dec: 1.6, sus: .8, rel: 1.1,
      filt: { f: 1500, q: 2.6, env: 2.2, dec: 1.2, key: .5 },
      vib: { rate: .6, cents: 8, delay: .2 },
      verb: .6, vol: .5
    },
    {
      id: 'harmonica', name: '口琴', tag: '怀旧',
      harm: [H(1, 1), H(3, .5), H(5, .32), H(7, .18), H(9, .08)],
      atk: .035, dec: .35, sus: .8, rel: .14,
      filt: { f: 3800, q: .8, env: 1.6, dec: .3, key: .5 },
      vib: { rate: 5.5, cents: 8, delay: .3 },
      verb: .32, vol: .65
    },
    {
      id: 'chip', name: '电子 8bit', tag: '像素',
      harm: [H(1, 1, 'square'), H(2, .4, 'square', 1.2), H(3, .2, 'square', 1)],
      atk: .002, dec: .18, sus: .45, rel: .05,
      filt: { f: 5200, q: .7, env: 1.4, dec: .2, key: .4 },
      verb: .18, vol: .5
    },
    {
      id: 'choir', name: '人声“啊”', tag: '空灵',
      harm: [H(1, 1), H(2, .55), H(3, .4), H(4, .22), H(5, .14)],
      atk: .16, dec: 1, sus: .85, rel: .6,
      filt: { f: 2200, q: .9, env: 1.6, dec: .7, key: .5 },
      formants: [[720, 7, 1], [1240, 9, .6]],
      vib: { rate: 4.8, cents: 12, delay: .35 },
      verb: .62, vol: .55
    }
  ];

  /* ---------------------------------------------------------------
   * 引擎内部状态
   * ------------------------------------------------------------- */
  let ctx = null, dry = null, verbBus = null, verbOut = null, master = null, comp = null, noiseBuf = null;
  const voices = new Set();
  const MAX_VOICES = 40;
  let volume = .8, reverb = 1;

  const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);

  function makeNoiseBuffer(c) {
    const len = Math.max(1, Math.floor(c.sampleRate));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* 用噪声 + 指数衰减合成混响脉冲响应（立体声） */
  function makeIR(c, seconds, decay) {
    const rate = c.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = c.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (1 - Math.exp(-i / (rate * .006)));
      }
    }
    return buf;
  }

  function init() {
    if (ctx) return ctx;
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch (e) {
      ctx = new AC();
    }

    dry = ctx.createGain(); dry.gain.value = 1;
    verbBus = ctx.createGain(); verbBus.gain.value = reverb * 1.15;
    const conv = ctx.createConvolver();
    conv.buffer = makeIR(ctx, 2.6, 2.6);
    verbOut = ctx.createGain(); verbOut.gain.value = .9;
    master = ctx.createGain(); master.gain.value = volume;
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 24;
    comp.ratio.value = 3;
    comp.attack.value = .004;
    comp.release.value = .25;

    dry.connect(master);
    verbBus.connect(conv);
    conv.connect(verbOut);
    verbOut.connect(master);
    master.connect(comp);
    comp.connect(ctx.destination);

    noiseBuf = makeNoiseBuffer(ctx);
    return ctx;
  }

  function resume() {
    init();
    if (ctx && ctx.state === 'suspended') {
      const p = ctx.resume();
      if (p && p.catch) p.catch(function () {});
    }
    return ctx;
  }

  const now = () => (ctx ? ctx.currentTime : 0);

  const SILENT = { release: function () {}, stop: function () {} };

  /* ---------------------------------------------------------------
   * 演奏一个音
   * ------------------------------------------------------------- */
  function play(midi, vel, when, presetIndex) {
    if (!init()) return SILENT;
    if (ctx.state === 'suspended') resume();

    const preset = PRESETS[presetIndex] || PRESETS[0];
    const t0 = Math.max(when == null ? ctx.currentTime : when, ctx.currentTime + .002);
    const freq = midiToFreq(midi);
    vel = clamp(vel == null ? .85 : vel, .05, 1);

    const peak = Math.max(.002, vel * (preset.vol == null ? .8 : preset.vol) * .5);
    const atk = Math.max(.002, preset.atk || .005);
    const decT = Math.max(.03, preset.dec == null ? .5 : preset.dec);
    const sus = preset.sus == null ? .1 : preset.sus;
    const relT = Math.max(.03, preset.rel == null ? .4 : preset.rel);

    const stopList = [];
    const pitchNodes = [];   /* 只对谐波振荡器施加颤音 */
    let dead = false;

    /* 输出总线 */
    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(dry);
    if (preset.verb) {
      const send = ctx.createGain();
      send.gain.value = preset.verb;
      out.connect(send);
      send.connect(verbBus);
    }

    /* 音量包络 */
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(.0001, t0);
    amp.gain.linearRampToValueAtTime(peak, t0 + atk);
    amp.gain.setTargetAtTime(Math.max(.00006, peak * sus), t0 + atk, decT / 3);

    /* 滤波包络 */
    let srcIn = amp;
    if (preset.filt) {
      const f = ctx.createBiquadFilter();
      f.type = preset.filt.type || 'lowpass';
      f.Q.value = preset.filt.q == null ? .7 : preset.filt.q;
      const kt = preset.filt.key == null ? .5 : preset.filt.key;
      const nyq = ctx.sampleRate * .45;
      const base = clamp((preset.filt.f || 4000) * Math.pow(freq / 261.63, kt), 120, nyq);
      const top = clamp(base * (preset.filt.env || 1), 120, nyq);
      f.frequency.setValueAtTime(top, t0);
      f.frequency.setTargetAtTime(base, t0, Math.max(.02, preset.filt.dec || .5) / 3);
      f.connect(amp);
      srcIn = f;
    }

    /* 共振峰 */
    let post = amp;
    if (preset.formants) {
      for (let i = 0; i < preset.formants.length; i++) {
        const fm2 = preset.formants[i];
        const pf = ctx.createBiquadFilter();
        pf.type = 'peaking';
        pf.frequency.value = fm2[0];
        pf.Q.value = fm2[1];
        pf.gain.value = 12 * fm2[2];
        post.connect(pf);
        post = pf;
      }
    }
    post.connect(out);

    /* 谐波 */
    let harmSum = 0;
    for (let i = 0; i < preset.harm.length; i++) harmSum += preset.harm[i].g;
    const norm = 1 / Math.max(1, harmSum * .8);

    for (let i = 0; i < preset.harm.length; i++) {
      const h = preset.harm[i];
      const osc = ctx.createOscillator();
      osc.type = h.t || 'sine';
      osc.frequency.value = freq * h.r;
      if (h.det) osc.detune.value = h.det;
      const hg = ctx.createGain();
      const gv = h.g * norm * (h.r > 8 ? .7 : 1);
      if (h.d) {
        hg.gain.setValueAtTime(.0001, t0);
        hg.gain.linearRampToValueAtTime(gv, t0 + atk);
        hg.gain.setTargetAtTime(.0001, t0 + atk, Math.max(.02, h.d) / 3);
      } else {
        hg.gain.value = gv;
      }
      osc.connect(hg);
      hg.connect(srcIn);
      osc.start(t0);
      stopList.push(osc);
      pitchNodes.push(osc);
    }

    /* FM 调制（作用于基频振荡器） */
    if (preset.fm && stopList.length) {
      const carrier = stopList[0];
      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.value = freq * preset.fm.ratio;
      const mg = ctx.createGain();
      mg.gain.setValueAtTime(freq * preset.fm.index, t0);
      mg.gain.setTargetAtTime(.0001, t0, Math.max(.02, preset.fm.dec) / 3);
      mod.connect(mg);
      mg.connect(carrier.frequency);
      mod.start(t0);
      stopList.push(mod);
    }

    /* 起音噪声（拨弦 / 气声） */
    if (preset.noise && noiseBuf) {
      const ns = ctx.createBufferSource();
      ns.buffer = noiseBuf;
      ns.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = preset.noise.f;
      bp.Q.value = preset.noise.q == null ? 1 : preset.noise.q;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(peak * preset.noise.amount, t0);
      ng.gain.setTargetAtTime(.0001, t0, Math.max(.01, preset.noise.dec || .03) / 3);
      ns.connect(bp);
      bp.connect(ng);
      ng.connect(srcIn);
      ns.start(t0);
      stopList.push(ns);
    }

    /* 颤音（音高 LFO） */
    if (preset.vib) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = preset.vib.rate;
      const lg = ctx.createGain();
      const depth = freq * (Math.pow(2, preset.vib.cents / 1200) - 1);
      const dly = preset.vib.delay == null ? .25 : preset.vib.delay;
      lg.gain.setValueAtTime(0, t0);
      lg.gain.linearRampToValueAtTime(depth, t0 + dly + .4);
      lfo.connect(lg);
      for (let i = 0; i < pitchNodes.length; i++) {
        try { lg.connect(pitchNodes[i].frequency); } catch (e) {}
      }
      lfo.start(t0);
      stopList.push(lfo);
    }

    /* 震音（音量 LFO） */
    if (preset.trem) {
      const tl = ctx.createOscillator();
      tl.frequency.value = preset.trem.rate;
      const tg = ctx.createGain();
      tg.gain.value = peak * preset.trem.depth;
      tl.connect(tg);
      tg.connect(amp.gain);
      tl.start(t0);
      stopList.push(tl);
    }

    function kill(at) {
      if (dead || !stopList.length) { dead = true; return; }
      dead = true;
      const list = stopList.slice();
      stopList.length = 0;
      for (let i = 0; i < list.length; i++) {
        try { list[i].stop(at); } catch (e) {}
      }
      const delay = Math.max(0, (at - ctx.currentTime) * 1000) + 300;
      setTimeout(function () {
        try { out.disconnect(); } catch (e) {}
        voices.delete(rec);
      }, delay);
    }

    const rec = {
      release: function (at) {
        if (dead) return;
        const t = Math.max(at == null ? ctx.currentTime : at, ctx.currentTime);
        const g = amp.gain;
        try {
          if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
          else g.cancelScheduledValues(t);
        } catch (e) {
          g.cancelScheduledValues(t);
        }
        g.setTargetAtTime(.0001, t, relT / 3);
        kill(t + relT * 2 + .06);
      },
      stop: function () {
        if (dead) return;
        const t = ctx.currentTime;
        try {
          amp.gain.cancelScheduledValues(t);
          amp.gain.setTargetAtTime(.0001, t, .02);
        } catch (e) {}
        kill(t + .15);
      }
    };

    voices.add(rec);
    if (voices.size > MAX_VOICES) {
      const it = voices.values();
      const oldest = it.next().value;
      if (oldest && oldest !== rec) oldest.stop();
    }
    return rec;
  }

  function stopAll() {
    voices.forEach(function (v) { v.stop(); });
    voices.clear();
  }

  function setVolume(v) {
    volume = clamp(v, 0, 1);
    if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, .03);
  }

  function setReverb(v) {
    reverb = clamp(v, 0, 1.6);
    if (verbBus) verbBus.gain.setTargetAtTime(reverb * 1.15, ctx.currentTime, .05);
  }

  global.PianoAudio = {
    presets: PRESETS,
    init: init,
    resume: resume,
    now: now,
    play: play,
    stopAll: stopAll,
    setVolume: setVolume,
    setReverb: setReverb,
    get context() { return ctx; },
    isReady: function () { return !!ctx && ctx.state === 'running'; }
  };
})(typeof window !== 'undefined' ? window : this);
