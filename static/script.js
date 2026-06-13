/* ============================================================
   AIChess — 前端交互逻辑（响应式 + 移动端适配 + 乐观更新）
   ============================================================ */

const BOARD_SIZE = 15;
const MARGIN = 20;

// 动态计算
const MAX_CELL_SIZE = 38;
let CELL_SIZE = MAX_CELL_SIZE;
let STONE_RADIUS = 16;
let canvasSize = BOARD_SIZE * CELL_SIZE + MARGIN * 2;

const canvas = document.getElementById('boardCanvas');
const ctx = canvas.getContext('2d');

// --- Canvas 尺寸自适应 ---
function computeSizes() {
  const boardWrapper = document.querySelector('.board-wrapper');
  const wrapperWidth = boardWrapper ? boardWrapper.clientWidth - 26 : window.innerWidth;
  const maxWidth = Math.min(wrapperWidth, 600);
  const idealSize = Math.floor((maxWidth - MARGIN * 2) / (BOARD_SIZE - 1));

  CELL_SIZE = Math.min(MAX_CELL_SIZE, Math.max(idealSize, 18));
  STONE_RADIUS = CELL_SIZE * 0.44;
  canvasSize = BOARD_SIZE * CELL_SIZE + MARGIN * 2;

  canvas.width = canvasSize;
  canvas.height = canvasSize;
  canvas.style.width = canvasSize + 'px';
  canvas.style.height = canvasSize + 'px';
}

// --- 游戏状态 ---
let gameState = {
  board: Array.from({length: BOARD_SIZE}, () => Array(BOARD_SIZE).fill(0)),
  currentPlayer: 1,
  gameOver: false,
  winner: null,
  winCells: [],
  moveCount: 0,
};

let lastMove = null;
let aiThinking = false;
let hoverPos = null;
let pendingPlayerStone = null;  // 乐观更新：玩家刚落子位置

// --- 初始化 ---
function init() {
  computeSizes();

  canvas.addEventListener('click', handleClick);
  canvas.addEventListener('mousemove', handleMouseMove);
  canvas.addEventListener('mouseleave', () => { hoverPos = null; draw(); });

  document.getElementById('btnNewGame').addEventListener('click', newGame);
  document.getElementById('btnUndo').addEventListener('click', undo);
  document.getElementById('legendHeader').addEventListener('click', toggleLegend);

  window.addEventListener('resize', () => {
    computeSizes();
    draw();
  });

  // --vh polyfill
  setVh();
  window.addEventListener('resize', () => requestAnimationFrame(setVh));

  loadState();
}

function setVh() {
  document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
}

function toggleLegend() {
  const list = document.getElementById('legendList');
  const toggle = document.getElementById('legendToggle');
  list.classList.toggle('collapsed');
  toggle.classList.toggle('open');
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
  pendingPlayerStone = null;
  lastMove = null;
  draw();
  updateUI();
}

async function makeMove(row, col) {
  if (aiThinking || gameState.gameOver) return;
  if (gameState.currentPlayer !== 1) return;

  // ★ 乐观更新：立即在本地棋盘上显示玩家棋子
  gameState.board[row][col] = 1;
  pendingPlayerStone = { row, col };
  gameState.moveCount++;
  aiThinking = true;
  draw();
  updateUI();

  try {
    const result = await callApi('/api/move', 'POST', { row, col });

    if (result.error) {
      // 失败 → 回滚本地棋盘
      gameState.board[row][col] = 0;
      gameState.moveCount--;
      aiThinking = false;
      pendingPlayerStone = null;
      draw();
      updateUI();
      return;
    }

    // 用服务端权威状态覆盖
    gameState = result;
    pendingPlayerStone = null;
    lastMove = result.aiMove
      ? { row: result.aiMove.row, col: result.aiMove.col, isAI: true }
      : null;

    aiThinking = false;
    draw();
    updateUI();

    if (gameState.gameOver) {
      setTimeout(showWinDialog, 350);
    }
  } catch (err) {
    // 网络错误 → 回滚
    gameState.board[row][col] = 0;
    gameState.moveCount--;
    aiThinking = false;
    pendingPlayerStone = null;
    draw();
    updateUI();
  }
}

async function newGame() {
  gameState = await callApi('/api/newgame', 'POST');
  lastMove = null;
  pendingPlayerStone = null;
  aiThinking = false;
  document.getElementById('overlay').classList.add('hidden');
  draw();
  updateUI();
}

async function undo() {
  if (aiThinking || gameState.moveCount < 2) return;
  gameState = await callApi('/api/undo', 'POST');
  lastMove = null;
  pendingPlayerStone = null;
  draw();
  updateUI();
}

// --- Canvas 绘制 ---
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid();
  drawStones();

  // 玩家刚落子 → 琥珀色标记
  if (pendingPlayerStone) {
    drawMarker(pendingPlayerStone.row, pendingPlayerStone.col, '#d7af5f');
  }

  // 最新落子标记（AI 的最后一步）
  if (lastMove && !pendingPlayerStone) {
    drawMarker(lastMove.row, lastMove.col, lastMove.isAI ? '#d7af5f' : '#4faf4f');
  }

  if (gameState.winCells.length > 0) drawWinHighlight();
  if (hoverPos && !aiThinking && gameState.currentPlayer === 1 && !gameState.gameOver) {
    drawHoverStone();
  }
}

