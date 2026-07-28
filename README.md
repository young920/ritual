# Ritual — AI 编排训练计划 + 沉浸式训练模式

> 把"打开健身 app 选计划"变成"5 秒生成 + 直接开练"。AI 编排热身/主训练/冷身,真人 GIF 演示,语音引导,沉浸式全屏训练模式。

基于 [exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset)(1,324 个动作,9 种语言)构建。

## ✨ 它能做什么

- **AI 编排计划**:告诉 AI 你想练什么(自然语言),自动生成 N 天训练计划,带热身/主训练/拉伸,每步带要点
- **真人 GIF 演示**:每个动作库里都有真人 GIF,训练时自动播放循环
- **沉浸式训练模式**:全屏 + 倒计时 + 语音引导 + BGM,可暂停/继续
- **替代动作推荐**:每个动作库里都有替代品(同肌群,不同器械/不同难度)
- **历史记录**:本地保存多个计划,可切回任意一天继续

## 🚀 快速开始

### 1. 装 uv(如果你已经有 Python 3.10+,可以跳过这步)

```bash
# Mac / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# 或 brew install uv / winget install astral-sh.uv
```

### 2. 启动

```bash
# Mac / Linux
./start.sh

# Windows
start.bat
```

首次运行会自动:
1. 用 uv 准备 Python 环境(无感)
2. 装依赖(无感)
3. 启 server,自动开浏览器到 `http://127.0.0.1:8000`

### 3. 填 API Key(一次就好)

首次进入,**先去「设置」页**,填三个字段:

| 字段 | 填什么 |
|---|---|
| API key | 你的大模型 key(`sk-...`) |
| Base URL | 你的代理地址(或官方地址) |
| Model | 你的模型名(如 `glm-5.2`) |

保存后,点 `/generate` → 输入"练胸" → 点"生成" → 2-3 分钟出计划 → 点"开始训练" → 全屏练。

## 🔑 用什么 LLM

Ritual 通过 **OpenAI 兼容协议**或 **Anthropic 协议**调用任何 LLM。

| 协议 | Base URL 格式 | 适用场景 |
|---|---|---|
| OpenAI 兼容(推荐) | `https://your-proxy.com/v1` | 大多数中转站(青晓云、PackyCode 等) |
| Anthropic 兼容 | `https://your-proxy.com` | Claude Code 本地代理、部分中转站 |

自动判断:Base URL 以 `/v1` 结尾 → OpenAI SDK,否则 → Anthropic SDK。

### 几个常见配置

```text
# 青晓云 + GLM-5.2(便宜、中文好)
Base URL: https://ai.qingxiaoyun.net/v1
Model: glm-5.2

# Claude Code 本地代理 + Claude
Base URL: http://127.0.0.1:53682/claudecode
Model: claude-sonnet-5

# Anthropic 官方
Base URL: https://api.anthropic.com
Model: claude-sonnet-5
```

⚠️ **不要把 API key 写进代码或 git 仓库**。Ritual 把 key 存到你浏览器 localStorage,本地文件不写。

## 🎬 训练模式长什么样

进入 `/today`,点"开始训练":

```
┌─────────────────────────────────────────────┐
│ 热身 · neck side stretch          [× 关闭]  │
├─────────────────────────────────────────────┤
│                                             │
│        ┌────────┐    热身 · 准备开始        │
│        │ GIF    │    即将练 archer push up │
│        │ 循环   │    ───────────────       │
│        └────────┘    01 / 04 · 12s          │
│                                             │
│                  neck side stretch         │
│                  颈侧拉伸,缓慢左右各停      │
│                  动作要点:弓式俯卧撑...     │
│                                             │
│        [← 上一组] [⏸ 暂停] [完成本组 →]    │
└─────────────────────────────────────────────┘
```

- **真人 GIF 循环**(库内 1300+ 动作)
- **中文语音引导**(「第 1 个动作,颈侧拉伸,开始」)
- **倒计时**(每 phase 显示剩余秒数)
- **暂停/继续**(按钮或空格)
- **BGM 4 首循环**
- 整组结束后自动进 rest 倒计时 → 下一组

## 🧠 生成时的思考过程(可视化)

点"生成"时,会弹一个浮窗,**分步骤展示 AI 编排计划的完整思考过程**:

```
🧠 大模型正在编排你的训练计划
意图:练胸 · 1 天 × 4 动作 · model glm-5.2

📋 解析你的意图 [◐]           ← 读取你的输入
   意图"练胸" · 1 个目标肌

🔍 从动作库筛选候选 [◐]       ← 从 1300+ 动作筛出 ~40 个
   从 1300+ 动作里筛出 4 组候选

🤖 调用大模型编排计划 [◐]     ← 实时计时,告诉你等了几秒
   等待 glm-5.2 返回... (23s,可重试 3 次)

📝 解析 + 注入动作图 [○]        ← 解析 JSON,注入每个动作的 GIF
   解析大模型返回的 JSON,把每个动作的 GIF 注入

🎉 完成 [○]
   计划生成完毕,已展示在下方
```

