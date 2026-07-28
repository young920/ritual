/* sport · training.js
   沉浸式训练模式 v4 — 事件驱动 + 阶段化

   设计:
   - 5 阶段状态机: warmup → main → rest → next main → ... → cooldown → done
   - voice 锚定 phase(下放→控制, 推起→呼气发力, 收紧→收紧)
   - voice 在 stage 边界、rep 半/末触发
   - Web Speech API(zh-CN 标准女声,机械感是已知局限)
   - BGM 槽预留,后续接入真实 mp3

   视图:
   - warmup  : 大字 phase 名 + segmented bar + tip + 倒计时
   - main    : 左 image + 右 segmented bar → phase → 大数字 → dots
   - rest    : 大数字倒计时 + 下一组预告
   - cooldown: 同 warmup
   - done    : 完成画面
*/
(function () {
  // ─── phase 声音分类(保留 v3) ────────────────────────────────
  function classifyPhase(name) {
    const n = String(name || '').toLowerCase();
    if (/准备|预备|起势|setup|start|吸气|深呼吸/.test(n)) return 'prepare';
    if (/下放|下落|下降|离心|还原|释放|回|lower|release|return|慢/.test(n)) return 'lower';
    if (/推起|起身|向心|上提|撑起|拉起|起来|lift|push|pull|快/.test(n)) return 'lift';
    if (/收紧|锁定|顶峰|保持|停留|hold|contract|挤/.test(n)) return 'release';
    return 'move';
  }

  const PHASE_SOUND = {
    prepare: { freq: 700, attack: 0.005, decay: 0.10, vol: 0.25 },
    release: { freq: 700, attack: 0.005, decay: 0.10, vol: 0.25 },
    lower:   { freq: 180, attack: 0.05, decay: 0.05, vol: 0.22 },
    lift:    { freq: 520, attack: 0.005, decay: 0.06, vol: 0.30 },
    move:    { freq: 440, attack: 0.005, decay: 0.06, vol: 0.20 },
  };

  // ─── voice 锚(新增) ────────────────────────────────────────
  function classifyVoiceAnchor(name) {
    const n = String(name || '').toLowerCase();
    if (/下放|下落|下降|离心|还原|释放|回|lower|release|return|慢/.test(n)) return 'control';
    if (/推起|起身|向心|上提|撑起|拉起|起来|lift|push|pull|快/.test(n)) return 'exhale';
    if (/收紧|锁定|顶峰|保持|停留|hold|contract|挤/.test(n)) return 'contract';
    if (/准备|预备|起势|setup|start|吸气|深呼吸/.test(n)) return 'breathe';
    return null;
  }

  const ANCHOR_TEXT = {
    control: '控制',
    exhale: '呼气发力',
    contract: '收紧',
    breathe: '吸气',
  };

  const FALLBACK_PHASES = [
    { name: '准备', sec: 0.5, tip: '吸气准备' },
    { name: '下放', sec: 2.0, tip: '控制速度' },
    { name: '推起', sec: 1.2, tip: '呼气发力' },
    { name: '收紧', sec: 0.4, tip: '顶峰收缩' },
  ];

  // ─── Beat Engine(扩展 voice 接口) ───────────────────────────
  class BeatEngine {
    constructor() {
      this.ctx = null;
      this.muted = false;
      this.tickCb = null;
      this.endCb = null;
      this.voiceCb = null;
      this._timeline = [];
      this._tick = 0;
      this._running = false;
      this._timer = null;
      this._phasesPerRep = 1;
    }

    ensureCtx() {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    }

    setMuted(m) { this.muted = m; }
    onTick(cb) { this.tickCb = cb; }
    onEnd(cb) { this.endCb = cb; }
    onVoice(cb) { this.voiceCb = cb; }

    start(phases, totalReps, speedScale = 1, startFromTick = 0) {
      this.ensureCtx();
      if (!Array.isArray(phases) || !phases.length) phases = FALLBACK_PHASES;
      const scaled = phases.map((p) => ({
        name: p.name, tip: p.tip, voiceAnchor: p.voiceAnchor || classifyVoiceAnchor(p.name),
        sec: Math.max(0.3, Number(p.sec) || 1) * speedScale,
      }));
      this._phasesPerRep = scaled.length;
      this._totalReps = totalReps;
      const total = totalReps * this._phasesPerRep;
      this._timeline = [];
      for (let r = 1; r <= totalReps; r++) {
        for (let pi = 0; pi < scaled.length; pi++) {
          this._timeline.push({
            phase: scaled[pi].name,
            tip: scaled[pi].tip,
            voiceAnchor: scaled[pi].voiceAnchor,
            sec: scaled[pi].sec,
            type: classifyPhase(scaled[pi].name),
            rep: r,
            indexInRep: pi,
            isFirstInRep: pi === 0,
            isLastInRep: pi === scaled.length - 1,
            isRepBoundary: pi === scaled.length - 1,
            isFirstOverall: r === 1 && pi === 0,
            isLastOverall: r === totalReps && pi === scaled.length - 1,
          });
        }
      }
      this._tick = startFromTick;  // 暂停后从原 tick 续
      this._running = true;
      this._scheduleNext();
    }

    stop() {
      this._running = false;
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    }

    // 暂停 — 记下当前 tick,清除 setTimeout
    pause() {
      if (!this._running) return null;
      this._running = false;
      const atTick = this._tick;  // 当前刚执行的 tick 序号
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
      return atTick;
    }

    // 续跑 — 从指定 tick 继续(同 phases/totalReps/speedScale 重启)
    resume(phases, totalReps, speedScale = 1, atTick = 0) {
      if (this._running) return;
      this.start(phases, totalReps, speedScale, atTick);
    }

    _scheduleNext = () => {
      if (!this._running) return;
      this._tick++;
      if (this._tick > this._timeline.length) {
        this._running = false;
        if (this.endCb) this.endCb();
        return;
      }
      const item = this._timeline[this._tick - 1];
      this._playPhaseSound(item);
      if (this.tickCb) this.tickCb(item, this._timeline.length);
      // voice 触发:phase 锚 + rep 边界
      if (this.voiceCb) {
        if (item.voiceAnchor) {
          this.voiceCb({ kind: 'phase-anchor', anchor: item.voiceAnchor, phase: item.phase, rep: item.rep });
        }
        if (item.isRepBoundary) {
          this.voiceCb({ kind: 'rep-boundary', item, rep: item.rep, total: this._totalReps, isLast: item.isLastOverall });
        }
      }
      this._timer = setTimeout(this._scheduleNext, item.sec * 1000);
    };

    _playPhaseSound(item) {
      if (this.muted) return;
      const sound = PHASE_SOUND[item.type] || PHASE_SOUND.move;
      const time = this.ctx.currentTime;
      const dur = item.sec;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = sound.freq;
      if (item.type === 'lower') {
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(sound.vol, time + sound.attack);
        gain.gain.linearRampToValueAtTime(sound.vol * 0.65, time + dur - 0.08);
        gain.gain.linearRampToValueAtTime(0.001, time + dur);
      } else {
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(sound.vol, time + sound.attack);
        gain.gain.exponentialRampToValueAtTime(0.001, time + sound.decay);
      }
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(time);
      osc.stop(time + dur + 0.01);

      if (item.isLastOverall) {
        this._playTriTone(time + 0.05);
      } else if (item.isRepBoundary) {
        this._playPing(time + 0.02, 660, 0.18);
      }
    }

    _playPing(time, freq, dur) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(0.25, time + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.001, time + dur);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(time);
      osc.stop(time + dur);
    }

    _playTriTone(time) {
      [523, 659, 880].forEach((freq, i) => {
        this._playPing(time + i * 0.15, freq, 0.18);
      });
    }
  }

  // ─── 背景音乐(v4 占位,接入 ~4 个 mp3) ────────────────────
  // 文件放在 /static/bgm/,主音量 0.06(潜意识底色)。
  // 用 HTMLAudio 而不是 Web Audio loop,简化实现。
  const BGM_URLS = [
    '/static/bgm/01-planning.mp3',
    '/static/bgm/02-biography.mp3',
    '/static/bgm/03-slow-down.mp3',
    '/static/bgm/04-the-templer.mp3',
  ];
  let _bgm = null;
  let _bgmIdx = 0;
  let _bgmPlaying = false;

  function ensureBgm() {
    if (_bgm) return _bgm;
    _bgm = new Audio();
    _bgm.loop = false;
    _bgm.volume = 0;
    _bgm.preload = 'auto';
    _bgm.addEventListener('ended', () => {
      // 当前曲自然结束时,切下一首
      if (!_bgmPlaying) return;
      _bgmIdx = (_bgmIdx + 1) % BGM_URLS.length;
      _bgm.src = BGM_URLS[_bgmIdx];
      _bgm.play().catch((e) => console.warn('[sport] bgm next failed:', e));
    });
    return _bgm;
  }

  function startBgm() {
    if (_bgmPlaying) return;
    try {
      const a = ensureBgm();
      a.src = BGM_URLS[_bgmIdx];
      a.volume = 0;
      const targetVol = state?.bgmVolume ?? 0.18;
      const tryPlay = () => {
        const p = a.play();
        if (p && typeof p.then === 'function') {
          p.then(() => {
            _bgmPlaying = true;
            console.log('[sport] bgm playing:', BGM_URLS[_bgmIdx], 'vol=', targetVol);
            fadeBgm(0, targetVol, 1500);
          }).catch((e) => {
            if (e.name === 'NotAllowedError') {
              console.warn('[sport] bgm blocked until user interaction');
            } else {
              console.warn('[sport] bgm retry in 800ms:', e.name);
              setTimeout(tryPlay, 800);
            }
          });
        } else {
          _bgmPlaying = true;
          fadeBgm(0, targetVol, 1500);
        }
      };
      if (a.readyState >= 2) tryPlay(); // HAVE_CURRENT_DATA
      else a.addEventListener('loadeddata', tryPlay, { once: true });
    } catch (e) {
      console.error('[sport] bgm error:', e);
    }
  }

  function stopBgm() {
    if (!_bgmPlaying) return;
    _bgmPlaying = false;
    const a = _bgm;
    fadeBgm(a.volume, 0, 600);
    setTimeout(() => { if (!_bgmPlaying) a.pause(); }, 700);
  }

  function fadeBgm(from, to, durationMs) {
    const a = _bgm;
    if (!a) return;
    const steps = 20;
    const stepMs = durationMs / steps;
    const stepAmt = (to - from) / steps;
    let i = 0;
    const iv = setInterval(() => {
      if (!_bgm || !_bgmPlaying) { clearInterval(iv); return; }
      i++;
      const v = Math.max(0, Math.min(1, from + stepAmt * i));
      _bgm.volume = v;
      if (i >= steps) clearInterval(iv);
    }, stepMs);
  }

  // ─── helpers ────────────────────────────────────────────────
  const $e = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };
  const $ = (id) => document.getElementById(id);

  // 媒体元素 helper:根据 src 后缀动态创建 video 或 img
  // primary 优先 mp4 → 用 <video>;fallback 用 svg/png → 用 <img>
  function makeMediaEl(primary, fallback) {
    const ext = (primary || '').split('.').pop().toLowerCase();
    if (ext === 'mp4' || ext === 'webm') {
      const v = document.createElement('video');
      v.muted = true;
      v.loop = true;
      v.autoplay = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.className = 'train__media';
      v.src = primary;
      // primary mp4 加载失败 → 自动换 fallback
      if (fallback) {
        v.addEventListener('error', () => {
          if (v.dataset.fallbackTried) return;
          v.dataset.fallbackTried = '1';
          v.removeAttribute('src');  // 清掉错误 src
          v.load();
          // 用 img 元素替代这个 video
          const wrap = v.parentNode;
          if (wrap) {
            const img = document.createElement('img');
            img.className = 'train__media';
            img.src = fallback;
            img.alt = '';
            wrap.replaceChild(img, v);
          }
        }, { once: true });
      }
      return v;
    }
    const img = document.createElement('img');
    img.className = 'train__media';
    img.alt = '';
    img.src = primary || fallback || '';
    img.onerror = () => {
      if (fallback && img.src.indexOf(fallback) === -1) img.src = fallback;
    };
    return img;
  }

  // 替换 media_wrap 内的媒体元素
  // phaseTip 为可选字符串,没图时显示引导文字
  function setMediaSrc(mediaWrap, primary, fallback, phaseTip) {
    while (mediaWrap.firstChild) mediaWrap.removeChild(mediaWrap.firstChild);
    if (!primary && !fallback) {
      const guide = $e('div', 'train__media train__media--guide');
      guide.innerHTML = `
        <div class="train__media-guide-icon">🎧</div>
        <div class="train__media-guide-title">跟随语音指令</div>
        <div class="train__media-guide-tip">${escapeHtml(phaseTip || '听教练的口令节奏一起做')}</div>`;
      mediaWrap.appendChild(guide);
      return;
    }
    mediaWrap.appendChild(makeMediaEl(primary, fallback));
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let state = null;
  let _voiceEnabled = false;
  let _currentLang = 'zh-CN';

  // 节流:同 kind+key 短时间内不重复说;不同 kind 立刻覆盖
  let _voiceState = { kind: '', key: '', at: 0 };
  // TTS mp3 缓存(text → Audio 元素)
  const _ttsCache = new Map();

  // ─── 预生成 mp3 音频(kin 在 VOICE_DIR 里) ───────────────
  const VOICE_DIR = '/static/voice/';
  const VOICE_MP3_KEYS = new Set([
    'prep_3', 'prep_2', 'prep_1', 'prep_go',
    'start',
    'half', 'last_two', 'last_one', 'keep_going',
    'rest_done', 'rest', 'next_action', 'next_set',
    'workout_done', 'well_done',
    'control', 'exhale',
    ...Array.from({ length: 12 }, (_, i) => `n_${i + 1}`),
  ]);
  const _audioCache = new Map();
  function playClip(mp3Key) {
    let a = _audioCache.get(mp3Key);
    if (!a) {
      a = new Audio(VOICE_DIR + mp3Key + '.mp3');
      a.preload = 'auto';
      _audioCache.set(mp3Key, a);
    }
    a.currentTime = 0;
    const p = a.play();
    if (p && p.catch) p.catch((e) => console.warn(`[sport] voice ${mp3Key} failed:`, e?.name));
    return a;
  }

  // 服务端合成 voice_intro 等动态文本,fetch + Audio 元素播放
  function playTts(text) {
    let a = _ttsCache.get(text);
    if (!a) {
      const url = '/api/tts?text=' + encodeURIComponent(text);
      a = new Audio(url);
      a.preload = 'auto';
      _ttsCache.set(text, a);
    }
    a.currentTime = 0;
    const p = a.play();
    if (p && p.catch) {
      p.catch((e) => {
        console.warn('[sport] tts fetch failed:', e?.name, '→ fallback Web Speech');
        if (!_voiceEnabled) return;
        if (!('speechSynthesis' in window)) return;
        try {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(text);
          u.lang = _currentLang;
          u.rate = 1.05;
          u.pitch = 1.0;
          u.volume = 0.85;
          window.speechSynthesis.speak(u);
        } catch (e2) { /* ignore */ }
      });
    }
    return a;
  }

  // 等 TTS 合成文本播完(最多 4 秒,避免卡死)
  function awaitTtsEnd(text, maxMs = 4000) {
    return new Promise((resolve) => {
      let a = _ttsCache.get(text);
      if (!a) {
        a = new Audio('/api/tts?text=' + encodeURIComponent(text));
        a.preload = 'auto';
        _ttsCache.set(text, a);
      }
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      a.addEventListener('ended', finish, { once: true });
      a.currentTime = 0;
      a.play().catch(() => finish());
      setTimeout(finish, maxMs);  // 安全网
    });
  }

  // 等 mp3 播完(clip 是 key)
  function awaitClipEnd(mp3Key, maxMs = 4000) {
    return new Promise((resolve) => {
      const a = playClip(mp3Key);
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      a.addEventListener('ended', finish, { once: true });
      setTimeout(finish, maxMs);
    });
  }

  function speak(text, kind = 'misc', key = '') {
    // mp3 路径: 优先(任何注册过的 key 都走 mp3)
    if (VOICE_MP3_KEYS.has(text)) {
      const now = Date.now();
      if (kind === _voiceState.kind && key === _voiceState.key && now - _voiceState.at < 200) return;
      _voiceState = { kind, key, at: now };
      playClip(text);
      return;
    }
    // 文本路径: 服务端 TTS 合成 mp3(Web Speech 兜底)
    const now = Date.now();
    if (kind === _voiceState.kind && key === _voiceState.key && now - _voiceState.at < 500) return;
    _voiceState = { kind, key, at: now };
    playTts(text);
  }

  function parseRepsCount(reps) {
    if (typeof reps === 'number') return Math.max(1, reps);
    if (typeof reps !== 'string') return 8;
    const m = reps.match(/(\d+)\s*[-~]\s*(\d+)/);
    if (m) return Number(m[2]);
    const n = reps.match(/(\d+)/);
    return n ? Number(n[1]) : 8;
  }

  function activeDayTitle() {
    const el = document.querySelector('.day-tab.is-active');
    if (!el) return '';
    return el.textContent.replace(/^第\S+天\s·\s*/, '');
  }

  // ─── 解析 plan(支持旧/新两种 schema) ───────────────────────
  function normalizePlan(day) {
    // 老 schema 没有 warmup/cooldown/voice_intro
    // v4 schema: day.warmup / exercises / day.cooldown 都是新字段
    const plan = {
      raw: day,
      hasWarmup: !!(day && Array.isArray(day.warmup?.phases) && day.warmup.phases.length),
      hasCooldown: !!(day && Array.isArray(day.cooldown?.phases) && day.cooldown.phases.length),
      warmup: null,
      cooldown: null,
      exercises: (day && day.exercises) || [],
    };
    if (plan.hasWarmup) {
      plan.warmup = {
        intro: day.warmup.voice_intro || '热身分几个动作',
        phases: day.warmup.phases.map((p) => ({
          name: p.name, sec: Number(p.sec) || 1, tip: p.tip || '',
          voiceAnchor: classifyVoiceAnchor(p.name),
          gif: p.gif_cdn || p.image_cdn || '',
          exerciseId: p.exercise_id || null,
        })),
      };
    }
    if (plan.hasCooldown) {
      plan.cooldown = {
        intro: day.cooldown.voice_intro || '现在拉伸',
        phases: day.cooldown.phases.map((p) => ({
          name: p.name, sec: Number(p.sec) || 1, tip: p.tip || '',
          voiceAnchor: classifyVoiceAnchor(p.name),
          gif: p.gif_cdn || p.image_cdn || '',
          exerciseId: p.exercise_id || null,
        })),
      };
    }
    plan.exercises = plan.exercises.map((ex) => ({
      ...ex,
      voice_intro: ex.voice_intro || `${ex.name || ''}, ${parseRepsCount(ex.reps)} 次`,
      phases: (Array.isArray(ex.phases) && ex.phases.length) ? ex.phases.map((p) => ({
        name: p.name, sec: Number(p.sec) || 1, tip: p.tip || '',
        voiceAnchor: classifyVoiceAnchor(p.name),
      })) : FALLBACK_PHASES,
      repsNum: parseRepsCount(ex.reps),
    }));
    // warmup/cooldown 阶段优先用 LLM 配的库内动作真人 gif(经 server 注入 phase.gif_cdn)
    // 没有 gif 时才回退到本地 SVG(手画示意)
    const _warmupSvgKw = [
      { re: /颈.*侧|side.*neck/i, svg: 'neck_side' },
      { re: /扩胸|chest.*open|chest.*act|胸.*拉/i, svg: 'chest_open' },
      { re: /推墙|wall|calf|手撑/i, svg: 'wall_push' },
      { re: /弓步|lunge/i, svg: 'lunge' },
      { re: /背.*拉|back.*stretch/i, svg: 'back_stretch' },
    ];
    function _phaseImage(phase) {
      if (!phase) return { primary: '', fallback: '' };
      // 1) 库 GIF(LLM 通过 exercise_id 选了库内动作,server 注入 gif_cdn / image_cdn,
      //    normalizePlan 又映射成 .gif / .image)
      const primary = phase.gif_cdn || phase.gif || phase.image_cdn || phase.image || '';
      const fallback = phase.image_cdn || phase.image || '';
      if (primary) return { primary, fallback };
      // 2) fallback:本地 SVG SMIL 动画(关键字匹配)
      const n = phase.name || '';
      for (const m of _warmupSvgKw) {
        if (m.re.test(n)) {
          return { primary: `/static/warmup/${m.svg}.svg`, fallback: '' };
        }
      }
      return { primary: '', fallback: '' };
    }
    plan.phaseImage = _phaseImage;
    plan.phaseImageUrl = (phase) => {
      const r = _phaseImage(phase);
      return (typeof r === 'string') ? r : r.primary;
    };
    // 展平为 sets queue(每个动作 × 每组)
    plan.sets = [];
    plan.exercises.forEach((ex, exIdx) => {
      const totalSets = Math.max(1, Number(ex.sets) || 1);
      for (let s = 1; s <= totalSets; s++) {
        plan.sets.push({
          kind: 'main', ex, exIdx, set: s, totalSets,
          voiceIntro: ex.voice_intro, restSeconds: Number(ex.rest_seconds) || 60,
        });
      }
    });
    return plan;
  }

  // ─── 显示 overlay ──────────────────────────────────────────
  function showOverlay() {
    const ov = $('training-overlay');
    ov.removeAttribute('hidden');
    ov.style.cssText = `
      position: fixed; top: 0; left: 0;
      width: 100vw; height: 100vh;
      z-index: 99999;
      display: flex; flex-direction: column;
      background: #14110F;
      overflow: hidden;
      text-align: center;
    `;
    document.body.style.overflow = 'hidden';
  }

  // ─── 打开 ─────────────────────────────────────────────────
  function open(day, opts = {}) {
    if (!day || !(day.exercises || []).length) {
      showToast('今天没有动作可练。');
      return;
    }
    const plan = normalizePlan(day);
    const firstStage = plan.hasWarmup ? 'warmup' : 'main';
    state = {
      plan,
      stage: firstStage,
      planId: opts.planId || null,
      dayNumber: opts.dayNumber || null,
      muted: false,
      speedScale: 1.0,
      bgmVolume: 0.18,
      bgmEnabled: true,
      currentSetIdx: 0,
      restRemaining: 0,
      voiceEnabled: false,
      lastAnchorSpoken: null,
      lastRepBoundarySpoken: 0,
      paused: false,
      pausedAtTick: 0,
      pausedPhases: null,
      pausedTotalReps: 0,
      dayTitle: activeDayTitle(),
    };
    state.engine = new BeatEngine();
    state.engine.onTick(onTick);
    state.engine.onVoice(onVoice);
    state.engine.onEnd(() => { if (state) onStageTickEnd(); });

    showOverlay();
    if (state.bgmEnabled) startBgm();
    if (state.stage === 'warmup') {
      renderWarmup();
      // 串行:先播 warmup_intro + LLM detail 描述,等播完再开始 phase tick
      warmupIntroThenRun(plan);
    } else {
      enterMainSet(0);
    }
  }

  // 串行化 warmup intro + 倒计时:先 "准备开始" mp3 + LLM 详细 intro,等结束,再 3-2-1-GO,再 phase tick
  async function warmupIntroThenRun(plan) {
    playClip('warmup_intro');  // 真人 mp3 "准备开始"
    await awaitClipEnd('warmup_intro', 3000);
    if (plan.warmup.intro) {
      speak(plan.warmup.intro, 'warmup-detail', 'warmup');
      await awaitTtsEnd(plan.warmup.intro, 5000);
    }
    // 3-2-1-GO 倒计时(让用户知道热身正式开始)
    await warmupCountdown();
    runStage('warmup');
  }

  // warmup 阶段开始前的 3-2-1-GO 视觉倒计时
  async function warmupCountdown() {
    const ov = $('training-overlay');
    const numEl = ov.querySelector('.train__beat-num');
    const phaseEl = ov.querySelector('.train__phase');
    const tipEl = ov.querySelector('.train__tip');
    for (const n of [3, 2, 1]) {
      if (numEl) { numEl.textContent = String(n); setPulse(numEl); }
      if (phaseEl) phaseEl.textContent = '准备';
      if (tipEl) tipEl.textContent = `第 ${n} 秒`;
      playClip(`prep_${n}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (numEl) { numEl.textContent = 'GO'; setPulse(numEl); }
    if (phaseEl) phaseEl.textContent = '开始';
    playClip('start');
    await new Promise((r) => setTimeout(r, 700));
  }

  // 串行化 cooldown intro:等播完再 3-2-1-GO 再 phase tick
  async function cooldownIntroThenRun(plan) {
    playClip('cooldown_intro');
    await awaitClipEnd('cooldown_intro', 3000);
    if (plan.cooldown.intro) {
      speak(plan.cooldown.intro, 'cooldown-detail', 'cooldown');
      await awaitTtsEnd(plan.cooldown.intro, 5000);
    }
    await warmupCountdown();  // 复用倒计时显示逻辑
    runStage('cooldown');
  }

  function close() {
    if (state) {
      if (state.engine) state.engine.stop();
      if (state.restTimer) { clearInterval(state.restTimer); state.restTimer = null; }
      if (state.prepTimer) { clearTimeout(state.prepTimer); state.prepTimer = null; }
    }
    stopBgm();
    const ov = $('training-overlay');
    if (ov) {
      ov.hidden = true;
      ov.innerHTML = '';
      ov.style.cssText = '';
    }
    document.body.style.overflow = '';
    state = null;
  }

  // ─── 阶段切换 ─────────────────────────────────────────────
  function enterMainSet(setIdx) {
    state.currentSetIdx = setIdx;
    state.lastAnchorSpoken = null;
    state.lastRepBoundarySpoken = 0;
    state.paused = false;
    state.pausedAtTick = 0;
    state.stage = 'prep';
    const set = state.plan.sets[setIdx];
    const isFirstOfExercise = setIdx === 0 || state.plan.sets[setIdx - 1].exIdx !== set.exIdx;
    renderMain();
    // 异步 — 等 voice_intro 播完才进 3-2-1
    showPrepCountdown(set, isFirstOfExercise).catch((e) => console.warn('[sport] prep error:', e));
  }

  // 3-2-1 GO 倒计时,然后才启动 engine
  // isFirstOfExercise 时:speak voice_intro + 第一 phase 的技术要点,等播完(或 8s 超时),再开始 3-2-1
  async function showPrepCountdown(set, isFirstOfExercise) {
    const ov = $('training-overlay');
    const numEl = ov.querySelector('.train__beat-num');
    const phaseEl = ov.querySelector('.train__phase');
    const tipEl = ov.querySelector('.train__tip');
    if (isFirstOfExercise && set.voiceIntro) {
      if (numEl) { numEl.textContent = '准备'; setPulse(numEl); }
      if (phaseEl) phaseEl.textContent = set.ex.name || '';
      // 拼 voice_intro + 第一个 phase 的技术要点("这个动作要点:慢下快推")
      const firstTip = set.ex.phases?.[0]?.tip;
      const fullIntro = firstTip
        ? `${set.voiceIntro},动作要点,${firstTip}`
        : set.voiceIntro;
      if (tipEl) tipEl.textContent = fullIntro;
      speak(fullIntro, 'voice-intro', `set${state.currentSetIdx}:intro`);
      // 等语音完整播完 — 设长一点超时(8s)避免被截断
      await awaitTtsEnd(fullIntro, 8000);
    }
    startCountdown();

    function startCountdown() {
      let count = 3;
      const tick = () => {
        if (count > 0) {
          if (numEl) { numEl.textContent = String(count); setPulse(numEl); }
          if (phaseEl) phaseEl.textContent = `第 ${set.set} 组`;
          if (tipEl) tipEl.textContent = isFirstOfExercise ? set.voiceIntro : '继续';
          speak(`prep_${count}`, 'prep', `set${state.currentSetIdx}:prep${count}`);
          count--;
          state.prepTimer = setTimeout(tick, 1000);
        } else {
          if (numEl) { numEl.textContent = 'GO'; setPulse(numEl); }
          if (phaseEl) phaseEl.textContent = '开始';
          speak('start', 'prep', `set${state.currentSetIdx}:go`);
          state.prepTimer = setTimeout(() => {
            state.stage = 'main-set';
            runStage('main-set', set.ex.phases, set.ex.repsNum);
            state.prepTimer = null;
          }, 700);
        }
      };
      tick();
    }
  }

  function enterRest() {
    state.stage = 'rest';
    const set = state.plan.sets[state.currentSetIdx];
    state.restRemaining = Math.max(5, set.restSeconds || 60);
    renderRest();
    // 播 3 段:完成本组 → 休息 → 下一个动作(voice 链)
    playClip('rest_done');
    setTimeout(() => playClip('rest'), 1000);
    const nextSet = state.plan.sets[state.currentSetIdx + 1];
    if (nextSet) {
      const head = nextSet.exIdx === set.exIdx
        ? `下一组,${nextSet.ex.name}`
        : `下一个动作,${nextSet.ex.name}`;
      setTimeout(() => speak(head, 'next-full', `set${state.currentSetIdx}:next`), 2000);
    } else if (state.plan.hasCooldown) {
      setTimeout(() => playClip('cooldown_intro'), 2000);
    } else {
      setTimeout(() => speak('今天练完啦', 'next-full', 'final'), 2000);
    }
    if (state.restTimer) clearInterval(state.restTimer);
    state.restTimer = setInterval(() => {
      state.restRemaining -= 1;
      const numEl = $('training-overlay').querySelector('.train__rest-num');
      if (numEl) numEl.textContent = String(state.restRemaining);
      if (state.restRemaining <= 0) {
        clearInterval(state.restTimer);
        state.restTimer = null;
        finishRest();
      }
    }, 1000);
  }

  function finishRest() {
    const nextIdx = state.currentSetIdx + 1;
    if (nextIdx >= state.plan.sets.length) {
      enterCooldown();
    } else {
      enterMainSet(nextIdx);
    }
  }

  function enterCooldown() {
    state.stage = 'cooldown';
    if (state.plan.hasCooldown) {
      renderCooldown();
      // 串行:先 mp3 + LLM detail intro 说完再 phase tick
      cooldownIntroThenRun(state.plan).catch((e) => console.warn('[sport] cooldown error:', e));
    } else {
      enterDone();
    }
  }

  function enterDone() {
    state.stage = 'done';
    if (state.engine) state.engine.stop();
    if (state.restTimer) { clearInterval(state.restTimer); state.restTimer = null; }
    renderDone();
    const totalSets = state.plan.sets.length;
    speak('workout_done', 'done', 'done');
  }

  function skipRest() {
    if (state.stage !== 'rest') return;
    if (state.restTimer) { clearInterval(state.restTimer); state.restTimer = null; }
    finishRest();
  }

  function skipPrep() {
    if (state.stage !== 'prep') return;
    if (state.prepTimer) { clearTimeout(state.prepTimer); state.prepTimer = null; }
    const set = state.plan.sets[state.currentSetIdx];
    state.stage = 'main-set';
    runStage('main-set', set.ex.phases, set.ex.repsNum);
  }

  // ─── 引擎触发 ─────────────────────────────────────────────
  function runStage(stage, phases, totalReps) {
    let localPhases, reps;
    if (stage === 'warmup') {
      localPhases = state.plan.warmup.phases;
      reps = 1;
    } else if (stage === 'cooldown') {
      localPhases = state.plan.cooldown.phases;
      reps = 1;
    } else {
      localPhases = phases;
      reps = totalReps;
    }
    state.engine.start(localPhases, reps, state.speedScale);
  }

  function onStageTickEnd() {
    // engine 跑完当前阶段的所有 tick
    if (state.stage === 'warmup') {
      enterMainSet(0);
    } else if (state.stage === 'main-set') {
      enterRest();
    } else if (state.stage === 'cooldown') {
      enterDone();
    }
  }

  // ─── tick 回调 ────────────────────────────────────────────
  function onTick(item, total) {
    if (!state) return;
    const ov = $('training-overlay');
    if (state.stage === 'warmup') {
      onTickWarmup(ov, item);
    } else if (state.stage === 'main-set') {
      onTickMain(ov, item);
    } else if (state.stage === 'cooldown') {
      onTickCooldown(ov, item);
    }
  }

  function setPulse(el) {
    if (!el) return;
    el.classList.remove('is-pulse');
    void el.offsetWidth;
    el.classList.add('is-pulse');
  }

  // 跨阶段 voice 状态追踪:每次新 phase 进入时播报"第 N 个动作,XX,开始"
  function sayPhaseStart(prefix, phaseName, indexInRep, tickType) {
    if (state[`_last_${tickType}PhaseIdx`] === indexInRep) return;
    state[`_last_${tickType}PhaseIdx`] = indexInRep;
    const idx = indexInRep + 1;
    speak(`第 ${idx} ${prefix},${phaseName},开始`, tickType, `phase:${tickType}:${indexInRep}`);
  }

  function onTickWarmup(ov, item) {
    const phaseEl = ov.querySelector('.train__phase');
    if (phaseEl) { phaseEl.textContent = item.phase; setPulse(phaseEl); }
    const tipEl = ov.querySelector('.train__tip');
    if (tipEl) tipEl.textContent = item.tip || '';
    updateBarProgress(ov, item);
    // 切换媒体 — 优先 mp4 动画,fallback SVG (陆伊咱们手工),再 fallback LLM gif
    const phase = state.plan.warmup.phases[item.indexInRep];
    const srcObj = state.plan.phaseImage(phase);
    const mediaWrap = ov.querySelector('.train__media-wrap');
    if (mediaWrap && srcObj && typeof srcObj === 'object') {
      const sig = `${srcObj.primary}|${srcObj.fallback}`;
      if (mediaWrap.dataset.sig !== sig) {
        setMediaSrc(mediaWrap, srcObj.primary, srcObj.fallback, item.tip);
        mediaWrap.dataset.sig = sig;
      }
    }
    // 同步 head 标题
    const head = ov.querySelector('.train__head');
    if (head) {
      const headText = `热身 · ${item.phase}`;
      if (head.firstChild?.textContent !== headText) {
        head.firstChild.textContent = headText;
      }
    }
    // 每个 phase 切换都报一次("第 1 个动作..." / "第 2 个动作...")
    sayPhaseStart('个动作', item.phase, item.indexInRep, 'warmup');
  }

  function onTickCooldown(ov, item) {
    const phaseEl = ov.querySelector('.train__phase');
    if (phaseEl) { phaseEl.textContent = item.phase; setPulse(phaseEl); }
    const tipEl = ov.querySelector('.train__tip');
    if (tipEl) tipEl.textContent = item.tip || '';
    updateBarProgress(ov, item);
    const phase = state.plan.cooldown.phases[item.indexInRep];
    const srcObj = state.plan.phaseImage(phase);
    const mediaWrap = ov.querySelector('.train__media-wrap');
    if (mediaWrap && srcObj && typeof srcObj === 'object') {
      const sig = `${srcObj.primary}|${srcObj.fallback}`;
      if (mediaWrap.dataset.sig !== sig) {
        setMediaSrc(mediaWrap, srcObj.primary, srcObj.fallback, item.tip);
        mediaWrap.dataset.sig = sig;
      }
    }
    sayPhaseStart('个拉伸', item.phase, item.indexInRep, 'cooldown');
  }

  function updateBarProgress(ov, item) {
    ov.querySelectorAll('.train__seg').forEach((s) => s.classList.remove('is-active'));
    const seg = ov.querySelector(`.train__seg[data-phase-index="${item.indexInRep}"]`);
    if (seg) seg.classList.add('is-active');
  }

  function onTickMain(ov, item) {
    const numEl = ov.querySelector('.train__beat-num');
    if (numEl) {
      numEl.textContent = String(item.rep);
      setPulse(numEl);
    }
    const phaseEl = ov.querySelector('.train__phase');
    if (phaseEl) { phaseEl.textContent = item.phase; setPulse(phaseEl); }
    const tipEl = ov.querySelector('.train__tip');
    if (tipEl) tipEl.textContent = item.tip || '';
    updateBarProgress(ov, item);
    if (item.isRepBoundary) {
      const dotsEl = ov.querySelector('.train__rep-dots');
      if (dotsEl) {
        const dots = dotsEl.querySelectorAll('.train__rep-dot');
        if (dots[item.rep - 1]) dots[item.rep - 1].classList.add('is-done');
      }
    }
    // 每 rep 起报数 — Keep 风格: mp3 真人数字"第 N 个"
    if (item.isFirstInRep) {
      const key = `set${state.currentSetIdx}:rep${item.rep}`;
      if (item.rep === state.repsNum) speak('last_one', 'rep', key);
      else if (item.rep >= 1 && item.rep <= 12) speak(`n_${item.rep}`, 'rep', key);
    }
  }

  // ─── voice 回调 ────────────────────────────────────────────
  function onVoice(ev) {
    if (!ev || !state) return;
    // phase-anchor 删除 — 不再在 phase 上说碎词
    if (ev.kind === 'rep-boundary') {
      const total = ev.total;
      const r = ev.rep;
      if (total <= 2) return;
      const setKey = `set${state.currentSetIdx}`;
      if (r === Math.ceil(total / 2) && r > 1) {
        speak('half', 'mid', `${setKey}:mid`);
      } else if (r === total - 1) {
        speak('last_two', 'last2', `${setKey}:last2`);
      }
      // 普通 rep 的"1、2、3、4..."由 onTickMain 在 rep-start 时报数
    }
  }

  // ─── 渲染 warmup ──────────────────────────────────────────
  function renderWarmup() {
    const ov = $('training-overlay');
    ov.innerHTML = '';
    const phases = state.plan.warmup.phases;
    const firstEx = state.plan.exercises[0];
    // 用第一个 warmup phase 的动图(LLM 选好的对应动作)
    const fallback = firstEx?.gif_cdn || firstEx?.image_cdn || '';
    const warmupMedia = state.plan.phaseImage(phases[0]) || fallback;
    const warmupVoice = state.plan.warmup.intro || '';

    const head = $e('header', 'train__head');
    const stageEl = $e('div', '', '');
    stageEl.innerHTML = `<span style="color:#C04A2C">热身</span> · ${phases[0]?.name || ''}`;
    head.appendChild(stageEl);
    const closeBtn = $e('button', 'train__close', '✕');
    closeBtn.addEventListener('click', close);
    head.appendChild(closeBtn);
    ov.appendChild(head);

    const main = $e('main', 'train__main');

    const mediaWrap = $e('div', 'train__media-wrap');
    if (warmupMedia && typeof warmupMedia === 'object') {
      setMediaSrc(mediaWrap, warmupMedia.primary, warmupMedia.fallback, phases[0]?.tip);
    } else if (typeof warmupMedia === 'string' && warmupMedia) {
      setMediaSrc(mediaWrap, warmupMedia, '', phases[0]?.tip);
    } else {
      // 没图:显示引导框
      setMediaSrc(mediaWrap, '', '', phases[0]?.tip);
    }
    main.appendChild(mediaWrap);

    const info = $e('div', 'train__info');
    info.appendChild($e('div', 'train__name', '热身 · 准备开始'));
    const setDiv = $e('div', 'train__set');
    setDiv.innerHTML = `<span style="color:#C04A2C">即将练</span> <strong>${firstEx?.name || ''}</strong>`;
    info.appendChild(setDiv);

    const bar = $e('div', 'train__bar');
    phases.forEach((p, i) => {
      const seg = $e('div', 'train__seg');
      seg.dataset.phaseIndex = String(i);
      seg.style.flexGrow = String(Number(p.sec) || 1);
      if (i === 0) seg.classList.add('is-active');
      bar.appendChild(seg);
    });
    info.appendChild(bar);

    const phaseWrap = $e('div', 'train__phase-wrap');
    phaseWrap.appendChild($e('span', 'train__phase', phases[0].name));
    info.appendChild(phaseWrap);

    info.appendChild($e('div', 'train__tip', warmupVoice || phases[0].tip || ''));

    const preface = $e('div', 'train__hint', `动作要点:${firstEx?.voice_intro || ''}`);
    info.appendChild(preface);

    main.appendChild(info);
    ov.appendChild(main);

    const footer = $e('footer', 'train__footer');
    const cta = $e('div', 'train__cta');
    const skipBtn = $e('button', 'train__back', '跳过热身 →');
    skipBtn.addEventListener('click', () => {
      if (state.engine) state.engine.stop();
      enterMainSet(0);
    });
    cta.appendChild(skipBtn);
    footer.appendChild(cta);
    ov.appendChild(footer);
  }

  // ─── 渲染 main ────────────────────────────────────────────
  function renderMain() {
    try {
      const ov = $('training-overlay');
      ov.innerHTML = '';
      const set = state.plan.sets[state.currentSetIdx];
      const ex = set.ex;
      const media = ex.gif_cdn || ex.image_cdn || '';
      const phases = ex.phases;
      const repsNum = set.ex.repsNum;
      const totalSec = phases.reduce((s, p) => s + Number(p.sec), 0);

      // head
      const head = $e('header', 'train__head');
      const progWrap = $e('div', 'train__progress');
      progWrap.appendChild($e('span', 'train__progress-num', String(state.currentSetIdx + 1)));
      progWrap.appendChild($e('span', 'train__progress-sep', '/'));
      progWrap.appendChild($e('span', 'train__progress-total', String(state.plan.sets.length)));
      progWrap.appendChild($e('span', 'train__progress-day', '· ' + state.dayTitle));
      head.appendChild(progWrap);
      const closeBtn = $e('button', 'train__close', '✕');
      closeBtn.addEventListener('click', close);
      head.appendChild(closeBtn);
      ov.appendChild(head);

      // main
      const main = $e('main', 'train__main');

      const mediaWrap = $e('div', 'train__media-wrap');
      if (media) {
        setMediaSrc(mediaWrap, media, '');
      } else {
        const ph = $e('div', 'train__media train__media--placeholder', '无图');
        mediaWrap.appendChild(ph);
      }
      main.appendChild(mediaWrap);

      const info = $e('div', 'train__info');
      info.appendChild($e('div', 'train__name', ex.name || ''));
      const setDiv = $e('div', 'train__set');
      setDiv.innerHTML = `第 <strong>${String(set.set).padStart(2, '0')}</strong> / ${String(set.totalSets).padStart(2, '0')} 组`;
      info.appendChild(setDiv);

      // segmented bar
      const bar = $e('div', 'train__bar');
      phases.forEach((p, i) => {
        const seg = $e('div', 'train__seg');
        seg.dataset.phaseIndex = String(i);
        seg.style.flexGrow = String(Number(p.sec) || 1);
        seg.title = p.name;
        if (i === 0) seg.classList.add('is-active');
        bar.appendChild(seg);
      });
      info.appendChild(bar);

      const phaseWrap = $e('div', 'train__phase-wrap');
      const phaseEl = $e('span', 'train__phase', phases[0].name);
      phaseWrap.appendChild(phaseEl);
      info.appendChild(phaseWrap);

      info.appendChild($e('div', 'train__tip', phases[0].tip || ''));

      const numWrap = $e('div', 'train__num-wrap');
      numWrap.appendChild($e('span', 'train__beat-num', '1'));
      numWrap.appendChild($e('span', 'train__beat-total', ` / ${repsNum}`));
      info.appendChild(numWrap);

      const dots = $e('div', 'train__rep-dots');
      for (let i = 0; i < repsNum; i++) dots.appendChild($e('span', 'train__rep-dot'));
      info.appendChild(dots);

      const hint = $e('div', 'train__hint', `${phases.length} 步 × ${totalSec.toFixed(1)} 秒 · 休息 ${set.restSeconds || '?'}s`);
      info.appendChild(hint);

      main.appendChild(info);
      ov.appendChild(main);

      // footer
      const footer = $e('footer', 'train__footer');
      footer.appendChild(renderTempoControls(totalSec));
      footer.appendChild(renderCTA());
      ov.appendChild(footer);

      console.log('[sport] renderMain ok, set', set.set, ex.name, 'reps=', repsNum);
    } catch (e) {
      console.error('[sport] renderMain failed:', e);
      showToast('训练渲染失败:' + e.message);
    }
  }

  // ─── 渲染 rest ────────────────────────────────────────────
  function renderRest() {
    const ov = $('training-overlay');
    ov.innerHTML = '';
    const set = state.plan.sets[state.currentSetIdx];
    const nextSet = state.plan.sets[state.currentSetIdx + 1];
    const head = $e('header', 'train__head');
    const progWrap = $e('div', 'train__progress');
    progWrap.appendChild($e('span', 'train__progress-num', String(state.currentSetIdx + 1)));
    progWrap.appendChild($e('span', 'train__progress-sep', '/'));
    progWrap.appendChild($e('span', 'train__progress-total', String(state.plan.sets.length)));
    progWrap.appendChild($e('span', 'train__progress-day', '· 休息'));
    head.appendChild(progWrap);
    const closeBtn = $e('button', 'train__close', '✕');
    closeBtn.addEventListener('click', close);
    head.appendChild(closeBtn);
    ov.appendChild(head);

    const main = $e('main', 'train__main train__main--rest');
    main.appendChild($e('div', 'train__rest-eyebrow', `休息 · ${set.ex.name || ''}`));
    main.appendChild($e('div', 'train__rest-num', String(state.restRemaining)));
    main.appendChild($e('div', 'train__rest-unit', '秒'));
    const preview = nextSet
      ? (nextSet.exIdx === set.exIdx
          ? `下一组:第 ${nextSet.set} / ${nextSet.totalSets} 组`
          : `下一个:${nextSet.ex.name || ''}`)
      : (state.plan.hasCooldown ? '然后:拉伸' : '然后:完成');
    main.appendChild($e('div', 'train__tip', preview));
    ov.appendChild(main);

    const footer = $e('footer', 'train__footer');
    const cta = $e('div', 'train__cta');
    const skipBtn = $e('button', 'train__skip', '跳过休息 →');
    skipBtn.addEventListener('click', skipRest);
    cta.appendChild(skipBtn);
    footer.appendChild(cta);
    ov.appendChild(footer);
  }

  // ─── 渲染 cooldown ────────────────────────────────────────
  function renderCooldown() {
    const ov = $('training-overlay');
    ov.innerHTML = '';
    const phases = state.plan.cooldown.phases;
    const head = $e('header', 'train__head');
    const stageEl = $e('div', '', '');
    stageEl.innerHTML = `<span style="color:#C04A2C">拉伸</span> · ${state.dayTitle}`;
    head.appendChild(stageEl);
    const closeBtn = $e('button', 'train__close', '✕');
    closeBtn.addEventListener('click', close);
    head.appendChild(closeBtn);
    ov.appendChild(head);

    const main = $e('main', 'train__main train__main--rest');
    main.appendChild($e('div', 'train__rest-eyebrow', '冷身拉伸'));
    const numWrap = $e('div', 'train__num-wrap', '');
    numWrap.appendChild($e('span', 'train__phase', phases[0].name));
    main.appendChild(numWrap);

    const bar = $e('div', 'train__bar');
    phases.forEach((p, i) => {
      const seg = $e('div', 'train__seg');
      seg.dataset.phaseIndex = String(i);
      seg.style.flexGrow = String(Number(p.sec) || 1);
      if (i === 0) seg.classList.add('is-active');
      bar.appendChild(seg);
    });
    main.appendChild(bar);

    main.appendChild($e('div', 'train__tip', phases[0].tip || ''));
    ov.appendChild(main);

    const footer = $e('footer', 'train__footer');
    const cta = $e('div', 'train__cta');
    const skipBtn = $e('button', 'train__back', '跳过拉伸 →');
    skipBtn.addEventListener('click', () => {
      if (state.engine) state.engine.stop();
      enterDone();
    });
    cta.appendChild(skipBtn);
    footer.appendChild(cta);
    ov.appendChild(footer);
  }

  // ─── 渲染 done ────────────────────────────────────────────
  function renderDone() {
    const ov = $('training-overlay');
    ov.innerHTML = '';
    const totalSets = state.plan.sets.length;
    const head = $e('header', 'train__head');
    head.appendChild($e('span', '', '🎉 完成'));
    const closeBtn = $e('button', 'train__close', '✕');
    closeBtn.addEventListener('click', close);
    head.appendChild(closeBtn);
    ov.appendChild(head);

    const main = $e('main', 'train__main train__main--done');
    main.appendChild($e('div', 'train__done-mark', '✓'));
    main.appendChild($e('h1', 'train__done-title', '训练完成'));
    main.appendChild($e('p', 'train__done-sub', `今天一共 ${totalSets} 组。`));
    ov.appendChild(main);

    const footer = $e('footer', 'train__footer');
    footer.appendChild(renderCheckinCTA());
    ov.appendChild(footer);
  }

  function renderCheckinCTA() {
    const wrap = $e('div', 'train__cta');
    const checkinBtn = $e('button', 'train__checkin', '✓ 直接打卡');
    checkinBtn.addEventListener('click', async () => {
      if (state.planId && state.dayNumber) {
        checkinBtn.disabled = true;
        checkinBtn.textContent = '打卡中…';
        try {
          const r = await fetch(`/api/plans/${state.planId}/check-in`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ day_number: state.dayNumber }),
          });
          if (r.ok) {
            speak('打卡成功');
            close();
            showToast(`第 ${String(state.dayNumber).padStart(2, '0')} 天已打卡。`);
            return;
          }
        } catch (e) {
          console.warn('[sport] check-in failed:', e);
        }
        checkinBtn.disabled = false;
        checkinBtn.textContent = '✓ 直接打卡';
      }
      close();
      speak('请记得打卡');
      showToast('记得手动点下面的「完成今天」打卡。');
    });
    wrap.appendChild(checkinBtn);
    return wrap;
  }

  function renderCTA() {
    const cta = $e('div', 'train__cta');
    const backBtn = $e('button', 'train__back', '← 上一组');
    if (state.currentSetIdx === 0) backBtn.disabled = true;
    backBtn.addEventListener('click', () => {
      if (state.engine) state.engine.stop();
      if (state.currentSetIdx > 0) enterMainSet(state.currentSetIdx - 1);
    });
    cta.appendChild(backBtn);

    // ⏸ / ▶ 暂停 / 继续
    const pauseBtn = $e('button', 'train__pause', state.paused ? '▶ 继续' : '⏸ 暂停');
    pauseBtn.addEventListener('click', togglePause);
    cta.appendChild(pauseBtn);

    const doneBtn = $e('button', 'train__done', '完成本组 →');
    doneBtn.addEventListener('click', () => {
      if (state.engine) state.engine.stop();
      enterRest();
    });
    cta.appendChild(doneBtn);
    return cta;
  }

  function togglePause() {
    if (!state || !state.engine) return;
    if (state.stage !== 'main-set') return;
    if (state.paused) {
      // 续:从 pausedAtTick 续跑
      state.engine.resume(state.pausedPhases, state.pausedTotalReps, state.speedScale, state.pausedAtTick);
      state.paused = false;
      state.pausedAtTick = 0;
      // 按钮文字
      const btn = document.querySelector('.train__pause');
      if (btn) btn.textContent = '⏸ 暂停';
    } else {
      // 暂停:记 tick,记当前 phases
      const set = state.plan.sets[state.currentSetIdx];
      state.pausedPhases = set.ex.phases;
      state.pausedTotalReps = set.ex.repsNum;
      state.pausedAtTick = state.engine.pause();
      state.paused = state.pausedAtTick !== null;
      const btn = document.querySelector('.train__pause');
      if (btn) btn.textContent = '▶ 继续';
    }
  }

  // ─── 速度控制 ──────────────────────────────────────────────
  const SPEED_PRESETS = [
    { label: '慢', scale: 1.5 },
    { label: '中', scale: 1.0 },
    { label: '快', scale: 0.7 },
  ];

  function renderTempoControls(repSec) {
    const wrap = $e('div', 'train__tempo');
    const presets = $e('div', 'train__tempo-presets');
    SPEED_PRESETS.forEach((p) => {
      const btn = $e('button', 'train__tempo-preset' + (Math.abs(state.speedScale - p.scale) < 0.01 ? ' is-active' : ''), p.label);
      btn.dataset.scale = String(p.scale);
      btn.addEventListener('click', () => {
        state.speedScale = p.scale;
        restartCurrentStage();
        updateSpeedUI(repSec);
      });
      presets.appendChild(btn);
    });
    wrap.appendChild(presets);

    const sliderRow = $e('div', 'train__speed-row');
    const slider = $e('input', 'train__speed-slider');
    slider.type = 'range';
    slider.min = '0.5';
    slider.max = '2.5';
    slider.step = '0.05';
    slider.value = String(state.speedScale);
    slider.addEventListener('input', () => {
      state.speedScale = Number(slider.value);
      const scaled = repSec * state.speedScale;
      const label = $('training-overlay').querySelector('.train__speed-label');
      if (label) label.textContent = `×${state.speedScale.toFixed(2)} (${scaled.toFixed(1)}s/次)`;
      updatePresetActive();
    });
    slider.addEventListener('change', () => restartCurrentStage());
    sliderRow.appendChild(slider);
    const scaled = repSec * state.speedScale;
    sliderRow.appendChild($e('span', 'train__speed-label', `×${state.speedScale.toFixed(2)} (${scaled.toFixed(1)}s/次)`));
    wrap.appendChild(sliderRow);

    const switchRow = $e('div', 'train__switch-row');
    const muteBtn = $e('button', 'train__mute' + (state.muted ? ' is-on' : ''), state.muted ? '🔇 静' : '🔊 响');
    muteBtn.addEventListener('click', () => {
      state.muted = !state.muted;
      state.engine.setMuted(state.muted);
      muteBtn.textContent = state.muted ? '🔇 静' : '🔊 响';
      muteBtn.classList.toggle('is-on', state.muted);
    });
    switchRow.appendChild(muteBtn);

    const musicBtn = $e('button', 'train__music' + (state.bgmEnabled ? ' is-on' : ''), state.bgmEnabled ? '🎵 乐' : '🔕 静');
    musicBtn.addEventListener('click', () => {
      state.bgmEnabled = !state.bgmEnabled;
      if (state.bgmEnabled) {
        startBgm();
        musicBtn.textContent = '🎵 乐';
      } else {
        stopBgm();
        musicBtn.textContent = '🔕 静';
      }
      musicBtn.classList.toggle('is-on', state.bgmEnabled);
    });
    switchRow.appendChild(musicBtn);

    const voiceBtn = $e('button', 'train__voice' + (_voiceEnabled ? ' is-on' : ''), _voiceEnabled ? '🗣️ 念' : '🤐 不念');
    voiceBtn.addEventListener('click', () => {
      _voiceEnabled = !_voiceEnabled;
      voiceBtn.textContent = _voiceEnabled ? '🗣️ 念' : '🤐 不念';
      voiceBtn.classList.toggle('is-on', _voiceEnabled);
      if (_voiceEnabled) speak('语音播报已开启');
    });
    switchRow.appendChild(voiceBtn);
    wrap.appendChild(switchRow);

    return wrap;
  }

  function restartCurrentStage() {
    if (!state) return;
    if (state.stage === 'main-set') {
      const set = state.plan.sets[state.currentSetIdx];
      runStage('main-set', set.ex.phases, set.ex.repsNum);
      // 重置视觉
      const ov = $('training-overlay');
      ov.querySelectorAll('.train__rep-dot').forEach((d) => d.classList.remove('is-done'));
      const numEl = ov.querySelector('.train__beat-num');
      if (numEl) numEl.textContent = '1';
      const phaseEl = ov.querySelector('.train__phase');
      if (phaseEl) phaseEl.textContent = set.ex.phases[0].name;
      const tipEl = ov.querySelector('.train__tip');
      if (tipEl) tipEl.textContent = set.ex.phases[0].tip || '';
    } else if (state.stage === 'warmup' || state.stage === 'cooldown') {
      runStage(state.stage);
    }
  }

  function updateSpeedUI(repSec) {
    updatePresetActive();
    const slider = $('training-overlay').querySelector('.train__speed-slider');
    if (slider) slider.value = String(state.speedScale);
    const label = $('training-overlay').querySelector('.train__speed-label');
    if (label) label.textContent = `×${state.speedScale.toFixed(2)} (${(repSec * state.speedScale).toFixed(1)}s/次)`;
  }

  function updatePresetActive() {
    $('training-overlay').querySelectorAll('.train__tempo-presets .train__tempo-preset').forEach((b) => {
      b.classList.toggle('is-active', Math.abs(Number(b.dataset.scale) - state.speedScale) < 0.01);
    });
  }

  window.openTraining = open;

  // ─── 模块加载时 preload bgm(不 play)────────────────────────
  // 让 user 进训练时 audio 已经 buffered
  (function preloadBgm() {
    try {
      const a = ensureBgm();
      a.src = BGM_URLS[0];
      a.load();
    } catch (e) {
      console.warn('[sport] bgm preload failed:', e);
    }
  })();
})();
