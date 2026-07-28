/* sport · browse.js
   /browse 页面:搜索 / 部位过滤 / 器械过滤 / 网格结果。
*/

(function init() {
  setActiveNav('browse');

  let filterOptions = null;
  let debounceTimer = null;

  async function loadFilters() {
    const data = await fetch('/api/filters').then((r) => r.json());
    filterOptions = data;
    fillSelect('filter-target', data.target, 'target');
    fillSelect('filter-equipment', data.equipment, 'equipment');
  }

  function fillSelect(id, values, field) {
    const sel = $(id);
    if (!sel) return;
    sel.innerHTML = `<option value="">${field === 'target' ? '部位' : '器械'}(全部)</option>`;
    values.forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v;
      // <option> 不支持富文本,用 t() 而不是 bilingual(),手动拼 "中文 (English)"
      const zh = t(field, v);
      opt.textContent = (zh === v) ? v : `${zh} (${v})`;
      sel.appendChild(opt);
    });
  }

  async function doSearch() {
    const q = $('search-input').value.trim();
    const target = $('filter-target').value;
    const equipment = $('filter-equipment').value;
    const grid = $('browse-grid');
    grid.innerHTML = '<p class="empty">加载中…</p>';

    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (target) params.set('target', target);
    if (equipment) params.set('equipment', equipment);
    params.set('limit', '60');

    const data = await fetch('/api/browse?' + params).then((r) => r.json());
    $('result-count').textContent = `${data.count} 个结果`;
    if (!data.count) { grid.innerHTML = '<p class="empty">没找到。换关键词或放宽过滤。</p>'; return; }
    grid.innerHTML = '';
    data.results.forEach((ex) => grid.appendChild(exerciseCard(ex)));
  }

  function exerciseCard(ex) {
    const card = document.createElement('a');
    card.className = 'card';
    card.href = `/exercise/${encodeURIComponent(ex.id)}`;
    card.innerHTML = `
      <div class="card__gif">
        ${ex.gif_cdn ? `<img src="${escapeHtml(ex.gif_cdn)}" alt="" loading="lazy">` : ''}
      </div>
      <div class="card__body">
        <div class="card__name">${escapeHtml(ex.name)}</div>
        <div class="card__meta">${bilingual('target', ex.target)}</div>
        <div class="card__equip">${bilingual('equipment', ex.equipment)}</div>
      </div>
    `;
    return card;
  }

  function debounced(fn, ms) {
    return (...args) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => fn(...args), ms);
    };
  }

  $('search-input').addEventListener('input', debounced(doSearch, 200));
  $('filter-target').addEventListener('change', doSearch);
  $('filter-equipment').addEventListener('change', doSearch);

  loadFilters().then(doSearch);
})();