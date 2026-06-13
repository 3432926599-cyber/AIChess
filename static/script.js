/* ============================================================
   AIChess — 纯前端 JS 版 (Dark Terminal + 移动端适配)
   ============================================================
   AI 引擎完整保留，UI 层响应式改造
   ============================================================ */

// ==================== 常量 ====================
const BOARD_SIZE = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

const MAX_DEPTH = 6;
const TIME_LIMIT = 1.5;
const CANDIDATE_RADIUS = 2;

const SCORE_FIVE       = 10000000;
const SCORE_OPEN_FOUR  = 500000;
const SCORE_RUSH_FOUR  = 12000;
const SCORE_OPEN_THREE = 5000;
const SCORE_SLEEP_THREE = 800;
const SCORE_OPEN_TWO   = 300;
const SCORE_SLEEP_TWO  = 50;
const SCORE_OPEN_ONE   = 15;

const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]];

// ==================== 种子随机数 ====================
function createRNG(seed) {
    let s = seed | 0;
    return function() {
        s = s + 0x6D2B79F5 | 0;
        let t = Math.imul(s ^ s >>> 15, 1 | s);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function rand64(rng) {
    const high = Math.floor(rng() * 0x100000000);
    const low  = Math.floor(rng() * 0x100000000);
    return (BigInt(high) << 32n) | BigInt(low);
}

// ==================== Zobrist 哈希 ====================
class Zobrist {
    constructor() {
        const rng = createRNG(42);
        this.table = [];
        for (let r = 0; r < BOARD_SIZE; r++) {
            this.table[r] = [];
            for (let c = 0; c < BOARD_SIZE; c++) {
                this.table[r][c] = [0n, 0n, 0n];
                for (let p = 0; p < 3; p++) {
                    this.table[r][c][p] = rand64(rng);
                }
            }
        }
        this.sideKey = rand64(rng);
    }

    hash(board, player) {
        let h = 0n;
        for (let r = 0; r < BOARD_SIZE; r++)
            for (let c = 0; c < BOARD_SIZE; c++)
                if (board[r][c] !== EMPTY) h ^= this.table[r][c][board[r][c]];
        if (player === BLACK) h ^= this.sideKey;
        return h;
    }

    update(oldHash, row, col, player) {
        return oldHash ^ this.table[row][col][player] ^ this.sideKey;
    }
}

// ==================== 置换表 ====================
class TranspositionTable {
    static EXACT = 0;
    static ALPHA = 1;
    static BETA  = 2;

    constructor(maxSize = 1 << 18) {
        this.maxSize = maxSize;
        this.table = new Map();
        this.accessCount = 0;
        this.hitCount = 0;
    }

    store(zhash, depth, score, flag, bestMove = null) {
        if (this.table.size >= this.maxSize) this.table.clear();
        this.table.set(zhash, [depth, score, flag, bestMove]);
    }

    lookup(zhash) {
        this.accessCount++;
        const entry = this.table.get(zhash);
        if (entry !== undefined) { this.hitCount++; return entry; }
        return null;
    }

    clear() { this.table.clear(); this.accessCount = 0; this.hitCount = 0; }
}

// ==================== 开局库 ====================
class OpeningBook {
    static BOOKS = {
        huayue:  [[7,7],[7,8],[8,6],[6,6],[9,7],[8,7]],
        puyue:   [[7,7],[7,8],[6,8],[6,7],[8,8],[8,7]],
        shuxing: [[7,7],[7,8],[8,8],[6,6]],
        ruixing: [[7,7],[7,8],[8,7],[6,8]],
        xieyue:  [[7,7],[7,8],[8,6],[6,8]],
    };

    constructor() {
        const keys = Object.keys(OpeningBook.BOOKS);
        this.bookMoves = OpeningBook.BOOKS[keys[Math.floor(Math.random() * keys.length)]];
    }

    getMove(board, moveCount) {
        if (moveCount >= this.bookMoves.length) return null;
        for (let i = 0; i < moveCount; i++) {
            const [r, c] = this.bookMoves[i];
            const expected = i % 2 === 0 ? BLACK : WHITE;
            if (board[r][c] !== expected) return null;
        }
        const [r, c] = this.bookMoves[moveCount];
        return board[r][c] === EMPTY ? [r, c] : null;
    }
}

// ==================== AI 引擎 ====================
class GomokuAI {
    constructor() {
        this.zobrist = new Zobrist();
        this.tt = new TranspositionTable();
        this.openingBook = new OpeningBook();
        this.history = Array.from({length: BOARD_SIZE}, () => new Int32Array(BOARD_SIZE));
        this.killers = Array.from({length: MAX_DEPTH + 2}, () => [null, null]);
        this.nodesSearched = 0;
        this.searchStartTime = 0;
        this.timeUp = false;
    }

    checkWin(board, row, col, player) {
        for (const [dr, dc] of DIRECTIONS) {
            let count = 1;
            for (let step = 1; step < 5; step++) {
                const nr = row + dr * step, nc = col + dc * step;
                if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && board[nr][nc] === player) count++;
                else break;
            }
            for (let step = 1; step < 5; step++) {
                const nr = row - dr * step, nc = col - dc * step;
                if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && board[nr][nc] === player) count++;
                else break;
            }
            if (count >= 5) return true;
        }
        return false;
    }

    static analyzeLine(board, row, col, dr, dc, player) {
        let count = 1, openLeft = false, openRight = false, spaceLeft = 0, spaceRight = 0;
        for (let step = 1; step < 5; step++) {
            const nr = row + dr * step, nc = col + dc * step;
            if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE) {
                if (board[nr][nc] === player) { count++; }
                else if (board[nr][nc] === EMPTY) {
                    openRight = true;
                    const nnr = nr + dr, nnc = nc + dc;
                    if (nnr >= 0 && nnr < BOARD_SIZE && nnc >= 0 && nnc < BOARD_SIZE && board[nnr][nnc] === player) spaceRight = 1;
                    break;
                } else break;
            } else break;
        }
        for (let step = 1; step < 5; step++) {
            const nr = row - dr * step, nc = col - dc * step;
            if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE) {
                if (board[nr][nc] === player) { count++; }
                else if (board[nr][nc] === EMPTY) {
                    openLeft = true;
                    const nnr = nr - dr, nnc = nc - dc;
                    if (nnr >= 0 && nnr < BOARD_SIZE && nnc >= 0 && nnc < BOARD_SIZE && board[nnr][nnc] === player) spaceLeft = 1;
                    break;
                } else break;
            } else break;
        }
        return [count, openLeft, openRight, spaceLeft, spaceRight];
    }

    static scorePattern(count, openLeft, openRight, spaceLeft, spaceRight) {
        if (count >= 5) return SCORE_FIVE;
        if (count === 4) {
            if (openLeft && openRight) return SCORE_OPEN_FOUR;
            if (openLeft || openRight) return SCORE_RUSH_FOUR;
            return SCORE_SLEEP_THREE;
        }
        if (count === 3) {
            if (openLeft && openRight) {
                if (spaceLeft === 0 && spaceRight === 0) return SCORE_OPEN_THREE;
                return SCORE_SLEEP_THREE;
            }
            if (openLeft || openRight) return SCORE_SLEEP_THREE;
            return SCORE_OPEN_TWO;
        }
        if (count === 2) {
            if (openLeft && openRight) return SCORE_OPEN_TWO;
            if (openLeft || openRight) return SCORE_SLEEP_TWO;
            return 0;
        }
        if (count === 1) { if (openLeft && openRight) return SCORE_OPEN_ONE; return 0; }
        return 0;
    }

    evaluate(board, player) {
        const opponent = player === BLACK ? WHITE : BLACK;
        let myScore = 0, opScore = 0;
        const evaluated = new Set();
        for (let r = 0; r < BOARD_SIZE; r++) {
            for (let c = 0; c < BOARD_SIZE; c++) {
                const piece = board[r][c];
                if (piece === EMPTY) continue;
                for (let d = 0; d < DIRECTIONS.length; d++) {
                    const lineKey = r * 10000 + c * 10 + d;
                    if (evaluated.has(lineKey)) continue;
                    evaluated.add(lineKey);
                    const [dr, dc] = DIRECTIONS[d];
                    const [count, ol, openR, sl, sr] = GomokuAI.analyzeLine(board, r, c, dr, dc, piece);
                    const s = GomokuAI.scorePattern(count, ol, openR, sl, sr);
                    if (piece === player) { myScore += s; if (count >= 4 && (ol || openR)) myScore += 5000; }
                    else { opScore += s; if (count >= 4 && (ol || openR)) opScore += 5000; }
                }
            }
        }
        // 攻守平衡：己方 1.05× 鼓励进攻，取代 opScore*1.35 的过度防守偏见
        return myScore * 1.05 - opScore;
    }

    generateMoves(board) {
        const candidates = new Set();
        let hasStone = false;
        for (let r = 0; r < BOARD_SIZE; r++) {
            for (let c = 0; c < BOARD_SIZE; c++) {
                if (board[r][c] !== EMPTY) {
                    hasStone = true;
                    for (let dr = -CANDIDATE_RADIUS; dr <= CANDIDATE_RADIUS; dr++) {
                        for (let dc = -CANDIDATE_RADIUS; dc <= CANDIDATE_RADIUS; dc++) {
                            const nr = r + dr, nc = c + dc;
                            if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && board[nr][nc] === EMPTY)
                                candidates.add((nr << 4) | nc);
                        }
                    }
                }
            }
        }
        if (!hasStone) candidates.add(((BOARD_SIZE >> 1) << 4) | (BOARD_SIZE >> 1));
        return Array.from(candidates).map(k => [k >> 4, k & 0xF]);
    }

    orderMoves(moves, board, player, depth, hashMove) {
        const center = BOARD_SIZE >> 1;
        const scored = [];
        for (const [r, c] of moves) {
            let score = 0;
            if (hashMove && hashMove[0] === r && hashMove[1] === c) score = 10000000;
            else if (this.killers[depth][0] && this.killers[depth][0][0] === r && this.killers[depth][0][1] === c) score = 9000000;
            else if (this.killers[depth][1] && this.killers[depth][1][0] === r && this.killers[depth][1][1] === c) score = 8000000;
            else score = this.history[r][c];
            const dist = Math.abs(r - center) + Math.abs(c - center);
            score += Math.max(0, 14 - dist) * 10;
            for (const [dr, dc] of DIRECTIONS) {
                const [count, ol, openR] = GomokuAI.analyzeLine(board, r, c, dr, dc, player);
                score += count * count * 5;
                if (ol) score += 10;
                if (openR) score += 10;
            }
            scored.push([score, r, c]);
        }
        scored.sort((a, b) => b[0] - a[0]);
        return scored.map(([, r, c]) => [r, c]);
    }

    alphaBeta(board, depth, alpha, beta, player, zhash) {
        this.nodesSearched++;
        if (this.nodesSearched % 1000 === 0) {
            if (performance.now() - this.searchStartTime > TIME_LIMIT * 1000) { this.timeUp = true; return [0, null]; }
        }
        let ttMove = null;
        const ttEntry = this.tt.lookup(zhash);
        if (ttEntry !== null) {
            const [ttDepth, ttScore, ttFlag, ttBestMove] = ttEntry;
            ttMove = ttBestMove;
            if (ttDepth >= depth) {
                if (ttFlag === TranspositionTable.EXACT) return [ttScore, ttMove];
                if (ttFlag === TranspositionTable.ALPHA && ttScore <= alpha) return [ttScore, ttMove];
                if (ttFlag === TranspositionTable.BETA && ttScore >= beta) return [ttScore, ttMove];
            }
        }
        const moves = this.generateMoves(board);
        if (depth === 0 || moves.length === 0) return [this.evaluate(board, player), null];
        const opponent = player === BLACK ? WHITE : BLACK;
        const orderedMoves = this.orderMoves(moves, board, player, depth, ttMove);
        let bestMove = null, bestScore = -Infinity, flag = TranspositionTable.ALPHA;
        for (const [r, c] of orderedMoves) {
            if (this.timeUp) break;
            board[r][c] = player;
            if (this.checkWin(board, r, c, player)) {
                board[r][c] = EMPTY;
                const winScore = SCORE_FIVE + depth * 1000;
                this.tt.store(zhash, depth, winScore, TranspositionTable.EXACT, [r, c]);
                return [winScore, [r, c]];
            }
            const newZhash = this.zobrist.update(zhash, r, c, player);
            const [score] = this.alphaBeta(board, depth - 1, -beta, -alpha, opponent, newZhash);
            const negScore = -score;
            board[r][c] = EMPTY;
            if (this.timeUp) break;
            if (negScore > bestScore) { bestScore = negScore; bestMove = [r, c]; }
            if (negScore > alpha) { alpha = negScore; flag = TranspositionTable.EXACT; this.history[r][c] += depth * depth; }
            if (alpha >= beta) {
                flag = TranspositionTable.BETA;
                if (!this.killers[depth][0] || this.killers[depth][0][0] !== r || this.killers[depth][0][1] !== c) {
                    this.killers[depth][1] = this.killers[depth][0];
                    this.killers[depth][0] = [r, c];
                }
                this.history[r][c] += depth * depth * 2;
                break;
            }
        }
        if (bestMove !== null && !this.timeUp) this.tt.store(zhash, depth, bestScore, flag, bestMove);
        return [bestScore, bestMove];
    }

    // ---- 获胜着法检测（攻击优先） ----
    findWinningMoves(board, player) {
        const wins = new Set();
        for (let r = 0; r < BOARD_SIZE; r++) {
            for (let c = 0; c < BOARD_SIZE; c++) {
                if (board[r][c] !== EMPTY) continue;
                board[r][c] = player;
                // 直接成五？
                if (this.checkWin(board, r, c, player)) {
                    wins.add((r << 4) | c);
                } else {
                    // 形成活四？（两端开放，无法封堵的必胜着法）
                    for (const [dr, dc] of DIRECTIONS) {
                        const [count, ol, openR] = GomokuAI.analyzeLine(board, r, c, dr, dc, player);
                        if (count === 4 && ol && openR) { wins.add((r << 4) | c); break; }
                    }
                }
                board[r][c] = EMPTY;
            }
        }
        return Array.from(wins).map(k => [k >> 4, k & 0xF]);
    }

    findBlockingMoves(board, opponent) {
        const blocks = new Set();
        for (let r = 0; r < BOARD_SIZE; r++) {
            for (let c = 0; c < BOARD_SIZE; c++) {
                if (board[r][c] !== EMPTY) continue;
                board[r][c] = opponent;
                if (this.checkWin(board, r, c, opponent)) { blocks.add((r << 4) | c); }
                else {
                    for (const [dr, dc] of DIRECTIONS) {
                        const [count, ol, openR] = GomokuAI.analyzeLine(board, r, c, dr, dc, opponent);
                        if (count >= 5 || (count >= 4 && (ol || openR))) { blocks.add((r << 4) | c); break; }
                    }
                }
                board[r][c] = EMPTY;
            }
        }
        return Array.from(blocks).map(k => [k >> 4, k & 0xF]);
    }

    search(board, player, moveCount) {
        const opponent = player === BLACK ? WHITE : BLACK;

        // ★ 第 0 优先级：直接获胜（先看自己能不能赢）
        const wins = this.findWinningMoves(board, player);
        if (wins.length > 0) {
            for (const [wr, wc] of wins) {
                board[wr][wc] = player;
                if (this.checkWin(board, wr, wc, player)) {
                    board[wr][wc] = EMPTY;
                    console.log('[AI] 🔥 直接成五取胜！', wr, wc);
                    return [wr, wc];
                }
                board[wr][wc] = EMPTY;
            }
            console.log('[AI] 🔥 活四必胜！', wins[0]);
            return wins[0];
        }

        // 第 1 优先级：紧急防守（自己赢不了才封堵对手）
        const blocks = this.findBlockingMoves(board, opponent);
        if (blocks.length > 0) {
            if (blocks.length === 1) { console.log('[AI] 🛡️ 紧急封堵', blocks[0]); return blocks[0]; }
            let bestBlock = null, bestVal = -Infinity;
            for (const [br, bc] of blocks) {
                board[br][bc] = player; const val = this.evaluate(board, player); board[br][bc] = EMPTY;
                if (val > bestVal) { bestVal = val; bestBlock = [br, bc]; }
            }
            console.log('[AI] 🛡️ 最佳封堵', bestBlock);
            return bestBlock;
        }
        if (moveCount <= 3) { const bm = this.openingBook.getMove(board, moveCount); if (bm !== null) return bm; }
        this.searchStartTime = performance.now();
        this.timeUp = false;
        this.nodesSearched = 0;
        const zhash = this.zobrist.hash(board, player);
        let bestMove = null, bestScore = null, completedDepth = 0;
        try {
            for (let depth = 1; depth <= MAX_DEPTH; depth++) {
                if (this.timeUp) break;
                const [score, move] = this.alphaBeta(board, depth, -Infinity, Infinity, player, zhash);
                if (!this.timeUp) { bestScore = score; if (move !== null) bestMove = move; completedDepth = depth; }
                if (bestScore !== null && bestScore >= SCORE_FIVE) break;
                if (depth < 2 && moveCount <= 6) continue;
            }
        } catch (e) { console.warn('Search error:', e); }
        const elapsed = (performance.now() - this.searchStartTime) / 1000;
        console.log(`[AI] depth=${completedDepth}, nodes=${this.nodesSearched}, time=${elapsed.toFixed(2)}s, move=[${bestMove}]`);
        if (bestMove === null) bestMove = this.fallbackMove(board, player);
        return bestMove;
    }

    fallbackMove(board, player) {
        let bestScore = -Infinity, bestMove = null;
        for (let r = 0; r < BOARD_SIZE; r++)
            for (let c = 0; c < BOARD_SIZE; c++)
                if (board[r][c] === EMPTY) {
                    board[r][c] = player; const score = this.evaluate(board, player); board[r][c] = EMPTY;
                    if (score > bestScore) { bestScore = score; bestMove = [r, c]; }
                }
        return bestMove || [(BOARD_SIZE >> 1), (BOARD_SIZE >> 1)];
    }

    reset() {
        this.tt.clear();
        this.history = Array.from({length: BOARD_SIZE}, () => new Int32Array(BOARD_SIZE));
        this.killers = Array.from({length: MAX_DEPTH + 2}, () => [null, null]);
        this.openingBook = new OpeningBook();
    }
}

