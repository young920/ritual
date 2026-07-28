/* sport · 中英对照 + 双语输出
   - t(field, value)        → 返回中文(没有则原值)
   - bilingual(field, value) → "中文 (English)" 形式;没有中文则只显示英文
   - 罕见的术语保留原文
*/

const I18N = {
  target: {
    'pectorals': '胸大肌',
    'lats': '背阔肌',
    'abs': '腹肌',
    'quads': '股四头肌',
    'glutes': '臀大肌',
    'hamstrings': '腘绳肌',
    'calves': '小腿',
    'deltoids': '三角肌',
    'delts': '三角肌',
    'biceps': '肱二头肌',
    'triceps': '肱三头肌',
    'forearms': '前臂',
    'trapezius': '斜方肌',
    'traps': '斜方肌',
    'lower back': '下背',
    'upper back': '上背',
    'spine': '脊柱',
    'levator scapulae': '肩胛提肌',
    'serratus anterior': '前锯肌',
    'cardiovascular system': '心血管系统',
    'abductors': '外展肌',
    'adductors': '内收肌',
  },
  equipment: {
    'body weight': '徒手',
    'dumbbell': '哑铃',
    'barbell': '杠铃',
    'kettlebell': '壶铃',
    'band': '弹力带',
    'cable': '钢索',
    'smith machine': '史密斯机',
    'leverage machine': '助力器械',
    'stability ball': '健身球',
    'bosu ball': 'Bosu 球',
    'ez barbell': 'EZ 杠',
    'weighted': '负重',
    'medicine ball': '药球',
    'other': '其他',
  },
  body_part: {
    'chest': '胸',
    'back': '背',
    'shoulders': '肩',
    'upper legs': '大腿',
    'lower legs': '小腿',
    'upper arms': '上臂',
    'lower arms': '前臂',
    'waist': '腰腹',
    'neck': '颈',
    'cardio': '有氧',
  },
  muscle_group: {
    'hip flexors': '髋屈肌',
    'lower back': '下背',
    'serratus anterior': '前锯肌',
    'rotator cuff': '肩袖',
    'core': '核心',
    'chest': '胸',
    'shoulders': '肩',
    'lats': '背阔肌',
  },
  // 指令语言(数据集支持 9 种),这里给常用 + 中文 fallback 顺序
  instruction_lang_priority: ['zh', 'en', 'es', 'it', 'tr', 'ru', 'hi', 'pl', 'ko'],
  lang_label: {
    'zh': '中文', 'en': 'English', 'es': 'Español', 'it': 'Italiano',
    'tr': 'Türkçe', 'ru': 'Русский', 'hi': 'हिन्दी', 'pl': 'Polski', 'ko': '한국어',
  },
};

function t(field, value) {
  if (!value) return '';
  const m = I18N[field];
  if (m) {
    const lower = m[value.toLowerCase()];
    if (lower) return lower;
  }
  return value;
}

function bilingual(field, value) {
  if (!value) return '';
  const zh = t(field, value);
  if (zh === value) return value;          // 没翻译,只显示英文
  if (zh.toLowerCase() === value.toLowerCase()) return value;
  return `${zh} <span class="meta-en">(${escapeHtmlStr(value)})</span>`;
}

function escapeHtmlStr(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// 选最优指令语言:有 steps 数组的优先,按 priority 顺序
function pickInstructionLang(instructionSteps) {
  if (!instructionSteps) return null;
  for (const lang of I18N.instruction_lang_priority) {
    if (Array.isArray(instructionSteps[lang]) && instructionSteps[lang].length) {
      return lang;
    }
  }
  // fallback:任何有内容的
  for (const lang of Object.keys(instructionSteps)) {
    if (Array.isArray(instructionSteps[lang]) && instructionSteps[lang].length) {
      return lang;
    }
  }
  return null;
}