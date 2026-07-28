/* sport · plan.js
   /plan 页面:简单视图
   顺序:hero / day tabs / day header / exercises / 开始训练按钮 / check-in / plans-list

   数据全走 SQLite API(迁移脚本跑一次后)。
*/
(function init() {
  setActiveNav('plan');

  let currentPlan = null;
  let currentDayNumber = 1;
  let checkInsByDay = {};
  let plansCache = [];
  let filterMode = 'active';
  let daysCompleted = {};

  // 首次启动:迁移 localStorage → DB
  migrateFromLocalStorage().then(() => loadAll());

  async function migrateFromLocalStorage() {
    try {
      const lsPlans = JSON.parse(localStorage.getItem('sport.plans') || '[]');
      if (!lsPlans.length) return;
      const existing = await fetch('/api/plans?include_archived=true').then(r => r.json());
      if (existing.plans.length) return;
      const currentId = localStorage.getItem('sport.current_plan_id') || '';
      const resp = await fetch('/api/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plans: lsPlans.map((p) => ({
            id: p.id,
            name: p.name,
            plan: p.plan,
            saved_at: p.saved_at,
            is_current: p.id === currentId,
          })),
          check_ins: [],
        }),
      });
      const result = await resp.json();
      if (result.plans_migrated > 0) {
        showToast(`已迁移 ${result.plans_migrated} 个本地计划到数据库。`);
        localStorage.removeItem('sport.plans');
        localStorage.removeItem('sport.current_plan_id');
      }
    } catch (err) {
      console.warn('migrate failed:', err);
    }
  }

  async function loadAll() {
    await Promise.all([loadCurrent(), loadAllPlans()]);
  }

  async function loadCurrent() {
    let { plan, check_ins } = await fetch('/api/plans/current').then(r => r.json());
    if (!plan) {
      const list = await fetch('/api/plans').then(r => r.json());
      if (list.plans && list.plans.length) {
        await fetch(`/api/plans/${list.plans[0].id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ current: true }),
        });
        const retried = await fetch('/api/plans/current').then(r => r.json());
        plan = retried.plan; check_ins = retried.check_ins;
      }
    }
    if (!plan) {
      $('empty').hidden = false;
      $('plan-current').hidden = true;
      return;
    }
    $('empty').hidden = true;
    $('plan-current').hidden = false;
    currentPlan = plan;
    checkInsByDay = {};
    (check_ins || []).forEach((ci) => { checkInsByDay[ci.day_number] = ci; });
    daysCompleted = {};
    Object.keys(checkInsByDay).forEach((d) => { daysCompleted[Number(d)] = true; });

    renderHero(plan, check_ins);
    const days = (plan.plan && plan.plan.days) || [];
    if (!days.length) return;
    renderDayTabs(days, (day) => {
      currentDayNumber = day.day;
      renderDaySummary(day);
      renderDayExercises(day);
      renderCheckInUI();
    });
    renderDaySummary(days[0]);
    renderDayExercises(days[0]);
    currentDayNumber = days[0].day;
    renderCheckInUI();
  }

  function renderHero(plan, check_ins) {
    $('hero-date').textContent = todayLabel();
    $('hero-title').innerHTML = `<em>${escapeHtml(plan.name || '计划')}</em>`;
    $('hero-summary').textContent = (plan.plan && plan.plan.summary) || '';

    const days = (plan.plan && plan.plan.days) || [];
    const total = days.reduce((acc, d) => acc + (d.exercises || []).length, 0);
    const done = (check_ins || []).length;
    const split = (plan.plan && plan.plan.split) || '';

    const parts = [];
    if (split) parts.push(split);
    parts.push(`${days.length} 天`);
    parts.push(`共 ${total} 个动作`);
    parts.push(`${done} / ${days.length} 天已完成`);
    $('hero-meta').textContent = parts.join(' · ');
  }

  function renderDayTabs(days, onSwitch) {
    const tabs = $('day-tabs');
    if (!tabs) return;
    tabs.innerHTML = '';
    days.forEach((day, i) => {
      const btn = document.createElement('button');
      btn.className = 'day-tab' + (i === 0 ? ' is-active' : '');
      btn.type = 'button';
      btn.dataset.day = String(day.day);
      if (daysCompleted[day.day]) btn.dataset.status = 'done';

      const dot = document.createElement('span');
      dot.className = 'day-tab__dot';
      btn.appendChild(dot);

      const label = document.createElement('span');
      label.textContent = day.title || `第${pad2(day.day)}天`;
      btn.appendChild(label);

      btn.addEventListener('click', () => {
        tabs.querySelectorAll('.day-tab').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        onSwitch(day);
      });
      tabs.appendChild(btn);
    });
  }

  function renderDaySummary(day) {
    const sumEl = $('day-summary');
    if (!sumEl) return;
    sumEl.textContent = (day && day.summary) || '';
  }

  function renderDayExercises(day) {
    const container = $('exercises');
    if (!container) return;
    container.innerHTML = '';
    (day.exercises || []).forEach((ex, i) => container.appendChild(renderExerciseRow(ex, i + 1)));
  }

  function renderExerciseRow(ex, n) {
    const row = document.createElement('article');
    row.className = 'exercise';
    row.innerHTML = `
      <div class="exercise__num">${pad2(n)}</div>
      <div class="exercise__body">
        <a class="exercise__name" href="/exercise/${encodeURIComponent(ex.id)}">${escapeHtml(ex.name || '')}</a>
        <div class="exercise__meta">
          <span>${bilingual('target', ex.target)}</span>
          <span>${bilingual('equipment', ex.equipment)}</span>
        </div>
        <div class="exercise__data">
          <strong>${ex.sets ?? '?'}</strong> 组 · <strong>${escapeHtml(String(ex.reps ?? '?'))}</strong> 次 · 休息 <strong>${ex.rest_seconds ?? '?'}</strong>s
        </div>
        ${ex.reason ? `<p class="exercise__reason">${escapeHtml(ex.reason)}</p>` : ''}
      </div>
    `;
    return row;
  }

  function renderCheckInUI() {
    const ci = checkInsByDay[currentDayNumber];
    const btn = $('check-in-btn');
    const status = $('check-in-status');
    const noteInput = $('check-in-note');
    const dayLabel = `第 ${pad2(currentDayNumber)} 天`;
    if (ci) {
      btn.textContent = `✓ ${dayLabel}已完成 · 撤销`;
      btn.classList.add('is-done');
      const dt = new Date(ci.completed_at);
      const dtStr = `${dt.getMonth() + 1}.${dt.getDate()} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
      status.innerHTML = `完成于 ${dtStr}${ci.note ? ` · <em>${escapeHtml(ci.note)}</em>` : ''}`;
      noteInput.value = ci.note || '';
    } else {
      btn.textContent = `完成${dayLabel}`;
      btn.classList.remove('is-done');
      status.textContent = '';
      noteInput.value = '';
    }
  }

  async function doCheckIn() {
    if (!currentPlan) return;
    const ci = checkInsByDay[currentDayNumber];
    const note = $('check-in-note').value.trim();
    if (ci) {
      if (!confirm('撤销这次打卡?')) return;
      await fetch(`/api/plans/${currentPlan.id}/check-in/${currentDayNumber}`, { method: 'DELETE' });
      delete checkInsByDay[currentDayNumber];
      delete daysCompleted[currentDayNumber];
      showToast('已撤销。');
    } else {
      await fetch(`/api/plans/${currentPlan.id}/check-in`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ day_number: currentDayNumber, note: note || null }),
      });
      const ciList = await fetch(`/api/plans/${currentPlan.id}/check-ins`).then(r => r.json());
      checkInsByDay = {};
      ciList.check_ins.forEach((c) => { checkInsByDay[c.day_number] = c; });
      daysCompleted[currentDayNumber] = true;
      showToast('已打卡。');
      const tab = document.querySelector(`.day-tab[data-day="${currentDayNumber}"]`);
      if (tab) tab.dataset.status = 'done';
    }
    renderHero(currentPlan, Object.values(checkInsByDay).map((c) => ({
      completed_at: c.completed_at, plan_id: currentPlan.id, day_number: c.day_number,
    })));
    renderCheckInUI();
    loadAllPlans();
  }

  $('check-in-btn').addEventListener('click', doCheckIn);

  // 开始训练按钮
  $('start-training-btn').addEventListener('click', () => {
    try {
      if (!currentPlan) { showToast('计划还没加载好,再等一下。'); return; }
      const days = (currentPlan.plan && currentPlan.plan.days) || [];
      const day = days.find((d) => d.day === currentDayNumber) || days[0];
      if (!day || !(day.exercises || []).length) {
        showToast('今天没有动作可练。'); return;
      }
      if (typeof openTraining === 'function') {
        openTraining(day, { planId: currentPlan.id, dayNumber: day.day });
      } else {
        showToast('训练模块没加载。硬刷新一下(Cmd+Shift+R)。');
      }
    } catch (e) {
      console.error('[sport] training launch failed:', e);
      showToast('训练启动失败:' + (e && e.message ? e.message : '未知错误'));
    }
  });

  // ─── 全部计划列表 ────────────────────────────────────────────────

  async function loadAllPlans() {
    const include_archived = filterMode !== 'active';
    const { plans } = await fetch(`/api/plans?include_archived=${include_archived}`).then(r => r.json());
    plansCache = plans || [];
    renderPlansList();
  }

  function renderPlansList() {
    const list = $('plans-items');
    let plans = plansCache;
    if (filterMode === 'active') plans = plans.filter((p) => !p.archived_at);
    else if (filterMode === 'archived') plans = plans.filter((p) => p.archived_at);

    if (!plans.length) {
      list.innerHTML = `<li class="plans-list__empty">${
        filterMode === 'archived' ? '没有归档的计划。'
        : filterMode === 'all' ? '还没有任何计划。'
        : '没有激活的计划。'
      }</li>`;
      return;
    }
    list.innerHTML = '';
    plans.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'plan-item' + (p.archived_at ? ' is-archived' : '');
      const dt = new Date(p.created_at);
      const dateStr = `${dt.getFullYear()}.${String(dt.getMonth()+1).padStart(2,'0')}.${String(dt.getDate()).padStart(2,'0')}`;
      const currentTag = p.is_current ? '<span class="plan-item__current">当前</span>' : '';
      const done = p.check_in_count || 0;
      const total = p.day_count || 0;
      li.innerHTML = `
        <div class="plan-item__body">
          <div class="plan-item__name">${escapeHtml(p.name)}${currentTag}</div>
          <div class="plan-item__meta">${dateStr} · ${total} 天 · ${done}/${total} 已完成</div>
        </div>
        <div class="plan-item__actions">
          ${p.archived_at ? `
            <button class="btn-link" data-action="restore" data-id="${p.id}">恢复</button>
            <button class="btn-link btn-link--danger" data-action="delete" data-id="${p.id}">删除</button>
          ` : `
            ${p.is_current ? '<span class="plan-item__current-label">·当前·</span>' : `<button class="btn-link" data-action="set-current" data-id="${p.id}">设为当前</button>`}
            <button class="btn-link" data-action="archive" data-id="${p.id}">归档</button>
            <button class="btn-link btn-link--danger" data-action="delete" data-id="${p.id}">删除</button>
          `}
        </div>
      `;
      list.appendChild(li);
    });
    list.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => handleAction(btn.dataset.action, btn.dataset.id));
    });
  }

  async function handleAction(action, id) {
    if (action === 'set-current') {
      await fetch(`/api/plans/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current: true }),
      });
      showToast('已设为当前计划。');
      await loadAll();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (action === 'archive') {
      if (!confirm('归档这个计划?(可从归档恢复)')) return;
      await fetch(`/api/plans/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      });
      showToast('已归档。');
      await loadAll();
    } else if (action === 'restore') {
      await fetch(`/api/plans/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: false }),
      });
      showToast('已恢复。');
      await loadAll();
    } else if (action === 'delete') {
      if (!confirm('确定删除?打卡记录也会一起删。')) return;
      await fetch(`/api/plans/${id}`, { method: 'DELETE' });
      showToast('已删除。');
      await loadAll();
    }
  }

  document.querySelectorAll('.plans-list__tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.plans-list__tab').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      filterMode = tab.dataset.filter;
      loadAllPlans();
    });
  });

  loadAll();
})();