// ==================== 游戏状态管理 ====================
class GomokuGame {
    constructor() {
        this.ai = new GomokuAI();
        this.reset();
    }

    reset() {
        this.board = Array.from({length: BOARD_SIZE}, () => new Int8Array(BOARD_SIZE));
        this.currentPlayer = BLACK;
        this.moveHistory = [];
        this.gameOver = false;
        this.winner = null;
        this.winCells = [];
        this.ai.reset();
    }

    isValidMove(row, col) {
        return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE
            && this.board[row][col] === EMPTY && !this.gameOver;
    }

    makeMove(row, col, player = null) {
        if (player === null) player = this.currentPlayer;
        if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE
            || this.board[row][col] !== EMPTY || this.gameOver) return false;
        this.board[row][col] = player;
        this.moveHistory.push([row, col, player]);
        if (this.ai.checkWin(this.board, row, col, player)) {
            this.gameOver = true; this.winner = player;
            this.findWinCells(row, col, player);
        } else if (this.moveHistory.length === BOARD_SIZE * BOARD_SIZE) {
            this.gameOver = true; this.winner = null;
        }
        this.currentPlayer = player === BLACK ? WHITE : BLACK;
        return true;
    }

    findWinCells(row, col, player) {
        for (const [dr, dc] of DIRECTIONS) {
            const cells = [[row, col]];
            for (let step = 1; step < 5; step++) {
                const nr = row + dr * step, nc = col + dc * step;
                if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && this.board[nr][nc] === player) cells.push([nr, nc]);
                else break;
            }
            for (let step = 1; step < 5; step++) {
                const nr = row - dr * step, nc = col - dc * step;
                if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && this.board[nr][nc] === player) cells.push([nr, nc]);
                else break;
            }
            if (cells.length >= 5) { this.winCells = cells.slice(0, 5); return; }
        }
    }

    undo() {
        if (this.moveHistory.length >= 2) {
            for (let i = 0; i < 2; i++) {
                const [r, c] = this.moveHistory.pop();
                this.board[r][c] = EMPTY;
            }
            this.currentPlayer = BLACK;
            this.gameOver = false; this.winner = null; this.winCells = [];
            return true;
        }
        return false;
    }

    getAiMove() { return this.ai.search(this.board, WHITE, this.moveHistory.length); }
}

