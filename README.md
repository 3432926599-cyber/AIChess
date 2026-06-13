# AiChess — 五子棋 AI

> **在线体验**：[gomoku-ai-9g7.pages.dev](https://gomoku-ai-9g7.pages.dev)

纯前端五子棋 AI 对弈平台。暗黑终端美学风格，AI 引擎基于 α-β 剪枝 + Zobrist 哈希 + 迭代加深搜索，浏览器端直接运算，无需后端。

<p align="center">
  <img src="https://img.shields.io/badge/JavaScript-ES6%2B-f7df1e?logo=javascript" alt="JS">
  <img src="https://img.shields.io/badge/AI-%CE%B1%E2%80%93%CE%B2_Pruning-4faf4f" alt="AI">
  <img src="https://img.shields.io/badge/deploy-Cloudflare_Pages-f38020?logo=cloudflare" alt="CF Pages">
  <img src="https://img.shields.io/badge/mobile-WeChat_X5_Ready-07c160?logo=wechat" alt="WeChat">
</p>

---

## 目录

- [算法架构](#算法架构)
- [如何对弈](#如何对弈)
- [项目结构](#项目结构)
- [本地运行](#本地运行)
- [部署](#部署)
- [相关链接](#相关链接)

---

## 算法架构

```
玩家点击 Canvas
      │
      ▼
┌──────────────┐
│  威胁检测     │ ◀── 第 0 优先级：堵截对手冲四/活四/成五点
└──────┬───────┘
      │ 无紧急威胁
      ▼
┌──────────────┐
│  开局库       │ ◀── 第 1 优先级：花月/浦月/疏星/瑞星/斜月定式
└──────┬───────┘
      │ 不在定式中
      ▼
┌──────────────┐
│ 迭代加深     │ ◀── 第 2 优先级：depth 1→6，1.5s 时限
│ α-β 搜索     │
└──────────────┘
```

### 各模块详解

| 模块 | 作用 | 为什么 |
|------|------|--------|
| **α-β 剪枝** | 极大极小搜索，前瞻 4–6 层 | 剪掉确定不会被选的分支，复杂度从 O(b^d) 降至约 O(b^(d/2)) |
| **Zobrist 哈希** | 局面增量哈希，O(1) 更新 | 不同着法序列常到达同一局面，配合置换表避免重复搜索，效率 +20%–50% |
| **置换表** | 缓存已搜索局面的评估结果 | 更深或同深的记录直接复用，跳过重复计算 |
| **棋型评估** | 识别活四/冲四/活三/眠三/活二等 | 区分真正威胁和假威胁，而非简单计数 |
| **着法排序** | 置换表最佳 → 杀手着法 → 历史启发 → 中心优先 | 好着法先搜让剪枝更充分，同等时间内可多搜 1–2 层 |
| **迭代加深** | depth 逐层递增，1.5s 超时 | 兼顾响应速度与搜索深度 |
| **开局库** | 内置 5 种经典定式 | 五子棋开局对胜负影响极大，避免走出明显劣势着法 |
| **候选裁剪** | 仅搜索已有棋子周边 2 格 | 候选数从 225 降至 20–60，大幅缩小搜索空间 |
| **威胁检测** | 优先堵截对手冲四/活四/成五 | "不堵就输"级别，必须在任何着法之前处理 |

---

## 如何对弈

1. 打开 [gomoku-ai-9g7.pages.dev](https://gomoku-ai-9g7.pages.dev)
2. **你执绿子**（先手），**AI 执琥珀子**（后手）
3. 点击棋盘交叉点落子
4. AI 在 1.5s 内回应
5. 五子连珠即获胜

**操作按钮**：
- `新游戏` — 重新开始对局
- `悔棋`   — 撤销你和 AI 各一步（步数 ≥ 2 时可用）

---

## 项目结构

```
AIChess/
├── cf-pages/              # 🔵 Cloudflare Pages 纯前端版（在线）
│   ├── index.html         # 终端风格 UI
│   ├── style.css          # Dark Terminal 样式 + 微信 X5 适配
│   └── script.js          # AI 引擎 + Canvas 绘制 + 响应式
│
├── templates/
│   └── index.html         # 🟢 Flask 版前端模板
├── static/
│   ├── style.css          # Flask 版样式
│   └── script.js          # Flask 版交互（调用 /api/move）
├── aichess.py             # Python Flask 后端 + AI 引擎
├── requirements.txt       # Flask
└── README.md
```

- **纯前端版**：AI 引擎完整移植到 JavaScript，部署在 Cloudflare Pages，无需服务器
- **Flask 版**：Python 实现 AI 引擎，通过 RESTful API 与前端通信，用于本地开发调试

---

## 本地运行

### 纯前端版

直接在浏览器打开 `cf-pages/index.html` 即可。

### Flask 版

```bash
pip install -r requirements.txt
python aichess.py
# 浏览器访问 http://127.0.0.1:5000
```

API 端点：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/state` | 获取当前游戏状态 |
| `POST` | `/api/move` | 玩家落子 + AI 回应 |
| `POST` | `/api/newgame` | 开始新游戏 |
| `POST` | `/api/undo` | 悔棋 |

---

## 部署

纯前端版通过 Wrangler 一键部署到 Cloudflare Pages：

```bash
cd cf-pages
npx wrangler pages deploy . --project-name=gomoku-ai --branch=main
```

---

## 相关链接

- **个人主页**：[supersuperchik-home.pages.dev](https://supersuperchik-home.pages.dev)
- **GitHub**：[3432926599-cyber](https://github.com/3432926599-cyber)

---

## License

MIT © 2026 SupersupErChik
