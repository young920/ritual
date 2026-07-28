/* sport · detail.js
   /exercise/{id} 页面:动作详情 + 双语 + 指令语言切换。
*/

(async function init() {
  setActiveNav('');
  const eid = location.pathname.split('/').pop();
  await renderExercise(eid);
})();

async function renderExercise(id) {
  const body = $('detail-body');
  try {
    const ex = await fetch(`/api/exercise/${encodeURIComponent(id)}`).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    const altsRes = await fetch(`/api/alternatives/${encodeURIComponent(id)}?limit=5`);
    const altsData = altsRes.ok ? await altsRes.json() : { alternatives: [] };

    const target = bilingual('target', ex.target);
    const mg = ex.muscle_group ? bilingual('muscle_group', ex.muscle_group) : '';
    const bp = ex.body_part ? bilingual('body_part', ex.body_part) : '';
    const eq = bilingual('equipment', ex.equipment);

    const stepsByLang = ex.instruction_steps || {};
    const availableLangs = Object.keys(stepsByLang).filter(
      (k) => Array.isArray(stepsByLang[k]) && stepsByLang[k].length
    );
    const initialLang = pickInstructionLang(stepsByLang) || (availableLangs[0] || 'en');

    body.innerHTML = `
      ${ex.gif_cdn ? `<img class="detail__gif" src="${escapeHtml(ex.gif_cdn)}" alt="${escapeHtml(ex.name)}">` : ''}
      <h1 class="detail__title">${escapeHtml(ex.name)}</h1>
      <div class="detail__meta">
        ${target} ·
        ${mg} ·
        ${bp} ·
        ${eq}
      </div>

      ${availableLangs.length ? `
        <div class="detail__section-title">
          动作要领
          <span class="lang-picker" id="lang-picker">
            ${availableLangs.map((l) => `
              <button class="lang-picker__chip ${l === initialLang ? ' is-active' : ''}"
                      data-lang="${l}">${escapeHtml(I18N.lang_label[l] || l)}</button>
            `).join('')}
          </span>
        </div>
        <ol class="detail__steps" id="detail-steps"></ol>
      ` : ''}

      ${altsData.alternatives.length ? `
        <div class="detail__section-title">替代动作</div>
        <ul class="detail__alts" id="detail-alts"></ul>
      ` : ''}
    `;

    const stepsEl = $('detail-steps');
    function paintSteps(lang) {
      const arr = stepsByLang[lang] || [];
      stepsEl.innerHTML = arr.map((s) => `<li>${escapeHtml(s)}</li>`).join('');
    }
    paintSteps(initialLang);
    document.querySelectorAll('#lang-picker .lang-picker__chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#lang-picker .lang-picker__chip')
          .forEach((c) => c.classList.remove('is-active'));
        chip.classList.add('is-active');
        paintSteps(chip.dataset.lang);
      });
    });

    const altsEl = $('detail-alts');
    if (altsEl) {
      altsEl.innerHTML = altsData.alternatives.map((a) => `
        <li>
          <a href="/exercise/${encodeURIComponent(a.id)}">${escapeHtml(a.name)}</a>
          <span class="reasons">${a.reasons.slice(0, 2).map(escapeHtml).join(' · ')}</span>
        </li>`).join('');
    }
  } catch (err) {
    body.innerHTML = `<p class="empty">加载失败:${escapeHtml(err.message)}</p>`;
  }
}