// ================================================================
//                         UI 层（响应式改造）
// ================================================================

const MARGIN = 20;
const MAX_CELL_SIZE = 40;   // 桌面端更大
let CELL_SIZE = MAX_CELL_SIZE;
let STONE_RADIUS = 18;
let canvasSize = BOARD_SIZE * CELL_SIZE + MARGIN * 2;

const canvas = document.getElementById('boardCanvas');
const ctx = canvas.getContext('2d');

const game = new GomokuGame();
let lastMove = null;
let aiThinking = false;
let hoverPos = null;

// ---- Canvas 尺寸自适应 ----
function computeSizes() {
    const bw = document.querySelector('.board-wrapper');
    const wrapperWidth = bw ? bw.clientWidth - 26 : window.innerWidth;
    const maxWidth = Math.min(wrapperWidth, 620);
    const idealSize = Math.floor((maxWidth - MARGIN * 2) / (BOARD_SIZE - 1));
    CELL_SIZE = Math.min(MAX_CELL_SIZE, Math.max(idealSize, 18));
    STONE_RADIUS = CELL_SIZE * 0.44;
    canvasSize = BOARD_SIZE * CELL_SIZE + MARGIN * 2;
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    canvas.style.width = canvasSize + 'px';
    canvas.style.height = canvasSize + 'px';
}

