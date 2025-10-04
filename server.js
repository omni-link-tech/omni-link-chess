import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
const PORT = 8765;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json());
app.use(express.text({ type: "*/*" }));

// create a shared HTTP server so Express and WebSocket can
// listen on the same port
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const BACK_RANK = [
  "rook",
  "knight",
  "bishop",
  "queen",
  "king",
  "bishop",
  "knight",
  "rook",
];
const MAX_HISTORY = 50;

let board;
let piecesById;
let whitePawnNumbers;
let whitePawnLookup;
let moveHistory;
let lastCommand = null;
let lastMove = null;
let lastInvalidCommand = null;
let invalidCommandCount = 0;
let turn = "white";
let pieceSeq = 1;

function createPiece(color, type, square, explicitId) {
  const id = explicitId ?? `${color}_${type}_${pieceSeq++}`;
  const piece = { id, color, type, square };
  board.set(square, piece);
  piecesById.set(id, piece);
  return piece;
}

function resetBoard() {
  board = new Map();
  piecesById = new Map();
  whitePawnNumbers = new Map();
  whitePawnLookup = new Map();
  moveHistory = [];
  lastCommand = null;
  lastMove = null;
  lastInvalidCommand = null;
  invalidCommandCount = 0;
  turn = "white";
  pieceSeq = 1;

  for (let i = 0; i < FILES.length; i += 1) {
    const file = FILES[i];
    const backType = BACK_RANK[i];
    createPiece("white", backType, `${file}1`);
    createPiece("black", backType, `${file}8`);
  }

  for (let i = 0; i < FILES.length; i += 1) {
    const file = FILES[i];
    const pawnNumber = i + 1;
    const whitePawn = createPiece(
      "white",
      "pawn",
      `${file}2`,
      `white_pawn_${pawnNumber}`,
    );
    whitePawnNumbers.set(pawnNumber, whitePawn.id);
    whitePawnLookup.set(whitePawn.id, pawnNumber);
    createPiece("black", "pawn", `${file}7`);
  }
}

resetBoard();

function broadcast(msg) {
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(msg);
    }
  }
}

function squareOrder(square) {
  const fileIndex = FILES.indexOf(square[0]);
  const rankIndex = parseInt(square.slice(1), 10) - 1;
  return rankIndex * 8 + fileIndex;
}

function boardToFen() {
  const map = { pawn: "p", rook: "r", knight: "n", bishop: "b", queen: "q", king: "k" };
  const rows = [];
  for (let rank = 8; rank >= 1; rank -= 1) {
    let row = "";
    let empty = 0;
    for (let fileIdx = 0; fileIdx < FILES.length; fileIdx += 1) {
      const square = `${FILES[fileIdx]}${rank}`;
      const piece = board.get(square);
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty > 0) {
        row += String(empty);
        empty = 0;
      }
      const letter = map[piece.type] ?? "?";
      row += piece.color === "white" ? letter.toUpperCase() : letter;
    }
    if (empty > 0) {
      row += String(empty);
    }
    rows.push(row);
  }
  return rows.join("/");
}

function removeWhitePawnMapping(pieceId) {
  const number = whitePawnLookup.get(pieceId);
  if (number !== undefined) {
    whitePawnLookup.delete(pieceId);
    whitePawnNumbers.delete(number);
  }
}

function formatMoveString(color, piece, from, to, capture, promotion) {
  let str = `${color} ${piece} ${from}->${to}`;
  if (capture) {
    str += ` capturing ${capture.color} ${capture.piece}`;
  }
  if (promotion) {
    str += ` promoting to ${promotion}`;
  }
  return str;
}

function executeMove({ color, expectedType, from, to, raw }) {
  const moving = board.get(from);
  if (!moving || moving.color !== color) {
    return false;
  }

  const pieceBeforeMove = moving.type;
  const capture = board.get(to);
  if (capture) {
    board.delete(to);
    piecesById.delete(capture.id);
    if (capture.color === "white") {
      removeWhitePawnMapping(capture.id);
    }
  }

  board.delete(from);

  moving.square = to;
  let promotion = null;
  if (moving.type === "pawn") {
    const rank = parseInt(to.slice(1), 10);
    if (rank === 8 || rank === 1) {
      moving.type = "queen";
      promotion = "queen";
    }
  }

  board.set(to, moving);
  piecesById.set(moving.id, moving);

  const entry = {
    color,
    piece: pieceBeforeMove,
    from,
    to,
    captured: capture
      ? { color: capture.color, piece: capture.type, id: capture.id }
      : null,
    promotion,
    raw,
    timestamp: new Date().toISOString(),
    move: formatMoveString(color, pieceBeforeMove, from, to, capture, promotion),
  };

  if (expectedType && expectedType !== pieceBeforeMove) {
    entry.requestedPiece = expectedType;
  }
  if (promotion) {
    entry.pieceAfter = moving.type;
  }

  moveHistory.push(entry);
  if (moveHistory.length > MAX_HISTORY) {
    moveHistory.shift();
  }
  lastMove = entry;
  turn = color === "white" ? "black" : "white";
  return true;
}