function drawGrid() {
  ctx.fillStyle = '#121212';
  ctx.fillRect(0, 0, canvasSize, canvasSize);

  // 边框（棋盘外框）
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(MARGIN - 2, MARGIN - 2,
    (BOARD_SIZE - 1) * CELL_SIZE + 4,
    (BOARD_SIZE - 1) * CELL_SIZE + 4);

  // 网格线
  ctx.strokeStyle = '#252525';
  ctx.lineWidth = 0.8;

  for (let i = 0; i < BOARD_SIZE; i++) {
    const pos = MARGIN + i * CELL_SIZE;

    ctx.beginPath();
    ctx.moveTo(MARGIN, pos);
    ctx.lineTo(MARGIN + (BOARD_SIZE - 1) * CELL_SIZE, pos);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(pos, MARGIN);
    ctx.lineTo(pos, MARGIN + (BOARD_SIZE - 1) * CELL_SIZE);
    ctx.stroke();
  }

  // 星位
  const starPoints = [
    [3, 3], [3, 7], [3, 11],
    [7, 3], [7, 7], [7, 11],
    [11, 3], [11, 7], [11, 11],
  ];
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
      const piece = gameState.board[r]?.[c];
      if (!piece) continue;

      const cx = MARGIN + c * CELL_SIZE;
      const cy = MARGIN + r * CELL_SIZE;

      // 棋子阴影
      ctx.beginPath();
      ctx.arc(cx + 1.5, cy + 1.5, STONE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fill();

      // 棋子主体 — 径向渐变
      const grad = ctx.createRadialGradient(
        cx - STONE_RADIUS * 0.3, cy - STONE_RADIUS * 0.35, STONE_RADIUS * 0.08,
        cx, cy, STONE_RADIUS
      );

      if (piece === 1) {
        // 黑子（玩家）— 绿色
        grad.addColorStop(0, '#7ed87e');
        grad.addColorStop(0.35, '#4faf4f');
        grad.addColorStop(0.7, '#3a8f3a');
        grad.addColorStop(1, '#1e5e1e');
      } else {
        // 白子（AI）— 琥珀色
        grad.addColorStop(0, '#f0d68a');
        grad.addColorStop(0.35, '#d7af5f');
        grad.addColorStop(0.7, '#b8903a');
        grad.addColorStop(1, '#7a6020');
      }

      ctx.beginPath();
      ctx.arc(cx, cy, STONE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

      // 高光点
      ctx.beginPath();
      ctx.arc(cx - STONE_RADIUS * 0.28, cy - STONE_RADIUS * 0.28,
        STONE_RADIUS * 0.18, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fill();
    }
  }
}

function drawMarker(row, col, color) {
  const cx = MARGIN + col * CELL_SIZE;
  const cy = MARGIN + row * CELL_SIZE;

  // 外圈
  ctx.beginPath();
  ctx.arc(cx, cy, STONE_RADIUS * 0.45, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  // 内点
  ctx.beginPath();
  ctx.arc(cx, cy, STONE_RADIUS * 0.18, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawHoverStone() {
  const cx = MARGIN + hoverPos.col * CELL_SIZE;
  const cy = MARGIN + hoverPos.row * CELL_SIZE;

  if ((gameState.board[hoverPos.row]?.[hoverPos.col] ?? 0) !== 0) return;

  ctx.beginPath();
  ctx.arc(cx, cy, STONE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(79, 175, 79, 0.15)';
  ctx.fill();

  ctx.strokeStyle = 'rgba(79, 175, 79, 0.3)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawWinHighlight() {
  for (const [r, c] of gameState.winCells) {
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

// --- 事件处理 ---
function getBoardPos(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvasSize / rect.width;
  const scaleY = canvasSize / rect.height;

  // 统一处理 mouse 和 touch
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

function handleClick(e) {
  const pos = getBoardPos(e);
  if (!pos) return;
  // 可选链防御初始空数组
  const cell = gameState.board[pos.row]?.[pos.col];
  if (cell == null || cell !== 0) return;
  makeMove(pos.row, pos.col);
}

function handleMouseMove(e) {
  if (aiThinking || gameState.gameOver) return;
  const pos = getBoardPos(e);
  if (pos && gameState.board[pos.row]?.[pos.col] === 0) {
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
    statusText.textContent = gameState.winner === 1 ? '你赢了' :
                             gameState.winner === 2 ? 'AI 获胜' : '平局';
  } else if (aiThinking) {
    statusDot.classList.add('black-turn');
    statusCard.classList.add('ai-thinking');
    statusText.textContent = 'AI 思考中…';
  } else if (gameState.currentPlayer === 1) {
    statusDot.classList.add('black-turn');
    statusText.textContent = '你的回合';
  } else {
    statusDot.classList.add('white-turn');
    statusText.textContent = 'AI 回合';
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
    winIcon.textContent = '[ VICTORY ]';
    winText.textContent = '你赢了！';
    winSub.textContent = `战胜 AI，共 ${gameState.moveCount} 步`;
  } else if (gameState.winner === 2) {
    winIcon.textContent = '[ GAME OVER ]';
    winText.textContent = 'AI 获胜';
    winSub.textContent = `再接再厉，共 ${gameState.moveCount} 步`;
  } else {
    winIcon.textContent = '[ DRAW ]';
    winText.textContent = '平局';
    winSub.textContent = '棋盘已满，不分胜负';
  }

  overlay.classList.remove('hidden');
}

// --- 启动 ---
init();
draw();
