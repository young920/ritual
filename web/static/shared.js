/* sport · shared utilities
   所有页面共用:localStorage 帮手、toast、escapeHtml、fetch wrapper。
*/

const $ = (id) => document.getElementById(id);

const WEEKDAYS_ZH = ['周日','周一','周二','周三','周四','周五','周六'];

function todayLabel() {
  const d = new Date();
  const wk = WEEKDAYS_ZH[d.getDay()];
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}.${mm}.${dd} · ${wk}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function showToast(msg, ms = 3200) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('is-visible');
  setTimeout(() => t.classList.remove('is-visible'), ms);
}

function setActiveNav(pageKey) {
  document.querySelectorAll('.masthead__nav a').forEach((a) => a.classList.remove('is-active'));
  const link = $(`nav-${pageKey}`);
  if (link) link.classList.add('is-active');
}

// ─── localStorage:API 设置 ──────────────────────────────────────────

function getSetting(key) { return localStorage.getItem(`sport.${key}`) || ''; }
function setSetting(key, value) { localStorage.setItem(`sport.${key}`, (value ?? '').trim()); }

function loadSettingsToUI() {
  const ids = { 'setting-key': 'api_key', 'setting-base-url': 'base_url', 'setting-model': 'model' };
  Object.entries(ids).forEach(([id, key]) => {
    const el = $(id);
    if (el) el.value = getSetting(key);
  });
}

function bindSettingsAutoSave() {
  const ids = { 'setting-key': 'api_key', 'setting-base-url': 'base_url', 'setting-model': 'model' };
  Object.entries(ids).forEach(([id, key]) => {
    const el = $(id);
    if (el) el.addEventListener('input', () => setSetting(key, el.value));
  });
}

// ─── localStorage:保存的计划 ──────────────────────────────────────────

const LS_PLANS = 'sport.plans';
const LS_CURRENT = 'sport.current_plan_id';

function getPlans() {
  try { return JSON.parse(localStorage.getItem(LS_PLANS) || '[]'); }
  catch { return []; }
}

function savePlan(plan, name) {
  const plans = getPlans();
  const id = String(Date.now());
  const entry = {
    id,
    name: name || plan.title || '未命名计划',
    saved_at: new Date().toISOString(),
    plan,
  };
  plans.unshift(entry);
  localStorage.setItem(LS_PLANS, JSON.stringify(plans));
  setCurrentPlanId(id);
  return entry;
}

function deletePlan(id) {
  const plans = getPlans().filter((p) => p.id !== id);
  localStorage.setItem(LS_PLANS, JSON.stringify(plans));
  if (getCurrentPlanId() === id) {
    if (plans.length) setCurrentPlanId(plans[0].id);
    else localStorage.removeItem(LS_CURRENT);
  }
}

function getPlanById(id) {
  return getPlans().find((p) => p.id === id) || null;
}

function setCurrentPlanId(id) { localStorage.setItem(LS_CURRENT, id); }
function getCurrentPlanId() { return localStorage.getItem(LS_CURRENT); }
function clearCurrentPlanId() { localStorage.removeItem(LS_CURRENT); }

// ─── 渲染:plan / day / exercise row ──────────────────────────────────

function renderHero(plan) {
  if ($('hero-date')) $('hero-date').textContent = todayLabel();
  if ($('hero-title')) $('hero-title').innerHTML =
    `<em>${escapeHtml(plan.title || '训练计划')}</em>`;
  if ($('hero-summary')) $('hero-summary').textContent = plan.summary || '';
  if ($('hero-split')) $('hero-split').textContent = plan.split || '';

  const days = plan.days || [];
  const total = days.reduce((acc, d) => acc + (d.exercises || []).length, 0);
  if ($('hero-count')) $('hero-count').textContent = `${days.length} 天 · 共 ${total} 个动作`;
  return days;
}

function renderDayTabs(days, onSwitch, containerSel = '#day-tabs') {
  const tabs = $(containerSel.replace(/^#/, ''));
  if (!tabs) return;
  tabs.innerHTML = '';
  days.forEach((day, i) => {
    const btn = document.createElement('button');
    btn.className = 'day-tab' + (i === 0 ? ' is-active' : '');
    btn.type = 'button';
    btn.textContent = `第${pad2(day.day || i + 1)}天 · ${day.title || ''}`;
    btn.addEventListener('click', () => {
      tabs.querySelectorAll('.day-tab').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      onSwitch(day);
    });
    tabs.appendChild(btn);
  });
}

function renderDayHeader(day, prefix = '') {
  const map = {
    num: `${prefix}day-num`, title: `${prefix}day-title`, summary: `${prefix}day-summary`,
  };
  const headerEl = $(`${prefix}day-header`);
  if (headerEl) headerEl.hidden = false;
  if ($(map.num)) $(map.num).textContent = `第${pad2(day.day)}天`;
  if ($(map.title)) $(map.title).textContent = day.title || '';
  if ($(map.summary)) $(map.summary).textContent = day.summary || '';
}

function renderExerciseRow(ex, n) {
  const row = document.createElement('article');
  row.className = 'exercise';
  row.innerHTML = `
    <div class="exercise__num">${pad2(n)}</div>
    <div class="exercise__body">
      <a class="exercise__name" href="/exercise/${encodeURIComponent(ex.id)}">${escapeHtml(ex.name)}</a>
      <div class="exercise__meta">
        <span>${bilingual('target', ex.target)}</span>
        <span>${bilingual('equipment', ex.equipment)}</span>
      </div>
      <div class="exercise__data">
        <span><strong>${ex.sets ?? '?'}</strong> 组</span>
        <span><strong>${escapeHtml(String(ex.reps ?? '?'))}</strong> 次</span>
        <span>休息 <strong>${ex.rest_seconds ?? '?'}</strong> 秒</span>
      </div>
      ${ex.reason ? `<p class="exercise__reason">${escapeHtml(ex.reason)}</p>` : ''}
    </div>
  `;
  return row;
}

function renderDayExercises(day, containerSel = '#exercises') {
  const container = $(containerSel.replace(/^#/, ''));
  if (!container) return;
  container.innerHTML = '';
  (day.exercises || []).forEach((ex, i) => container.appendChild(renderExerciseRow(ex, i + 1)));
}