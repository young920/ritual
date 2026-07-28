/* sport · settings.js */

(function init() {
  setActiveNav('settings');
  loadSettingsToUI();
  bindSettingsAutoSave();

  document.querySelectorAll('.settings__input').forEach((el) => {
    el.addEventListener('input', () => showToast('已自动保存。', 1500));
  });

  $('clear-storage')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (!confirm('清除所有本地数据(API key、保存的计划、当前计划)?')) return;
    localStorage.clear();
    loadSettingsToUI();
    showToast('已清除。');
  });
})();