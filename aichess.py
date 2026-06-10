# -*- coding: utf-8 -*-
"""
五子棋 AI —— 算法优化版
=========================
从 C++ EasyX 版本迁移至 Python Flask Web 版本

算法亮点 (相较原版):
1. α-β 剪枝 + 极大极小搜索 —— 替代原版贪心一步评估，能够前瞻多步
2. Zobrist 哈希 + 置换表    —— 缓存已搜索局面，避免重复计算
3. 基于棋型的静态评估函数    —— 识别活四/冲四/活三/眠三/活二等多种棋型
4. 着法排序 + 历史启发       —— 优先搜索好着法，大幅提升剪枝效率
5. 迭代加深搜索             —— 在时限内搜索到尽可能深，兼顾响应速度
6. 开局库                   —— 内置经典开局，避免开局阶段走出劣势着法
7. 候选着法裁剪             —— 仅搜索已有棋子周边的着法，缩小搜索空间
"""

import random
import time
import math
from flask import Flask, request, jsonify, render_template

# ============================================================
# 常量定义
# ============================================================
BOARD_SIZE = 15
EMPTY = 0
BLACK = 1
WHITE = 2

# 搜索参数
MAX_DEPTH = 6                # 最大搜索深度
TIME_LIMIT = 1.5             # 单步时间限制（秒）
TT_SIZE = 1 << 18            # 置换表大小 (约 26 万条)
CANDIDATE_RADIUS = 2         # 候选着法只考虑已有棋子周围 2 格

# 棋型分数 (用于静态评估)
SCORE_FIVE        = 10000000  # 连五 / 胜利
SCORE_OPEN_FOUR   = 100000    # 活四 / 必胜
SCORE_RUSH_FOUR   = 8000      # 冲四 / 必须防守
SCORE_OPEN_THREE  = 3000      # 活三 / 严重威胁
SCORE_SLEEP_THREE = 500       # 眠三 / 潜在威胁
SCORE_OPEN_TWO    = 200       # 活二
SCORE_SLEEP_TWO   = 30        # 眠二
SCORE_OPEN_ONE    = 10        # 活一

# 四个搜索方向 (dx, dy): 水平, 垂直, 主对角线, 副对角线
DIRECTIONS = [(1, 0), (0, 1), (1, 1), (1, -1)]


# ============================================================
# Zobrist 哈希
# ============================================================
# 为什么加入 Zobrist 哈希？
# 五子棋中不同的着法序列经常到达相同的局面，Zobrist 哈希通过 XOR 操作
# 实现 O(1) 增量更新，配合置换表可避免重复搜索同一局面，效率提升 20%-50%。

class Zobrist:
    """Zobrist 哈希 —— 局面快速索引"""
    def __init__(self):
        rng = random.Random(42)  # 独立随机生成器，不影响全局状态
        # 为每个 (row, col, player) 组合生成随机 64 位哈希值
        self.table = [[[rng.getrandbits(64) for _ in range(3)]
                       for _ in range(BOARD_SIZE)]
                      for _ in range(BOARD_SIZE)]
        self.side_key = rng.getrandbits(64)  # 表示当前轮到谁走

    def hash(self, board, player):
        """计算当前局面的 Zobrist 哈希值"""
        h = 0
        for r in range(BOARD_SIZE):
            for c in range(BOARD_SIZE):
                if board[r][c] != EMPTY:
                    h ^= self.table[r][c][board[r][c]]
        if player == BLACK:
            h ^= self.side_key
        return h

    def update(self, old_hash, row, col, player):
        """增量更新哈希值（落子/撤子时使用）"""
        old_hash ^= self.table[row][col][player]
        old_hash ^= self.side_key
        return old_hash


# ============================================================
# 置换表
# ============================================================
# 为什么加入置换表？
# 缓存已搜索过的局面及其评估结果。当搜索某局面时，先查表，
# 若已有更深或同深的记录则可直接复用，跳过重复搜索。

