# AiChess — 五子棋 AI

> **在线体验**：[https://gomoku-ai-9g7.pages.dev](https://gomoku-ai-9g7.pages.dev)

纯前端五子棋 AI 对弈平台，AI 引擎基于 α-β 剪枝 + Zobrist 哈希 + 迭代加深搜索。

---

## 算法亮点

| 技术 | 说明 |
|------|------|
| **α-β 剪枝** | 极大极小搜索，前瞻 4-6 层，剪枝效率约 O(b^(d/2)) |
| **Zobrist 哈希** | 局面增量哈希，配合置换表避免重复搜索，效率提升 20%-50% |
| **棋型评估** | 识别活四/冲四/活三/眠三/活二等完整棋型，攻防分别计分 |
| **着法排序** | 置换表最佳着法 > 杀手着法 > 历史启发表 > 中心优先 |
| **迭代加深** | 1.5s 时限内搜索到最大深度，兼顾响应速度 |
| **开局库** | 内置花月/浦月/疏星/瑞星/斜月经典定式 |
| **威胁检测** | 紧急防守——优先堵截对手冲四/活四/成五威胁 |

---

## 项目版本

### 纯前端版（在线体验）

部署在 Cloudflare Pages，AI 引擎完整移植到 JavaScript，浏览器端直接运算。

### Flask 版（本地开发）

```bash
pip install -r requirements.txt
python aichess.py
# 打开 http://127.0.0.1:5000
```

---

## 技术栈

`JavaScript` `Canvas 2D` `α-β 剪枝` `Zobrist 哈希` `Python` `Flask`

---

## License

MIT