每步带 emoji + 标题 + 详情 + 状态图标(`○` → `◐` 旋转 → `✓`)。失败时变红 + 显示具体错误。

## 📐 设计语言 — Editorial Mono

**杂志感、克制、非典型 SaaS**。刻意避开 AI 味道:

- **字体**:Fraunces(variable serif)做标题 + Inter 做正文 + JetBrains Mono 做数字
- **配色**:warm off-white `#F5F2EE` 底 + 近黑文字 + 单 terracotta `#C04A2C` accent
- **节奏**:8px baseline,reading-width 720px,generous whitespace
- **数字**:全部 tabular nums,带 leading zero (`01`、`02`、`03`)
- **不出现**:emoji 按钮 / box-shadow / 紫色 AI 色 / "Get started" 按钮

## 🗂 目录结构

```
ritual/
├── data/
│   └── exercises.json          # 1324 个动作(15MB,运行时从 CDN 拉 GIF)
├── cli/                        # CLI 工具(搜索/查看/找替代/AI 编排)
│   ├── exercises.py
│   ├── coach.py
│   ├── finder.py
│   └── test_*.py
├── web/
│   ├── app.py                  # FastAPI 后端
│   ├── data/demo.json
│   ├── static/
│   │   ├── style.css           # Editorial Mono 样式
│   │   ├── i18n.js             # 双语渲染
│   │   ├── shared.js           # localStorage + toast
│   │   ├── plan.js             # /plan 页面逻辑
│   │   ├── generate.js         # /generate + 思考浮窗
│   │   ├── browse.js
│   │   ├── settings.js
│   │   ├── training.js         # 沉浸式训练模式
│   │   ├── detail.js
│   │   ├── voice/              # 预生成语音 mp3
│   │   └── bgm/                # BGM 4 首
│   ├── templates/              # 4 个页面 HTML
│   └── test_app.py
├── scripts/                    # 辅助脚本(下载媒体等)
├── start.sh / start.bat        # 一键启动
├── pyproject.toml              # 依赖(uv 用)
├── requirements.txt            # 依赖(pip 用)
└── README.md
```

## 🛠 CLI 工具(可选,不启动 server 也能用)

```bash
# 搜动作
python3 cli/exercises.py search "bench press"

# 动作详情
python3 cli/exercises.py show 0001
python3 cli/exercises.py show "3/4 sit-up"

# 找替代
python3 cli/exercises.py alt "barbell bench press"
python3 cli/exercises.py alt 0026 --limit 10 --no-same-equipment

# 反向挑
python3 cli/exercises.py pick --target pectorals --equipment "body weight"

# AI 编排
python3 cli/coach.py "练胸,只有哑铃" --target chest --equipment dumbbell --count 4
python3 cli/coach.py "练全身" --days 3 --per-day 4
```

环境变量:

```bash
export ANTHROPIC_API_KEY=sk-...           # 推荐(沿用兼容)
export ANTHROPIC_BASE_URL=https://...      # 可选,默认用 settings 页的
export ANTHROPIC_MODEL=glm-5.2             # 可选,默认 glm-4.5
```

## 🧪 跑测试

```bash
uv run python -m unittest discover -s cli -s web -v
```

测试用 mock 替掉 SDK,**不消耗 token**,可以放心跑。

## 🔒 隐私 / 安全

- API key 只存在你**浏览器 localStorage**,不进任何文件
- 所有计划数据存在**浏览器 SQLite**,不上传任何服务器
- `.gitignore` 排除了 `*.db` / `*.sqlite` / `.env` — 即使本地有也 commit 不上去
- 启动器**永远不需要**你提供 API key(运行时填)

## 🐛 常见问题

**Q: 启动后浏览器没自动打开?**
手动访问 `http://127.0.0.1:8000`。

**Q: 生成计划报 503 / model_not_found?**
你的 model 在代理下没通道。去 settings 换一个支持的 model,或换 base_url。

**Q: 报错"Invalid token"?**
API key 没填,或填了别的代理的 key。settings 里换 key。

**Q: GIF 不显示?**
网络问题,GIF 从 CDN 拉(`cdn.jsdelivr.net/gh/hasaneyldrm/...`)。检查能否访问该域名。

**Q: 训练时语音不响?**
检查系统音量。语音走的是浏览器 Web Speech API 或服务端 TTS mp3。

## 🤝 贡献

欢迎 PR。**提交前必看**:

- `data/exercises.json` 是上游数据集,**不要改**
- API key 永远不要 commit
- 训练模式 UI 改完,务必用浏览器自动化(Playwright)截图验证

## 📜 许可

MIT。底层动作数据集来自 [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset),CC BY 4.0。

---

**Ritual** — 训练是日常仪式。