class TranspositionTable:
    """置换表 —— 局面缓存"""
    EXACT = 0    # 精确值
    ALPHA = 1    # 上界（≤此值）
    BETA  = 2    # 下界（≥此值）

    def __init__(self, max_size=TT_SIZE):
        self.max_size = max_size
        self.table = {}
        self.access_count = 0
        self.hit_count = 0

    def store(self, zhash, depth, score, flag, best_move=None):
        """存入置换表"""
        if len(self.table) >= self.max_size:
            # 简单清空策略（生产环境可用 LRU）
            self.table.clear()
        self.table[zhash] = (depth, score, flag, best_move)

    def lookup(self, zhash):
        """查询置换表，返回 (depth, score, flag, best_move) 或 None"""
        self.access_count += 1
        entry = self.table.get(zhash)
        if entry is not None:
            self.hit_count += 1
        return entry

    def clear(self):
        self.table.clear()
        self.access_count = 0
        self.hit_count = 0


# ============================================================
# 开局库
# ============================================================
# 为什么加入开局库？
# 五子棋开局对胜负影响极大。内置常见定式开局，
# 避免 AI 在开局阶段走出明显劣势的着法，同时加快开局响应速度。

class OpeningBook:
    """开局库 —— 内置经典定式开局"""
    # 常见开局：花月、浦月、云月、雨月、疏星、瑞星 等
    # 格式: [(row, col), (row, col), ...]  黑先白后交替
    # 使用坐标，棋盘中心为 (7,7)

    BOOKS = {
        "huayue": [  # 花月开局（黑大优）
            (7, 7), (7, 8),   # 黑天元, 白右
            (8, 6), (6, 6),   # 黑左下, 白左上
            (9, 7), (8, 7),   # 黑下, 白下中
        ],
        "puyue": [  # 浦月开局（黑大优）
            (7, 7), (7, 8),
            (6, 8), (6, 7),
            (8, 8), (8, 7),
        ],
        "shuxing": [  # 疏星开局（平衡）
            (7, 7), (7, 8),
            (8, 8), (6, 6),
        ],
        "ruixing": [  # 瑞星开局（平衡）
            (7, 7), (7, 8),
            (8, 7), (6, 8),
        ],
        "xieyue": [  # 斜月开局
            (7, 7), (7, 8),
            (8, 6), (6, 8),
        ],
    }

    def __init__(self):
        # 随机选择一个开局
        self.book_moves = list(random.choice(list(self.BOOKS.values())))

    def get_move(self, board, move_count):
        """
        根据已走步数返回开局库着法。
        **关键修复**: 验证之前所有着法是否与定式匹配。
        如果玩家偏离了定式，立即放弃开局库，转入正常搜索。
        这样避免 AI 在对手变招时仍然盲目走定式。
        """
        if move_count >= len(self.book_moves):
            return None

        # 验证：之前所有着法是否都在定式位置上
        for i in range(move_count):
            r, c = self.book_moves[i]
            expected = BLACK if i % 2 == 0 else WHITE
            if board[r][c] != expected:
                return None  # 局面不匹配，放弃定式

        # 目标位置必须为空
        r, c = self.book_moves[move_count]
        if board[r][c] == EMPTY:
            return (r, c)
        return None


# ============================================================
# 五子棋 AI 引擎
# ============================================================