// ---- 绘制 ----
function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGrid();
    drawStones();
    if (lastMove) drawLastMoveMarker();
    if (game.winCells.length > 0) drawWinHighlight();
    if (hoverPos && !aiThinking && game.currentPlayer === BLACK && !game.gameOver) drawHoverStone();
}

function drawGrid() {
    // 棋盘底色
    ctx.fillStyle = '#121212';
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    // 外框
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(MARGIN - 2, MARGIN - 2, (BOARD_SIZE - 1) * CELL_SIZE + 4, (BOARD_SIZE - 1) * CELL_SIZE + 4);

    // 网格线
    ctx.strokeStyle = '#252525';
    ctx.lineWidth = 0.8;
    for (let i = 0; i < BOARD_SIZE; i++) {
        const pos = MARGIN + i * CELL_SIZE;
        ctx.beginPath(); ctx.moveTo(MARGIN, pos); ctx.lineTo(MARGIN + (BOARD_SIZE - 1) * CELL_SIZE, pos); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(pos, MARGIN); ctx.lineTo(pos, MARGIN + (BOARD_SIZE - 1) * CELL_SIZE); ctx.stroke();
    }

    // 星位
    const starPoints = [[3,3],[3,7],[3,11],[7,3],[7,7],[7,11],[11,3],[11,7],[11,11]];
    ctx.fillStyle = '#3a3a3a';
    for (const [r, c] of starPoints) {
        ctx.beginPath();
        ctx.arc(MARGIN + c * CELL_SIZE, MARGIN + r * CELL_SIZE, CELL_SIZE * 0.09, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawStones() {
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const piece = game.board[r][c];
            if (!piece) continue;
            const cx = MARGIN + c * CELL_SIZE;
            const cy = MARGIN + r * CELL_SIZE;

            // 阴影
            ctx.beginPath();
            ctx.arc(cx + 1.5, cy + 1.5, STONE_RADIUS, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(0,0,0,0.25)';
            ctx.fill();

            // 棋子主体渐变
            const grad = ctx.createRadialGradient(
                cx - STONE_RADIUS * 0.3, cy - STONE_RADIUS * 0.35, STONE_RADIUS * 0.08,
                cx, cy, STONE_RADIUS
            );
            if (piece === BLACK) {
                // 绿子 — 终端光标色
                grad.addColorStop(0, '#7ed87e');
                grad.addColorStop(0.35, '#4faf4f');
                grad.addColorStop(0.7, '#3a8f3a');
                grad.addColorStop(1, '#1e5e1e');
            } else {
                // 琥珀子 — 第二强调色
                grad.addColorStop(0, '#f0d68a');
                grad.addColorStop(0.35, '#d7af5f');
                grad.addColorStop(0.7, '#b8903a');
                grad.addColorStop(1, '#7a6020');
            }
            ctx.beginPath();
            ctx.arc(cx, cy, STONE_RADIUS, 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.fill();

            // 高光
            ctx.beginPath();
            ctx.arc(cx - STONE_RADIUS * 0.28, cy - STONE_RADIUS * 0.28, STONE_RADIUS * 0.18, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.10)';
            ctx.fill();
        }
    }
}

function drawLastMoveMarker() {
    if (!lastMove) return;
    const cx = MARGIN + lastMove.col * CELL_SIZE;
    const cy = MARGIN + lastMove.row * CELL_SIZE;
    // 外圈
    ctx.beginPath();
    ctx.arc(cx, cy, STONE_RADIUS * 0.45, 0, Math.PI * 2);
    ctx.strokeStyle = '#d7af5f';
    ctx.lineWidth = 2;
    ctx.stroke();
    // 内点
    ctx.beginPath();
    ctx.arc(cx, cy, STONE_RADIUS * 0.18, 0, Math.PI * 2);
    ctx.fillStyle = '#d7af5f';
    ctx.fill();
}

function drawHoverStone() {
    const cx = MARGIN + hoverPos.col * CELL_SIZE;
    const cy = MARGIN + hoverPos.row * CELL_SIZE;
    if (game.board[hoverPos.row][hoverPos.col] !== EMPTY) return;
    ctx.beginPath();
    ctx.arc(cx, cy, STONE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(79, 175, 79, 0.15)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(79, 175, 79, 0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
}

function drawWinHighlight() {
    for (const [r, c] of game.winCells) {
        const cx = MARGIN + c * CELL_SIZE;
        const cy = MARGIN + r * CELL_SIZE;
        ctx.beginPath();
        ctx.arc(cx, cy, STONE_RADIUS + 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(215, 175, 95, 0.12)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx, cy, STONE_RADIUS + 3, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(215, 175, 95, 0.55)';
        ctx.lineWidth = 2;
        ctx.stroke();
    }
}

// ---- 事件处理 ----
function getBoardPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvasSize / rect.width;
    const scaleY = canvasSize / rect.height;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const mx = (clientX - rect.left) * scaleX;
    const my = (clientY - rect.top) * scaleY;
    const col = Math.round((mx - MARGIN) / CELL_SIZE);
    const row = Math.round((my - MARGIN) / CELL_SIZE);
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return null;
    const cx = MARGIN + col * CELL_SIZE;
    const cy = MARGIN + row * CELL_SIZE;
    const dist = Math.sqrt((mx - cx) ** 2 + (my - cy) ** 2);
    if (dist < STONE_RADIUS + 3) return { row, col };
    return null;
}

async function handleClick(e) {
    const pos = getBoardPos(e);
    if (!pos) return;
    if (game.board[pos.row][pos.col] !== EMPTY) return;
    if (aiThinking || game.gameOver || game.currentPlayer !== BLACK) return;

    // 玩家落子
    game.makeMove(pos.row, pos.col, BLACK);
    lastMove = { row: pos.row, col: pos.col, isAI: false };
    draw();
    updateUI();

    if (game.gameOver) { showWinDialog(); return; }

    // AI 回应
    aiThinking = true;
    updateUI();
    draw();

    await new Promise(r => setTimeout(r, 80));

    const [aiRow, aiCol] = game.getAiMove();
    game.makeMove(aiRow, aiCol, WHITE);
    lastMove = { row: aiRow, col: aiCol, isAI: true };

    aiThinking = false;
    draw();
    updateUI();

    if (game.gameOver) showWinDialog();
}

function handleMouseMove(e) {
    if (aiThinking || game.gameOver) return;
    const pos = getBoardPos(e);
    if (pos && game.board[pos.row][pos.col] === EMPTY) {
        if (!hoverPos || hoverPos.row !== pos.row || hoverPos.col !== pos.col) { hoverPos = pos; draw(); }
    } else if (hoverPos) { hoverPos = null; draw(); }
}

function newGame() {
    game.reset();
    lastMove = null; aiThinking = false; hoverPos = null;
    document.getElementById('overlay').classList.add('hidden');
    draw(); updateUI();
}

function undo() {
    if (aiThinking || game.moveHistory.length < 2) return;
    game.undo();
    lastMove = null; hoverPos = null;
    draw(); updateUI();
}

function updateUI() {
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const statusCard = document.getElementById('statusCard');
    const moveCount = document.getElementById('moveCount');
    const btnNewGame = document.getElementById('btnNewGame');
    const btnUndo = document.getElementById('btnUndo');

    moveCount.textContent = game.moveHistory.length;
    statusDot.className = 'status-dot';
    statusCard.classList.remove('ai-thinking');

    if (game.gameOver) {
        statusDot.classList.add('game-over');
        statusText.textContent = game.winner === BLACK ? '你赢了' : game.winner === WHITE ? 'AI 获胜' : '平局';
    } else if (aiThinking) {
        statusDot.classList.add('black-turn');
        statusCard.classList.add('ai-thinking');
        statusText.textContent = 'AI 思考中…';
    } else if (game.currentPlayer === BLACK) {
        statusDot.classList.add('black-turn');
        statusText.textContent = '你的回合';
    } else {
        statusDot.classList.add('white-turn');
        statusText.textContent = 'AI 回合';
    }

    btnNewGame.disabled = false;
    btnUndo.disabled = (game.moveHistory.length < 2 || aiThinking);
}

function showWinDialog() {
    const overlay = document.getElementById('overlay');
    const winIcon = document.getElementById('winIcon');
    const winText = document.getElementById('winText');
    const winSub = document.getElementById('winSub');

    if (game.winner === BLACK) {
        winIcon.textContent = '[ VICTORY ]';
        winText.textContent = '你赢了！';
        winSub.textContent = `战胜 AI，共 ${game.moveHistory.length} 步`;
    } else if (game.winner === WHITE) {
        winIcon.textContent = '[ GAME OVER ]';
        winText.textContent = 'AI 获胜';
        winSub.textContent = `再接再厉，共 ${game.moveHistory.length} 步`;
    } else {
        winIcon.textContent = '[ DRAW ]';
        winText.textContent = '平局';
        winSub.textContent = '棋盘已满，不分胜负';
    }
    overlay.classList.remove('hidden');
}

function toggleLegend() {
    document.getElementById('legendList').classList.toggle('collapsed');
    document.getElementById('legendToggle').classList.toggle('open');
}

// --vh polyfill（微信 X5 兼容）
function setVh() {
    document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
}

// ---- 初始化 ----
function init() {
    computeSizes();

    canvas.addEventListener('click', handleClick);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', () => { hoverPos = null; draw(); });
    document.getElementById('btnNewGame').addEventListener('click', newGame);
    document.getElementById('btnUndo').addEventListener('click', undo);
    document.getElementById('legendHeader').addEventListener('click', toggleLegend);

    window.addEventListener('resize', () => { computeSizes(); draw(); });

    // --vh polyfill
    setVh();
    window.addEventListener('resize', () => requestAnimationFrame(setVh));

    draw();
    updateUI();
}

init();
