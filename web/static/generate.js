/* sport · generate.js
   /generate 页面:输入 → LLM 生成 → 保存到数据库(/api/plans)
*/

(function init() {
  setActiveNav('generate');
  bindSettingsAutoSave();
  loadFilterOptions();

  let currentPlan = null;

  async function loadFilterOptions() {
    const data = await fetch('/api/filters').then((r) => r.json());
    renderChips('target-chips', data.target, 'target');
    renderChips('equipment-chips', data.equipment, 'equipment');
  }

  function renderChips(containerId, values, field) {
    const container = $(containerId);
    if (!container) return;
    container.innerHTML = '';
    values.forEach((v) => {
      const label = document.createElement('label');
      label.className = 'chip';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = v;
      cb.dataset.field = field;
      const span = document.createElement('span');
      const zh = t(field, v);
      span.textContent = (zh === v) ? v : `${zh} (${v})`;
      label.appendChild(cb);
      label.appendChild(span);
      container.appendChild(label);
    });
  }

  function gatherChecked(field) {
    const cbs = document.querySelectorAll(`input[data-field="${field}"]:checked`);
    return Array.from(cbs).map((cb) => cb.value);
  }

  async function generate() {
    const btn = $('generate-btn');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '生成中…';
    const payload = {
      intent: $('intent-input').value.trim() || '练全身',
      days: parseInt($('days-input').value, 10) || 1,
      per_day: parseInt($('per-day-input').value, 10) || 4,
      target: gatherChecked('target'),
      equipment: gatherChecked('equipment'),
      api_key: getSetting('api_key'),
      base_url: getSetting('base_url'),
      model: getSetting('model'),
    };
    console.log('[generate] request:', payload);
    // 弹出"思考过程"浮窗,显示大模型编排的分步骤进度
    const modal = showThinkingModal(payload);
    try {
      const filterDesc = [
        payload.target?.length ? `${payload.target.length} 个目标肌` : null,
        payload.equipment?.length ? `${payload.equipment.length} 种器械` : null,
        payload.intent ? `意图"${payload.intent.slice(0, 20)}${payload.intent.length > 20 ? '…' : ''}"` : null,
      ].filter(Boolean).join(' · ');
      updateStep(modal, 1, 'active', filterDesc || '读取输入');
      updateStep(modal, 2, 'active', `从 1300+ 动作里筛出 ${payload.days * payload.per_day} 组候选`);

      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      updateStep(modal, 2, 'done');
      updateStep(modal, 3, 'active', `请求已发,等待 ${payload.model || 'default'} 返回...`);
      const _t0 = Date.now();
      const _tick = setInterval(() => {
        const sec = Math.round((Date.now() - _t0) / 1000);
        updateStep(modal, 3, 'active', `等待 ${payload.model || 'default'} 返回... (${sec}s,可重试 3 次)`, true);
      }, 1000);
      let rawText = '';
      try { rawText = await res.text(); } catch { /* ignore */ }
      clearInterval(_tick);

      if (res.status === 503) {
        clearInterval(_tick);
        const data = parseMaybe(rawText);
        updateStep(modal, 3, 'error', data.message || '上游 503');
        showToast(data.error === 'model_not_found' ? (data.message || '模型不可用') : `生成失败:${(data.message || rawText).slice(0, 80)}`);
        setTimeout(() => closeThinkingModal(modal), 1500);
        showDebugPanel();
        return;
      }
      if (res.status === 401) {
        clearInterval(_tick);
        const data = parseMaybe(rawText);
        updateStep(modal, 3, 'error', 'API key 无效');
        showToast(data.message || 'API key 无效。');
        setTimeout(() => closeThinkingModal(modal), 1500);
        showDebugPanel();
        return;
      }
      if (!res.ok) {
        clearInterval(_tick);
        const data = parseMaybe(rawText);
        updateStep(modal, 3, 'error', `HTTP ${res.status}`);
        showToast(`生成失败 (${res.status}): ${(data.message || rawText).slice(0, 100)}`);
        setTimeout(() => closeThinkingModal(modal), 1500);
        showDebugPanel();
        return;
      }
      const plan = JSON.parse(rawText);
      updateStep(modal, 3, 'done', `${plan.days?.length || 0} 天,每段动作已编排`);
      updateStep(modal, 4, 'active', '解析 JSON + 注入动作 GIF...');
      // 模拟一点点延迟让用户看到这一步
      await new Promise(r => setTimeout(r, 200));
      currentPlan = plan;
      renderResult(currentPlan);
      const exCount = (plan.days || []).reduce((n, d) => n + (d.exercises?.length || 0), 0);
      updateStep(modal, 4, 'done', `${exCount} 个动作,${plan.days?.length || 0} 天`);
      updateStep(modal, 5, 'done', '计划已就绪');
      showToast('新计划已生成。可保存到数据库。');
      // 1.5s 后自动关闭弹窗,让用户看到完成状态
      setTimeout(() => closeThinkingModal(modal), 1500);
    } catch (err) {
      console.error('[generate] exception:', err);
      showToast(`网络错误:${err.message}`);
      setTimeout(() => closeThinkingModal(modal), 1500);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function parseMaybe(text) {
    try { return JSON.parse(text); } catch { return {}; }
  }

  // ─── 思考过程浮窗 ──────────────────────────────────────────────────────
  const STEPS = [
    { id: 1, icon: '📋', title: '解析你的意图', hint: '读取你输入的训练目标、目标肌、器械偏好' },
    { id: 2, icon: '🔍', title: '从动作库筛选候选', hint: '按目标肌 + 器械从 1300+ 动作里挑出 40 个候选' },
    { id: 3, icon: '🤖', title: '调用大模型编排计划', hint: '把候选 + 你的意图发给大模型,生成热身 / 主训练 / 拉伸' },
    { id: 4, icon: '📝', title: '解析 + 注入动作图', hint: '解析大模型返回的 JSON,把每个动作的 GIF 注入' },
    { id: 5, icon: '🎉', title: '完成', hint: '计划生成完毕,已展示在下方' },
  ];

  function showThinkingModal(payload) {
    closeThinkingModal();
    const overlay = document.createElement('div');
    overlay.className = 'thinking-modal';
    overlay.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'bottom:0',
      'width:100vw', 'height:100vh',
      'margin:0', 'padding:0',
      'background:rgba(10,8,7,0.78)',
      'backdrop-filter:blur(6px)', '-webkit-backdrop-filter:blur(6px)',
      'z-index:9998', 'overflow-y:auto',
      'animation:thinking-modal-fade-in 0.18s ease-out',
    ].join(';');
    // 卡片用 inline style 居中,完全绕开 CSS
    const card = document.createElement('div');
    card.className = 'thinking-modal__card';
    card.style.cssText = [
      'position:absolute',
      'top:50%', 'left:50%',
      'transform:translate(-50%,-50%)',
      'width:540px', 'max-width:calc(100vw - 32px)',
      'max-height:calc(100vh - 32px)',
      'overflow:auto',
      'background:linear-gradient(180deg,#1a1714 0%,#14110f 100%)',
      'border:1px solid rgba(192,74,44,0.32)',
      'border-radius:8px',
      'box-shadow:0 20px 60px rgba(0,0,0,0.6)',
      'color:#F5F2EE', 'padding:24px',
      'box-sizing:border-box',
      'animation:thinking-modal-slide-up 0.22s ease-out',
      'font-family:"Inter",-apple-system,system-ui,sans-serif',
    ].join(';');
    card.innerHTML = `
      <header style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding-bottom:16px;border-bottom:1px solid rgba(245,242,238,0.08);margin-bottom:16px">
        <div style="flex:1;min-width:0">
          <div style="font-family:'Fraunces','Times New Roman',serif;font-style:italic;font-size:18px;color:#C04A2C;margin-bottom:6px">🧠 大模型正在编排你的训练计划</div>
          <div style="font-size:12px;color:rgba(245,242,238,0.55);line-height:1.5">
            意图:<strong style="color:#F5F2EE">${escapeHtml(payload.intent)}</strong> · ${payload.days} 天 × ${payload.per_day} 动作 · model <code style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;padding:1px 6px;background:rgba(192,74,44,0.16);border-radius:3px;color:#E8C9B6">${escapeHtml(payload.model || 'glm-4.5')}</code>
          </div>
        </div>
        <button class="thinking-modal__close" aria-label="关闭" style="background:transparent;border:none;color:rgba(245,242,238,0.5);font-size:24px;cursor:pointer;line-height:1;padding:0;width:28px;height:28px;flex-shrink:0">×</button>
      </header>
      <ol style="list-style:none;padding:0;margin:0 0 16px;display:flex;flex-direction:column;gap:10px">
        ${STEPS.map(s => `
          <li data-step="${s.id}" data-status="pending" style="display:flex;gap:14px;align-items:flex-start;padding:11px 14px;background:rgba(245,242,238,0.03);border:1px solid rgba(245,242,238,0.06);border-radius:5px">
            <span style="font-size:20px;flex-shrink:0;line-height:1;filter:grayscale(60%)">${s.icon}</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:14px;font-weight:500;color:rgba(245,242,238,0.95);margin-bottom:3px">${escapeHtml(s.title)}</div>
              <div style="font-size:12px;color:rgba(245,242,238,0.55);line-height:1.5;word-break:break-word">${escapeHtml(s.hint)}</div>
            </div>
            <span style="flex-shrink:0;font-size:14px;color:rgba(245,242,238,0.35);font-family:'JetBrains Mono',ui-monospace,monospace;min-width:20px;text-align:center">○</span>
          </li>
        `).join('')}
      </ol>
      <footer style="display:flex;justify-content:space-between;align-items:center;padding-top:16px;border-top:1px solid rgba(245,242,238,0.08);gap:16px">
        <div style="font-size:11px;color:rgba(245,242,238,0.4);line-height:1.4">关闭此弹窗不影响生成过程,生成完成后会自动关闭。</div>
        <button class="thinking-modal__close-btn" style="background:transparent;border:1px solid rgba(245,242,238,0.15);color:rgba(245,242,238,0.7);padding:6px 14px;border-radius:4px;font-size:12px;cursor:pointer">关闭</button>
      </footer>
    `;
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.querySelector('.thinking-modal__close').onclick = () => closeThinkingModal(overlay);
    overlay.querySelector('.thinking-modal__close-btn').onclick = () => closeThinkingModal(overlay);
    return overlay;
  }

  function updateStep(modal, id, status, detail, noScroll) {
    if (!modal) return;
    const li = modal.querySelector(`li[data-step="${id}"]`);
    if (!li) return;
    li.dataset.status = status;
    const statusEl = li.querySelector('span:last-child');
    const statusText = status === 'done' ? '✓' : status === 'error' ? '✗' : status === 'active' ? '◐' : '○';
    const statusColor = status === 'done' ? '#7ee787' : status === 'error' ? '#ff7066' : status === 'active' ? '#C04A2C' : 'rgba(245,242,238,0.35)';
    if (statusEl) {
      statusEl.textContent = statusText;
      statusEl.style.color = statusColor;
      if (status === 'active') statusEl.style.animation = 'thinking-step-spin 1.4s linear infinite';
      else statusEl.style.animation = '';
    }
    // icon 第一个 span
    const iconEl = li.querySelector('span:first-child');
    if (iconEl) iconEl.style.filter = (status === 'active' || status === 'done') ? 'grayscale(0)' : 'grayscale(60%)';
    // detail 是第三个 span (status 是最后一个),实际是 div 里的第二个 div
    const detailEl = li.querySelector('div > div:last-child');
    if (detail != null && detailEl) detailEl.textContent = detail;
    // li 背景色
    const bg = status === 'active' ? 'rgba(192,74,44,0.12)' : status === 'done' ? 'rgba(126,231,135,0.08)' : status === 'error' ? 'rgba(255,112,102,0.1)' : 'rgba(245,242,238,0.03)';
    const border = status === 'active' ? 'rgba(192,74,44,0.5)' : status === 'done' ? 'rgba(126,231,135,0.3)' : status === 'error' ? 'rgba(255,112,102,0.4)' : 'rgba(245,242,238,0.06)';
    li.style.background = bg;
    li.style.borderColor = border;
    if (status === 'active' && !noScroll) {
      setTimeout(() => li.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
    }
  }

  function closeThinkingModal(modal) {
    if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    else document.querySelectorAll('.thinking-modal').forEach(m => m.remove());
  }

  function renderResult(plan) {
    $('result').hidden = false;
    $('result-eyebrow').textContent = todayLabel();
    $('result-title').textContent = plan.title || '训练计划';
    $('result-summary').textContent = plan.summary || '';

    const days = plan.days || [];
    renderDayTabs(days, (day) => {
      renderDayHeader(day, 'result-');
      renderDayExercises(day, '#result-exercises');
    }, '#result-day-tabs');
    if (days.length) {
      renderDayHeader(days[0], 'result-');
      renderDayExercises(days[0], '#result-exercises');
    }
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function savePlan() {
    if (!currentPlan) { showToast('先生成一个计划。'); return; }
    const name = currentPlan.title || '未命名计划';
    const res = await fetch('/api/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, plan: currentPlan, make_current: true }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.message || '保存失败。');
      return;
    }
    const result = await res.json();
    showToast(`已保存:${result.plan.name}。跳到计划页面查看。`);
    setTimeout(() => { location.href = '/plan'; }, 800);
  }

  function resetResult() {
    currentPlan = null;
    $('result').hidden = true;
    $('intent-input').value = '';
    showToast('已重置。');
  }

  $('generate-btn').addEventListener('click', generate);
  $('save-btn').addEventListener('click', savePlan);
  $('reset-btn').addEventListener('click', resetResult);
})();


// 调试浮窗:失败时 fetch /api/debug/recent,把最近请求/响应画出来
async function showDebugPanel() {
  let panel = document.getElementById('debug-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'debug-panel';
    panel.style.cssText = 'position:fixed;top:60px;right:20px;width:560px;max-height:70vh;overflow:auto;background:#1a1a1a;color:#f5f2ee;padding:14px;border-radius:6px;font-size:12px;line-height:1.4;z-index:9999;font-family:ui-monospace,Menlo,monospace;box-shadow:0 4px 20px rgba(0,0,0,0.4)';
    document.body.appendChild(panel);
  }
  panel.innerHTML = '<b style="color:#C04A2C">↓ 调试信息(/api/debug/recent)</b><br><span style="color:#888">加载中…</span>';
  try {
    const resp = await fetch('/api/debug/recent');
    const data = await resp.json();
    panel.innerHTML = '<b style="color:#C04A2C">最近 /api/plan 请求/响应</b> ' +
      '<a href="#" id="debug-close" style="color:#888;float:right">关闭</a><hr style="border-color:#333">';
    document.getElementById('debug-close').onclick = (e) => { e.preventDefault(); panel.remove(); };
    const recent = data.recent || [];
    for (const r of recent.slice(-6)) {
      const color = r.kind === 'request' ? '#8ab4ff' : (r.status >= 500 ? '#ff7066' : r.status >= 400 ? '#ffb86c' : '#7ee787');
      panel.innerHTML += `<div style="margin-bottom:12px;padding:8px;background:#0a0a0a;border-left:3px solid ${color}">`;
      panel.innerHTML += `<b style="color:${color}">${r.kind.toUpperCase()} ${r.status || ''}</b> `;
      panel.innerHTML += `<span style="color:#666">${new Date(r.ts*1000).toLocaleTimeString()}</span><br>`;
      panel.innerHTML += `<pre style="margin:6px 0 0;color:#ccc;white-space:pre-wrap;word-break:break-all">${JSON.stringify(r.body, null, 2).replace(/</g, '&lt;')}</pre>`;
      panel.innerHTML += '</div>';
    }
  } catch (e) {
    panel.innerHTML = '<b style="color:#ff7066">调试端点拉取失败:' + e.message + '</b>';
  }
}