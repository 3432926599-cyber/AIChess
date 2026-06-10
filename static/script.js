/* ============================================================
   五子棋 AI — 前端交互逻辑
   ============================================================ */

const BOARD_SIZE = 15;
const CELL_SIZE = 36;
const MARGIN = 20;
const STONE_RADIUS = 15;

const canvas = document.getElementById('boardCanvas');
const ctx = canvas.getContext('2d');

// Canvas 尺寸
const canvasSize = BOARD_SIZE * CELL_SIZE + MARGIN * 2;
canvas.width = canvasSize;
canvas.height = canvasSize;
canvas.style.width = canvasSize + 'px';
canvas.style.height = canvasSize + 'px';

// --- 游戏状态 ---
let gameState = {
    board: [],
    currentPlayer: 1,  // 1=黑(玩家), 2=白(AI)
    gameOver: false,
    winner: null,
    winCells: [],
    moveCount: 0,
};

let lastMove = null;      // {row, col} 最新落子
let aiThinking = false;
let hoverPos = null;      // {row, col} 鼠标悬停位置

// --- 初始化 ---
function init() {
    canvas.addEventListener('click', handleClick);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', () => { hoverPos = null; draw(); });
    document.getElementById('btnNewGame').addEventListener('click', newGame);
    document.getElementById('btnUndo').addEventListener('click', undo);

    // 加载初始状态
    loadState();
}

// --- API 调用 ---
async function callApi(url, method = 'GET', body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(url, opts);
    return resp.json();
}

async function loadState() {
    gameState = await callApi('/api/state');
    lastMove = null;
    draw();
    updateUI();
}

async function makeMove(row, col) {
    if (aiThinking || gameState.gameOver) return;
    if (gameState.currentPlayer !== 1) return;  // 不是玩家回合

    aiThinking = true;
    updateUI();
    draw();

    const result = await callApi('/api/move', 'POST', { row, col });
    if (result.error) {
        aiThinking = false;
        updateUI();
        draw();
        return;
    }

    gameState = result;
    lastMove = result.aiMove
        ? { row: result.aiMove.row, col: result.aiMove.col, isAI: true }
        : null;

    aiThinking = false;
    draw();
    updateUI();

    if (gameState.gameOver) {
        showWinDialog();
    }
}

async function newGame() {
    gameState = await callApi('/api/newgame', 'POST');
    lastMove = null;
    aiThinking = false;
    document.getElementById('overlay').classList.add('hidden');
    draw();
    updateUI();
}

async function undo() {
    if (aiThinking || gameState.moveCount < 2) return;
    gameState = await callApi('/api/undo', 'POST');
    lastMove = null;
    draw();
    updateUI();
}

// --- Canvas 绘制 ---
function draw() {
    ctx.clearRect(0, 0, canvasSize, canvasSize);
    drawGrid();
    drawStones();
    if (lastMove) drawLastMoveMarker();
    if (gameState.winCells.length > 0) drawWinHighlight();
    if (hoverPos && !aiThinking && gameState.currentPlayer === 1 && !gameState.gameOver) {
        drawHoverStone();
    }
}