const GENERAL_MOVE_RE =
  /^move_(white|black)_(pawn|rook|knight|bishop|queen|king)_from_([a-h][1-8])_to_([a-h][1-8])$/;
const WHITE_PAWN_NUMBER_RE = /^move_white_pawn_number_(\d+)_to_([a-h])([1-8])$/;

function tryGeneralMove(command) {
  const match = GENERAL_MOVE_RE.exec(command);
  if (!match) {
    return null;
  }
  const [, color, piece, from, to] = match;
  return executeMove({ color, expectedType: piece, from, to, raw: command });
}

function tryWhitePawnNumberMove(command) {
  const match = WHITE_PAWN_NUMBER_RE.exec(command);
  if (!match) {
    return null;
  }
  const pawnNumber = Number.parseInt(match[1], 10);
  const file = match[2];
  const rank = match[3];
  const pawnId = whitePawnNumbers.get(pawnNumber);
  if (!pawnId) {
    return false;
  }
  const pawn = piecesById.get(pawnId);
  if (!pawn) {
    return false;
  }
  const to = `${file}${rank}`;
  return executeMove({
    color: "white",
    expectedType: pawn.type,
    from: pawn.square,
    to,
    raw: command,
  });
}

function markInvalid(command) {
  lastInvalidCommand = command;
  invalidCommandCount += 1;
  console.warn(`Unrecognised command: ${command}`);
}

function handleCommand(message) {
  if (!message) {
    return false;
  }
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }

  lastCommand = trimmed;

  const generalResult = tryGeneralMove(trimmed);
  if (generalResult !== null) {
    if (!generalResult) {
      markInvalid(trimmed);
    }
    return generalResult;
  }

  const pawnResult = tryWhitePawnNumberMove(trimmed);
  if (pawnResult !== null) {
    if (!pawnResult) {
      markInvalid(trimmed);
    }
    return pawnResult;
  }

  if (trimmed === "reset" || trimmed === "reset_board") {
    resetBoard();
    return true;
  }

  markInvalid(trimmed);
  return false;
}

function listPieces() {
  const pieces = [];
  for (const [square, piece] of board.entries()) {
    pieces.push({ square, color: piece.color, piece: piece.type, id: piece.id });
  }
  pieces.sort((a, b) => squareOrder(a.square) - squareOrder(b.square));
  return pieces;
}

function buildSummary(_fen, counts) {
  const parts = [`Turn: ${turn}`, `White pieces: ${counts.white}`, `Black pieces: ${counts.black}`];
  return `${parts.join(". ")}.`;
}

app.post("/", (req, res) => {
  let message = "";
  if (typeof req.body === "string") {
    message = req.body;
  } else if (req.body && typeof req.body === "object") {
    message = req.body.cmd ?? "";
  }

  const trimmed = String(message ?? "").trim();
  if (!trimmed) {
    res.status(200).json({ ok: false, error: "Empty command" });
    return;
  }

  console.log(trimmed);
  const handled = handleCommand(trimmed);
  broadcast(trimmed);
  res.status(200).json({ ok: true, handled });
});

app.get("/context", (_req, res) => {
  const fen = boardToFen();
  const pieces = listPieces();
  const counts = { white: 0, black: 0 };
  for (const piece of pieces) {
    counts[piece.color] += 1;
  }
  const summary = buildSummary(fen, counts);
  const pawnMap = Object.fromEntries(whitePawnNumbers.entries());
  res.json({
    context: summary,
    state: {
      turn,
      fen,
      lastCommand,
      lastMove,
      lastInvalidCommand,
      invalidCommandCount,
      counts,
      pieces,
      history: moveHistory,
      whitePawns: pawnMap,
    },
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on port ${PORT}`);
});