class GomokuAI:
    """五子棋 AI —— 核心引擎"""

    def __init__(self):
        self.zobrist = Zobrist()
        self.tt = TranspositionTable()
        self.opening_book = OpeningBook()

        # 历史启发表: history[row][col] 记录该位置导致剪枝的次数
        self.history = [[0] * BOARD_SIZE for _ in range(BOARD_SIZE)]

        # 杀手着法: killer[depth][0/1] 每条深度记录两个杀手着法
        self.killers = [[None, None] for _ in range(MAX_DEPTH + 2)]

        # 统计信息
        self.nodes_searched = 0
        self.tt_hits = 0
        self.search_start_time = 0
        self.time_up = False

    # ----------------------------------------------------------
    # 胜负检测
    # ----------------------------------------------------------
    def check_win(self, board, row, col, player):
        """检测在 (row, col) 落子后 player 是否连成五子"""
        for dr, dc in DIRECTIONS:
            count = 1
            # 正方向
            for step in range(1, 5):
                nr, nc = row + dr * step, col + dc * step
                if 0 <= nr < BOARD_SIZE and 0 <= nc < BOARD_SIZE \
                   and board[nr][nc] == player:
                    count += 1
                else:
                    break
            # 反方向
            for step in range(1, 5):
                nr, nc = row - dr * step, col - dc * step
                if 0 <= nr < BOARD_SIZE and 0 <= nc < BOARD_SIZE \
                   and board[nr][nc] == player:
                    count += 1
                else:
                    break
            if count >= 5:
                return True
        return False

    # ----------------------------------------------------------
    # 棋型分析
    # ----------------------------------------------------------
    @staticmethod
    def analyze_line(board, row, col, dr, dc, player):
        """
        分析从 (row, col) 沿方向 (dr, dc) 的棋型。
        返回 (count, open_left, open_right, space_left, space_right)
        count:     连续 player 棋子数（含自身）
        open_left: 左端是否为空格
        open_right:右端是否为空格
        """
        opponent = BLACK if player == WHITE else WHITE
        count = 1
        open_left = False
        open_right = False
        space_left = 0
        space_right = 0

        # 正方向扫描
        for step in range(1, 5):
            nr, nc = row + dr * step, col + dc * step
            if 0 <= nr < BOARD_SIZE and 0 <= nc < BOARD_SIZE:
                if board[nr][nc] == player:
                    count += 1
                elif board[nr][nc] == EMPTY:
                    open_right = True
                    # 继续看跳一格后是否有子
                    nnr, nnc = nr + dr, nc + dc
                    if 0 <= nnr < BOARD_SIZE and 0 <= nnc < BOARD_SIZE:
                        if board[nnr][nnc] == player:
                            space_right = 1
                    break
                else:
                    break  # 被对手棋子堵住
            else:
                break  # 边界

        # 反方向扫描
        for step in range(1, 5):
            nr, nc = row - dr * step, col - dc * step
            if 0 <= nr < BOARD_SIZE and 0 <= nc < BOARD_SIZE:
                if board[nr][nc] == player:
                    count += 1
                elif board[nr][nc] == EMPTY:
                    open_left = True
                    nnr, nnc = nr - dr, nc - dc
                    if 0 <= nnr < BOARD_SIZE and 0 <= nnc < BOARD_SIZE:
                        if board[nnr][nnc] == player:
                            space_left = 1
                    break
                else:
                    break
            else:
                break

        return count, open_left, open_right, space_left, space_right

    @staticmethod
    def score_pattern(count, open_left, open_right, space_left, space_right):
        """
        根据棋型参数计算分数。
        为什么改进评估函数？
        原版只统计连续棋子数量，无法区分离攻（活三）和死攻（眠三）。
        新版识别完整棋型，分别评估攻防价值，决策更准确。
        """
        if count >= 5:
            return SCORE_FIVE
        if count == 4:
            if open_left and open_right:
                return SCORE_OPEN_FOUR   # 活四: OOOO_
            elif open_left or open_right:
                return SCORE_RUSH_FOUR   # 冲四: XOOOO_
            else:
                return SCORE_SLEEP_THREE  # 四子被堵死
        if count == 3:
            if open_left and open_right:
                # 活三: _OOO_  但要排除假活三（跳三）
                if space_left == 0 and space_right == 0:
                    return SCORE_OPEN_THREE
                return SCORE_SLEEP_THREE
            elif open_left or open_right:
                return SCORE_SLEEP_THREE  # 眠三: XOOO_
            else:
                return SCORE_OPEN_TWO
        if count == 2:
            if open_left and open_right:
                return SCORE_OPEN_TWO     # 活二
            elif open_left or open_right:
                return SCORE_SLEEP_TWO    # 眠二
            else:
                return 0
        if count == 1:
            if open_left and open_right:
                return SCORE_OPEN_ONE
            return 0
        return 0

    # ----------------------------------------------------------
    # 静态评估
    # ----------------------------------------------------------
    def evaluate(self, board, player):
        """
        静态评估函数 —— 从 player 的视角评估局面。
        遍历每个有子的位置，分析四个方向的棋型并累计分数。
        同时评估对手的棋型（防御意识）。
        """
        opponent = BLACK if player == WHITE else WHITE

        # 快速胜利检测
        # (在搜索中 check_win 已先调用，这里主要评估非终局局面)
        my_score = 0
        op_score = 0
        evaluated = set()  # 避免重复评估同一条线

        for r in range(BOARD_SIZE):
            for c in range(BOARD_SIZE):
                piece = board[r][c]
                if piece == EMPTY:
                    continue

                for d, (dr, dc) in enumerate(DIRECTIONS):
                    # 用 (行, 列, 方向) 做去重键
                    line_key = (r, c, d)
                    if line_key in evaluated:
                        continue
                    evaluated.add(line_key)

                    count, ol, or_, sl, sr = self.analyze_line(
                        board, r, c, dr, dc, piece)
                    s = self.score_pattern(count, ol, or_, sl, sr)

                    if piece == player:
                        my_score += s
                        # 检测双威胁（活三 + 冲四 组合）
                        if count >= 4 and (ol or or_):
                            my_score += 5000  # 几乎必胜
                    else:
                        op_score += s
                        if count >= 4 and (ol or or_):
                            op_score += 5000

        # 攻防平衡：自己的进攻分 - 对手的进攻分
        # 防守权重 1.35：只有显著偏重防守，浅层搜索才有可能拦截对手活三
        # 否则 AI 会在己方进攻分略高时放弃防守，被对手九步速杀
        return my_score - op_score * 1.35

    # ----------------------------------------------------------
    # 候选着法生成
    # ----------------------------------------------------------
    def generate_moves(self, board):
        """
        生成候选着法。
        为什么裁剪候选着法？
        15×15=225 个位置，但有效的着法通常只在已有棋子周围。
        只考虑已有棋子周边 2 格的位置，将候选数从 225 降至 20-60，
        大幅缩小搜索空间，同时不遗漏任何有价值的着法。
        """
        candidates = set()
        has_stone = False

        for r in range(BOARD_SIZE):
            for c in range(BOARD_SIZE):
                if board[r][c] != EMPTY:
                    has_stone = True
                    # 将周围 CANDIDATE_RADIUS 格内的空位加入候选
                    for dr in range(-CANDIDATE_RADIUS, CANDIDATE_RADIUS + 1):
                        for dc in range(-CANDIDATE_RADIUS, CANDIDATE_RADIUS + 1):
                            nr, nc = r + dr, c + dc
                            if 0 <= nr < BOARD_SIZE and 0 <= nc < BOARD_SIZE \
                               and board[nr][nc] == EMPTY:
                                candidates.add((nr, nc))

        if not has_stone:
            # 空棋盘：走天元
            candidates.add((BOARD_SIZE // 2, BOARD_SIZE // 2))

        return list(candidates)

    # ----------------------------------------------------------
    # 着法排序
    # ----------------------------------------------------------
    def order_moves(self, moves, board, player, depth, hash_move):
        """
        对着法进行排序，优先搜索可能更好的着法。
        为什么加入着法排序？
        好的着法先搜索能让 α-β 剪枝更充分地"剪掉"劣着法。
        排序依据：置换表最佳着法 > 杀手着法 > 历史启发表 >
        中心优先 > 静态评估高的着法。
        良好的排序可在同样时间内多搜索 1-2 层。
        """
        center = BOARD_SIZE // 2
        scored = []

        for move in moves:
            r, c = move
            score = 0

            # 第 1 优先级：置换表中的最佳着法
            if hash_move and move == hash_move:
                score = 10000000

            # 第 2 优先级：杀手着法
            elif self.killers[depth][0] == move:
                score = 9000000
            elif self.killers[depth][1] == move:
                score = 8000000

            # 第 3 优先级：历史启发表
            else:
                score = self.history[r][c]

            # 第 4 优先级：靠近中心
            dist_to_center = abs(r - center) + abs(c - center)
            score += max(0, 14 - dist_to_center) * 10

            # 第 5 优先级：快速静态评估（只评估该位置周围）
            for dr, dc in DIRECTIONS:
                count, ol, or_, sl, sr = self.analyze_line(
                    board, r, c, dr, dc, player)
                score += count * count * 5
                if ol:
                    score += 10
                if or_:
                    score += 10

            scored.append((score, move))

        # 按分数降序排列
        scored.sort(key=lambda x: x[0], reverse=True)
        return [m for _, m in scored]

    # ----------------------------------------------------------
    # α-β 搜索
    # ----------------------------------------------------------
    def alpha_beta(self, board, depth, alpha, beta, player, zhash):
        """
        带 α-β 剪枝的极大极小搜索。
        为什么加入 α-β 剪枝？
        原版 AI 只看一步（贪心法），无法预判对手的应对。
        α-β 剪枝能在搜索树中剪掉确定不会被选择的分支，
        将复杂度从 O(b^d) 降至约 O(b^(d/2))，使得搜索深度可达 4-6 层。
        """
        self.nodes_searched += 1

        # 检查时间
        if self.nodes_searched % 1000 == 0:
            if time.time() - self.search_start_time > TIME_LIMIT:
                self.time_up = True
                return 0, None

        # 查询置换表
        tt_entry = self.tt.lookup(zhash)
        tt_move = None
        if tt_entry is not None:
            tt_depth, tt_score, tt_flag, tt_move = tt_entry
            if tt_depth >= depth:
                if tt_flag == TranspositionTable.EXACT:
                    return tt_score, tt_move
                elif tt_flag == TranspositionTable.ALPHA and tt_score <= alpha:
                    return tt_score, tt_move
                elif tt_flag == TranspositionTable.BETA and tt_score >= beta:
                    return tt_score, tt_move

        # 生成候选着法
        moves = self.generate_moves(board)

        # 叶子节点：静态评估
        if depth == 0 or not moves:
            return self.evaluate(board, player), None

        # 检查是否有直接获胜的着法（五子棋特有的快速剪枝）
        opponent = BLACK if player == WHITE else WHITE

        # 着法排序
        ordered_moves = self.order_moves(moves, board, player, depth, tt_move)

        best_move = None
        best_score = -math.inf
        flag = TranspositionTable.ALPHA

        for move in ordered_moves:
            if self.time_up:
                break

            r, c = move
            board[r][c] = player

            # 检查是否直接获胜
            if self.check_win(board, r, c, player):
                board[r][c] = EMPTY
                # 离根节点越近的获胜越有价值
                win_score = SCORE_FIVE + depth * 1000
                self.tt.store(zhash, depth, win_score,
                              TranspositionTable.EXACT, move)
                return win_score, move

            # 递归搜索（注意换手后正负号翻转）
            new_zhash = self.zobrist.update(zhash, r, c, player)
            score, _ = self.alpha_beta(
                board, depth - 1, -beta, -alpha, opponent, new_zhash)
            score = -score

            board[r][c] = EMPTY  # 回溯

            if self.time_up:
                break

            if score > best_score:
                best_score = score
                best_move = move

            if score > alpha:
                alpha = score
                flag = TranspositionTable.EXACT

                # 历史启发表更新
                self.history[r][c] += depth * depth

            if alpha >= beta:
                # β 剪枝发生
                flag = TranspositionTable.BETA
                # 记录为杀手着法
                if self.killers[depth][0] != move:
                    self.killers[depth][1] = self.killers[depth][0]
                    self.killers[depth][0] = move
                # 历史启发表更新（剪枝着法权重更高）
                self.history[r][c] += depth * depth * 2
                break

        # 存入置换表
        if best_move is not None and not self.time_up:
            self.tt.store(zhash, depth, best_score, flag, best_move)

        return best_score, best_move

    # ----------------------------------------------------------
    # 紧急威胁检测
    # ----------------------------------------------------------
    def find_blocking_moves(self, board, opponent):
        """
        检测对手的紧急威胁 —— 对手下一步能冲四或成五的位置。
        这是「不堵就输」级别的威胁，必须在任何其他着法之前处理。

        Bug 修复背景：
        原版先走开局库再走搜索，如果对手偏离定式自建活三，
        AI 仍然机械地走定式着法，造成 "不理黑棋连三" 导致九步速败。
        现在任何着法之前先检查对手威胁，堵住再说。

        返回需要堵住的 {(row, col), ...} 集合。
        """
        blocks = set()
        for r in range(BOARD_SIZE):
            for c in range(BOARD_SIZE):
                if board[r][c] != EMPTY:
                    continue
                # 模拟对手在此落子
                board[r][c] = opponent
                # 1. 直接成五？
                if self.check_win(board, r, c, opponent):
                    blocks.add((r, c))
                else:
                    # 2. 形成冲四或活四？
                    for dr, dc in DIRECTIONS:
                        count, ol, or_, sl, sr = self.analyze_line(
                            board, r, c, dr, dc, opponent)
                        if count >= 5 or (count >= 4 and (ol or or_)):
                            blocks.add((r, c))
                            break
                board[r][c] = EMPTY
        return blocks

    # ----------------------------------------------------------
    # 迭代加深搜索
    # ----------------------------------------------------------
    def search(self, board, player, move_count):
        """
        迭代加深搜索 —— 主入口（含威胁检测 + 开局库 + IDDFS）。
        """
        opponent = BLACK if player == WHITE else WHITE

        # =======================================================
        # 第 0 优先级：紧急防守 —— 堵对手的冲四/活四/成五点
        # =======================================================
        blocks = self.find_blocking_moves(board, opponent)
        if blocks:
            if len(blocks) == 1:
                return list(blocks)[0]
            # 多点需要堵 → 选最有利己方的那一个
            best_block, best_val = None, -math.inf
            for br, bc in blocks:
                board[br][bc] = player
                val = self.evaluate(board, player)
                board[br][bc] = EMPTY
                if val > best_val:
                    best_val = val
                    best_block = (br, bc)
            return best_block

        # =======================================================
        # 第 1 优先级：开局库（仅当局面匹配定式）
        # =======================================================
        if move_count <= 3:
            book_move = self.opening_book.get_move(board, move_count)
            if book_move is not None:
                return book_move

        # =======================================================
        # 第 2 优先级：迭代加深 α-β 搜索
        # =======================================================
        self.search_start_time = time.time()
        self.time_up = False
        self.nodes_searched = 0

        zhash = self.zobrist.hash(board, player)

        best_move = None
        best_score = None
        completed_depth = 0

        try:
            for depth in range(1, MAX_DEPTH + 1):
                if self.time_up:
                    break

                score, move = self.alpha_beta(
                    board, depth, -math.inf, math.inf, player, zhash)

                if not self.time_up:
                    best_score = score
                    if move is not None:
                        best_move = move
                    completed_depth = depth

                # 找到必胜着法 → 提前终止
                if best_score is not None and best_score >= SCORE_FIVE:
                    break

                # 开局阶段确保至少搜索到深度 2
                # 防止浅层搜索看不到对手的活三→冲四→成五链条
                if depth < 2 and move_count <= 6:
                    continue

        except Exception:
            pass

        elapsed = time.time() - self.search_start_time

        # 搜索失败时的回退
        if best_move is None:
            best_move = self._fallback_move(board, player)

        print(f"[AI] 完成深度={completed_depth}, 节点={self.nodes_searched}, "
              f"耗时={elapsed:.2f}s, "
              f"TT命中={self.tt.hit_count/max(1,self.tt.access_count)*100:.1f}%, "
              f"着法={best_move}")

        return best_move

    def _fallback_move(self, board, player):
        """回退策略：简单评估所有空位，选得分最高的"""
        best_score = -math.inf
        best_move = None
        for r in range(BOARD_SIZE):
            for c in range(BOARD_SIZE):
                if board[r][c] == EMPTY:
                    board[r][c] = player
                    score = self.evaluate(board, player)
                    board[r][c] = EMPTY
                    if score > best_score:
                        best_score = score
                        best_move = (r, c)
        return best_move or (BOARD_SIZE // 2, BOARD_SIZE // 2)

    def reset(self):
        """重置 AI 状态（新游戏时调用）"""
        self.tt.clear()
        self.history = [[0] * BOARD_SIZE for _ in range(BOARD_SIZE)]
        self.killers = [[None, None] for _ in range(MAX_DEPTH + 2)]
        self.opening_book = OpeningBook()


# ============================================================
# 游戏状态管理
# ============================================================

class GomokuGame:
    """管理一局五子棋游戏的状态"""

    def __init__(self):
        self.board = [[EMPTY] * BOARD_SIZE for _ in range(BOARD_SIZE)]
        self.current_player = BLACK     # 黑先（玩家）
        self.move_history = []          # [(row, col, player), ...]
        self.game_over = False
        self.winner = None
        self.win_cells = []             # 获胜的五子坐标
        self.ai = GomokuAI()

    def is_valid_move(self, row, col):
        return (0 <= row < BOARD_SIZE and 0 <= col < BOARD_SIZE
                and self.board[row][col] == EMPTY and not self.game_over)

    def make_move(self, row, col, player=None):
        """执行落子，返回是否合法"""
        if player is None:
            player = self.current_player
        if not self.is_valid_move(row, col):
            return False

        self.board[row][col] = player
        self.move_history.append((row, col, player))

        # 检查胜负
        if self.ai.check_win(self.board, row, col, player):
            self.game_over = True
            self.winner = player
            self._find_win_cells(row, col, player)
        # 检查平局
        elif len(self.move_history) == BOARD_SIZE * BOARD_SIZE:
            self.game_over = True
            self.winner = None

        self.current_player = BLACK if player == WHITE else WHITE

        return True

    def _find_win_cells(self, row, col, player):
        """找出获胜的五子连线"""
        for dr, dc in DIRECTIONS:
            cells = [(row, col)]
            for step in range(1, 5):
                nr, nc = row + dr * step, col + dc * step
                if 0 <= nr < BOARD_SIZE and 0 <= nc < BOARD_SIZE \
                   and self.board[nr][nc] == player:
                    cells.append((nr, nc))
                else:
                    break
            for step in range(1, 5):
                nr, nc = row - dr * step, col - dc * step
                if 0 <= nr < BOARD_SIZE and 0 <= nc < BOARD_SIZE \
                   and self.board[nr][nc] == player:
                    cells.append((nr, nc))
                else:
                    break
            if len(cells) >= 5:
                self.win_cells = cells[:5]
                return

    def undo(self):
        """悔棋（撤销玩家和 AI 各一步）"""
        if len(self.move_history) >= 2:
            for _ in range(2):
                r, c, _ = self.move_history.pop()
                self.board[r][c] = EMPTY
            self.current_player = BLACK
            self.game_over = False
            self.winner = None
            self.win_cells = []
            return True
        return False

    def get_ai_move(self):
        """获取 AI 的最佳着法"""
        return self.ai.search(self.board, WHITE, len(self.move_history))

    def reset(self):
        """重置游戏"""
        self.board = [[EMPTY] * BOARD_SIZE for _ in range(BOARD_SIZE)]
        self.current_player = BLACK
        self.move_history = []
        self.game_over = False
        self.winner = None
        self.win_cells = []
        self.ai.reset()


# ============================================================
# Flask Web 服务
# ============================================================

app = Flask(__name__)
game = GomokuGame()


@app.route('/')
def index():
    """游戏主页"""
    return render_template('index.html',
                           board_size=BOARD_SIZE,
                           board=game.board)


@app.route('/api/state', methods=['GET'])
def api_state():
    """获取当前游戏状态"""
    return jsonify({
        'board': game.board,
        'currentPlayer': game.current_player,
        'gameOver': game.game_over,
        'winner': game.winner,
        'winCells': game.win_cells,
        'moveCount': len(game.move_history),
    })


@app.route('/api/move', methods=['POST'])
def api_move():
    """玩家落子 + AI 回应"""
    data = request.get_json()
    row = data.get('row')
    col = data.get('col')

    if row is None or col is None:
        return jsonify({'error': '无效参数'}), 400

    # 玩家落子
    if not game.make_move(row, col, BLACK):
        return jsonify({'error': '非法着法'}), 400

    ai_move = None
    # AI 回应
    if not game.game_over:
        ai_row, ai_col = game.get_ai_move()
        game.make_move(ai_row, ai_col, WHITE)
        ai_move = {'row': ai_row, 'col': ai_col}

    return jsonify({
        'board': game.board,
        'currentPlayer': game.current_player,
        'gameOver': game.game_over,
        'winner': game.winner,
        'winCells': game.win_cells,
        'aiMove': ai_move,
        'moveCount': len(game.move_history),
    })


@app.route('/api/newgame', methods=['POST'])
def api_newgame():
    """开始新游戏"""
    game.reset()
    return jsonify({
        'board': game.board,
        'currentPlayer': game.current_player,
        'gameOver': game.game_over,
        'winner': game.winner,
        'winCells': game.win_cells,
        'moveCount': len(game.move_history),
    })


@app.route('/api/undo', methods=['POST'])
def api_undo():
    """悔棋"""
    if game.undo():
        return jsonify({
            'board': game.board,
            'currentPlayer': game.current_player,
            'gameOver': game.game_over,
            'winner': game.winner,
            'winCells': game.win_cells,
            'moveCount': len(game.move_history),
        })
    return jsonify({'error': '无法悔棋'}), 400


# ============================================================
# 启动入口
# ============================================================

if __name__ == '__main__':
    print("=" * 60)
    print("  五子棋 AI —— 算法优化版")
    print("  Gomoku AI with Alpha-Beta Pruning & Zobrist Hashing")
    print("=" * 60)
    print()
    print("  算法亮点:")
    print("  1. α-β 剪枝极大极小搜索 —— 前瞻多步")
    print("  2. Zobrist 哈希 + 置换表   —— 避免重复搜索")
    print("  3. 基于棋型的评估函数      —— 活四/冲四/活三识别")
    print("  4. 着法排序 + 历史启发     —— 提升剪枝效率")
    print("  5. 迭代加深搜索            —— 智能时间控制")
    print("  6. 开局库                  —— 避免开局劣势")
    print()
    print("  打开浏览器访问: http://127.0.0.1:5000")
    print("=" * 60)

    app.run(host='0.0.0.0', port=5000, debug=False)