function drawGrid() {
    // 棋盘背景填充（通过 CSS 实现木纹）
    ctx.clearRect(0, 0, canvasSize, canvasSize);

    // 网格线
    ctx.strokeStyle = '#8b7355';
    ctx.lineWidth = 0.8;

    for (let i = 0; i < BOARD_SIZE; i++) {
        const pos = MARGIN + i * CELL_SIZE;

        // 水平线
        ctx.beginPath();
        ctx.moveTo(MARGIN, pos);
        ctx.lineTo(MARGIN + (BOARD_SIZE - 1) * CELL_SIZE, pos);
        ctx.stroke();

        // 垂直线
        ctx.beginPath();
        ctx.moveTo(pos, MARGIN);
        ctx.lineTo(pos, MARGIN + (BOARD_SIZE - 1) * CELL_SIZE);
        ctx.stroke();
    }

    // 星位（天元和四角星）
    const starPoints = [
        [3, 3], [3, 7], [3, 11],
        [7, 3], [7, 7], [7, 11],
        [11, 3], [11, 7], [11, 11],
    ];
    ctx.fillStyle = '#6b5540';
    for (const [r, c] of starPoints) {
        ctx.beginPath();
        ctx.arc(MARGIN + c * CELL_SIZE, MARGIN + r * CELL_SIZE, 3.2, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawStones() {
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const piece = gameState.board[r]?.[c];
            if (!piece) continue;

            const cx = MARGIN + c * CELL_SIZE;
            const cy = MARGIN + r * CELL_SIZE;

            // 阴影
            ctx.beginPath();
            ctx.arc(cx + 1.5, cy + 1.5, STONE_RADIUS, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(0,0,0,0.18)';
            ctx.fill();

            // 棋子主体
            const grad = ctx.createRadialGradient(
                cx - STONE_RADIUS * 0.3, cy - STONE_RADIUS * 0.35, STONE_RADIUS * 0.1,
                cx, cy, STONE_RADIUS
            );

            if (piece === 1) {
                // 黑子 — 墨色渐变
                grad.addColorStop(0, '#6a6a6a');
                grad.addColorStop(0.5, '#3a3a3a');
                grad.addColorStop(1, '#1a1a1a');
            } else {
                // 白子 — 暖玉色渐变
                grad.addColorStop(0, '#ffffff');
                grad.addColorStop(0.4, '#f8f4ec');
                grad.addColorStop(1, '#dcd5c8');
            }

            ctx.beginPath();
            ctx.arc(cx, cy, STONE_RADIUS, 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.fill();

            // 细边框
            ctx.strokeStyle = piece === 1 ? '#111' : '#c5bdaa';
            ctx.lineWidth = 0.6;
            ctx.stroke();
        }
    }
}

function drawLastMoveMarker() {
    if (!lastMove) return;
    const cx = MARGIN + lastMove.col * CELL_SIZE;
    const cy = MARGIN + lastMove.row * CELL_SIZE;

    ctx.beginPath();
    ctx.arc(cx, cy, STONE_RADIUS * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = lastMove.isAI ? '#3a3a3a' : '#c0392b';
    ctx.fill();
}

function drawHoverStone() {
    const cx = MARGIN + hoverPos.col * CELL_SIZE;
    const cy = MARGIN + hoverPos.row * CELL_SIZE;

    // 确保位置为空
    if (gameState.board[hoverPos.row]?.[hoverPos.col] !== 0) return;

    ctx.beginPath();
    ctx.arc(cx, cy, STONE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(30, 30, 30, 0.20)';
    ctx.fill();
}

function drawWinHighlight() {
    for (const [r, c] of gameState.winCells) {
        const cx = MARGIN + c * CELL_SIZE;
        const cy = MARGIN + r * CELL_SIZE;

        // 淡色光晕
        ctx.beginPath();
        ctx.arc(cx, cy, STONE_RADIUS + 3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(192, 57, 43, 0.18)';
        ctx.fill();

        // 细环
        ctx.beginPath();
        ctx.arc(cx, cy, STONE_RADIUS + 2, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(192, 57, 43, 0.55)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
}

// --- 事件处理 ---
function getBoardPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvasSize / rect.width;
    const scaleY = canvasSize / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;

    const col = Math.round((mx - MARGIN) / CELL_SIZE);
    const row = Math.round((my - MARGIN) / CELL_SIZE);

    // 检查是否在棋盘格点附近
    const cx = MARGIN + col * CELL_SIZE;
    const cy = MARGIN + row * CELL_SIZE;
    const dist = Math.sqrt((mx - cx) ** 2 + (my - cy) ** 2);

    if (dist < STONE_RADIUS + 2 &&
        row >= 0 && row < BOARD_SIZE &&
        col >= 0 && col < BOARD_SIZE) {
        return { row, col };
    }
    return null;
}

function handleClick(e) {
    const pos = getBoardPos(e);
    if (!pos) return;
    if (gameState.board[pos.row][pos.col] !== 0) return;

    makeMove(pos.row, pos.col);
}

function handleMouseMove(e) {
    const pos = getBoardPos(e);
    if (pos && gameState.board[pos.row][pos.col] === 0) {
        if (!hoverPos || hoverPos.row !== pos.row || hoverPos.col !== pos.col) {
            hoverPos = pos;
            draw();
        }
    } else if (hoverPos) {
        hoverPos = null;
        draw();
    }
}

// --- UI 更新 ---
function updateUI() {
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const statusCard = document.getElementById('statusCard');
    const moveCount = document.getElementById('moveCount');
    const btnNewGame = document.getElementById('btnNewGame');
    const btnUndo = document.getElementById('btnUndo');

    moveCount.textContent = gameState.moveCount;

    statusDot.className = 'status-dot';
    statusCard.classList.remove('ai-thinking');

    if (gameState.gameOver) {
        statusDot.classList.add('game-over');
        if (gameState.winner === 1) {
            statusText.textContent = '恭喜，你赢了！';
        } else if (gameState.winner === 2) {
            statusText.textContent = 'AI 获胜';
        } else {
            statusText.textContent = '平局';
        }
    } else if (aiThinking) {
        statusDot.classList.add('white-turn');
        statusCard.classList.add('ai-thinking');
        statusText.textContent = 'AI 思考中…';
    } else if (gameState.currentPlayer === 1) {
        statusDot.classList.add('black-turn');
        statusText.textContent = '你的回合（黑棋）';
    } else {
        statusDot.classList.add('white-turn');
        statusText.textContent = 'AI 计算中…';
    }

    btnNewGame.disabled = false;
    btnUndo.disabled = (gameState.moveCount < 2 || aiThinking);
}

function showWinDialog() {
    const overlay = document.getElementById('overlay');
    const winIcon = document.getElementById('winIcon');
    const winText = document.getElementById('winText');
    const winSub = document.getElementById('winSub');

    if (gameState.winner === 1) {
        winIcon.textContent = '🏆';
        winText.textContent = '恭喜获胜！';
        winSub.textContent = `你战胜了 AI，共 ${gameState.moveCount} 步`;
    } else if (gameState.winner === 2) {
        winIcon.textContent = '🤖';
        winText.textContent = 'AI 获胜';
        winSub.textContent = `再接再厉，共 ${gameState.moveCount} 步`;
    } else {
        winIcon.textContent = '🤝';
        winText.textContent = '平局';
        winSub.textContent = `棋盘已满，不分胜负`;
    }

    overlay.classList.remove('hidden');
}

// --- 启动 ---
init();
draw();
