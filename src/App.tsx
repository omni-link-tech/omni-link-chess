import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { Canvas } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Text, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import './index.css'

// ---------- Types ----------
type Color = "w" | "b";
type PieceType = "p" | "r" | "n" | "b" | "q" | "k";

type Move = { x: number; y: number };

type Piece = {
  id: string;
  type: PieceType;
  color: Color;
  x: number;
  y: number;
};

type Board = (Piece | null)[][];

type Mode = "free" | "ai";

type GameStatus = {
  inCheck: boolean;
  isCheckmate: boolean;
  isStalemate: boolean;
  winner: Color | null;
  checkedKing: Piece | null;
};

const WHITE: Color = "w";
const BLACK: Color = "b";

const BOARD_SIZE = 8;
const TILE = 1; // world units per square
const SERVER_ENDPOINT = "http://localhost:8765";
const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";

const PIECE_TYPE_TO_NAME: Record<PieceType, string> = {
  p: "pawn",
  r: "rook",
  n: "knight",
  b: "bishop",
  q: "queen",
  k: "king",
};

function createMoveCommand(piece: Piece, destX: number, destY: number): string {
  const pieceName = PIECE_TYPE_TO_NAME[piece.type];
  const colorName = piece.color === WHITE ? "white" : "black";
  const from = toAlgebraic(piece.x, piece.y);
  const to = toAlgebraic(destX, destY);
  return `move_${colorName}_${pieceName}_from_${from}_to_${to}`;
}

const PIECE_NAME_TO_TYPE: Record<string, PieceType> = {
  pawn: "p",
  rook: "r",
  knight: "n",
  bishop: "b",
  queen: "q",
  king: "k",
};

const PIECE_VALUES: Record<PieceType, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 100,
};

const AI_MOVE_DELAY_MS = 400;
const GENERAL_MOVE_RE =
  /^move_(white|black)_(pawn|rook|knight|bishop|queen|king)_from_([a-h][1-8])_to_([a-h][1-8])$/;

// ---------- Helpers ----------
function createEmptyBoard(): Board {
  return Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => null));
}

function id() {
  return Math.random().toString(36).slice(2, 10);
}

function parseFEN(fen: string) {
  const pieces: Piece[] = [];
  const board = createEmptyBoard();
  const rows = fen.split(" ")[0].split("/");
  rows.forEach((row, i) => {
    let x = 0;
    const y = 7 - i; // rank 8..1 → y 7..0
    for (const ch of row) {
      if (/\d/.test(ch)) {
        x += parseInt(ch, 10);
        continue;
      }
      const color: Color = ch === ch.toLowerCase() ? BLACK : WHITE;
      const type = ch.toLowerCase() as PieceType;
      const p: Piece = { id: id(), type, color, x, y };
      pieces.push(p);
      board[y][x] = p;
      x++;
    }
  });
  return { board, pieces };
}

function toAlgebraic(x: number, y: number) {
  return `${String.fromCharCode(97 + x)}${y + 1}`;
}

function fromAlgebraic(square: string) {
  const match = square.match(/^([a-h])([1-8])$/);
  if (!match) return null;
  const file = match[1].charCodeAt(0) - 97;
  const rank = Number.parseInt(match[2], 10) - 1;
  return { x: file, y: rank };
}

function inBounds(x: number, y: number) {
  return x >= 0 && x < 8 && y >= 0 && y < 8;
}

function ray(
  board: Board,
  x: number,
  y: number,
  dx: number,
  dy: number,
  color: Color,
  out: Move[]
) {
  let cx = x + dx,
    cy = y + dy;
  while (inBounds(cx, cy)) {
    const occ = board[cy][cx];
    if (!occ) out.push({ x: cx, y: cy });
    else {
      if (occ.color !== color) out.push({ x: cx, y: cy });
      break;
    }
    cx += dx;
    cy += dy;
  }
}

function pseudoLegalMovesFor(board: Board, p: Piece): Move[] {
  const { type, color, x, y } = p;
  const out: Move[] = [];
  if (type === "p") {
    const dir = color === WHITE ? 1 : -1;
    const startRank = color === WHITE ? 1 : 6;
    if (inBounds(x, y + dir) && !board[y + dir][x]) out.push({ x, y: y + dir });
    if (y === startRank && !board[y + dir][x] && !board[y + 2 * dir][x])
      out.push({ x, y: y + 2 * dir });
    for (const dx of [-1, 1]) {
      const tx = x + dx,
        ty = y + dir;
      if (!inBounds(tx, ty)) continue;
      const occ = board[ty][tx];
      if (occ && occ.color !== color) out.push({ x: tx, y: ty });
    }
  } else if (type === "r") {
    ray(board, x, y, 1, 0, color, out);
    ray(board, x, y, -1, 0, color, out);
    ray(board, x, y, 0, 1, color, out);
    ray(board, x, y, 0, -1, color, out);
  } else if (type === "b") {
    ray(board, x, y, 1, 1, color, out);
    ray(board, x, y, -1, 1, color, out);
    ray(board, x, y, 1, -1, color, out);
    ray(board, x, y, -1, -1, color, out);
  } else if (type === "q") {
    ray(board, x, y, 1, 0, color, out);
    ray(board, x, y, -1, 0, color, out);
    ray(board, x, y, 0, 1, color, out);
    ray(board, x, y, 0, -1, color, out);
    ray(board, x, y, 1, 1, color, out);
    ray(board, x, y, -1, 1, color, out);
    ray(board, x, y, 1, -1, color, out);
    ray(board, x, y, -1, -1, color, out);
  } else if (type === "n") {
    const deltas = [
      [1, 2],
      [2, 1],
      [-1, 2],
      [-2, 1],
      [1, -2],
      [2, -1],
      [-1, -2],
      [-2, -1],
    ];
    for (const [dx, dy] of deltas) {
      const tx = x + dx,
        ty = y + dy;
      if (!inBounds(tx, ty)) continue;
      const occ = board[ty][tx];
      if (!occ || occ.color !== color) out.push({ x: tx, y: ty });
    }
  } else if (type === "k") {
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const tx = x + dx,
          ty = y + dy;
        if (!inBounds(tx, ty)) continue;
        const occ = board[ty][tx];
        if (!occ || occ.color !== color) out.push({ x: tx, y: ty });
      }
  }
  return out;
}

function findKing(board: Board, color: Color): Piece | null {
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      const occ = board[y][x];
      if (occ && occ.color === color && occ.type === "k") {
        return occ;
      }
    }
  }
  return null;
}

function attacksSquare(board: Board, piece: Piece, targetX: number, targetY: number): boolean {
  const dx = targetX - piece.x;
  const dy = targetY - piece.y;
  switch (piece.type) {
    case "p": {
      const dir = piece.color === WHITE ? 1 : -1;
      return dy === dir && Math.abs(dx) === 1;
    }
    case "n": {
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      return (adx === 1 && ady === 2) || (adx === 2 && ady === 1);
    }
    case "k": {
      return Math.max(Math.abs(dx), Math.abs(dy)) === 1;
    }
    case "b": {
      if (Math.abs(dx) !== Math.abs(dy) || dx === 0) return false;
      const stepX = dx > 0 ? 1 : -1;
      const stepY = dy > 0 ? 1 : -1;
      return isPathClear(board, piece.x, piece.y, targetX, targetY, stepX, stepY, piece.color);
    }
    case "r": {
      if (dx !== 0 && dy !== 0) return false;
      const stepX = dx === 0 ? 0 : dx > 0 ? 1 : -1;
      const stepY = dy === 0 ? 0 : dy > 0 ? 1 : -1;
      if (stepX === 0 && stepY === 0) return false;
      return isPathClear(board, piece.x, piece.y, targetX, targetY, stepX, stepY, piece.color);
    }
    case "q": {
      if (dx === 0 && dy === 0) return false;
      if (dx === 0 || dy === 0) {
        const stepX = dx === 0 ? 0 : dx > 0 ? 1 : -1;
        const stepY = dy === 0 ? 0 : dy > 0 ? 1 : -1;
        return isPathClear(board, piece.x, piece.y, targetX, targetY, stepX, stepY, piece.color);
      }
      if (Math.abs(dx) !== Math.abs(dy)) return false;
      const stepX = dx > 0 ? 1 : -1;
      const stepY = dy > 0 ? 1 : -1;
      return isPathClear(board, piece.x, piece.y, targetX, targetY, stepX, stepY, piece.color);
    }
    default:
      return false;
  }
}

function isPathClear(
  board: Board,
  fromX: number,
  fromY: number,
  targetX: number,
  targetY: number,
  stepX: number,
  stepY: number,
  color: Color
): boolean {
  let cx = fromX + stepX;
  let cy = fromY + stepY;
  while (inBounds(cx, cy)) {
    if (cx === targetX && cy === targetY) {
      const occ = board[cy][cx];
      if (!occ) return true;
      return occ.color !== color;
    }
    if (board[cy][cx]) {
      return false;
    }
    cx += stepX;
    cy += stepY;
  }
  return false;
}

function isSquareAttacked(board: Board, x: number, y: number, attacker: Color): boolean {
  if (!inBounds(x, y)) {
    return false;
  }
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const piece = board[row][col];
      if (!piece || piece.color !== attacker) continue;
      if (attacksSquare(board, piece, x, y)) {
        const target = board[y][x];
        if (!target || target.color !== piece.color) {
          return true;
        }
      }
    }
  }
  return false;
}

function applyMoveToBoard(board: Board, piece: Piece, destX: number, destY: number): Board | null {
  if (!inBounds(destX, destY)) {
    return null;
  }
  const boardCopy = board.map((row) => row.slice());
  const current = boardCopy[piece.y]?.[piece.x];
  if (!current || current.id !== piece.id) {
    return null;
  }
  boardCopy[piece.y][piece.x] = null;
  const nextType = piece.type === "p" && (destY === 7 || destY === 0) ? "q" : piece.type;
  const moved: Piece = { ...piece, x: destX, y: destY, type: nextType };
  boardCopy[destY][destX] = moved;
  return boardCopy;
}

function legalMovesFor(board: Board, p: Piece): Move[] {
  const candidateMoves = pseudoLegalMovesFor(board, p);
  const opponent = p.color === WHITE ? BLACK : WHITE;
  const legal: Move[] = [];
  for (const move of candidateMoves) {
    const nextBoard = applyMoveToBoard(board, p, move.x, move.y);
    if (!nextBoard) continue;
    const king = findKing(nextBoard, p.color);
    if (!king) continue;
    const inCheck = isSquareAttacked(nextBoard, king.x, king.y, opponent);
    if (!inCheck) {
      legal.push(move);
    }
  }
  return legal;
}

// ---------- Piece Meshes ----------
function PieceMesh({ piece }: { piece: Piece }) {
  const material = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: piece.color === WHITE ? 0xf3f5ff : 0x111826,
        roughness: piece.color === WHITE ? 0.35 : 0.45,
        metalness: piece.color === WHITE ? 0.1 : 0.05,
      }),
    [piece.color]
  );

  const modelPaths: Record<PieceType, string> = {
    p: "/models/pawn/pawn.gltf",
    r: "/models/rook/rook.gltf",
    n: "/models/knight/knight.gltf",
    b: "/models/bishop/bishop.gltf",
    q: "/models/queen/queen.gltf",
    k: "/models/king/king.gltf",
  };

  const { scene } = useGLTF(modelPaths[piece.type]);
  const cloned = useMemo(() => scene.clone(), [scene]);

  useEffect(() => {
    cloned.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.material = material;
        obj.castShadow = true;
      }
    });
  }, [cloned, material]);

  const pos: [number, number, number] = [piece.x - 3.5, 0, piece.y - 3.5];
  const rotY = piece.type === "n" && piece.color === BLACK ? Math.PI : 0;
  return <primitive object={cloned} position={pos} rotation-y={rotY} />;
}

useGLTF.preload("/models/pawn/pawn.gltf");
useGLTF.preload("/models/rook/rook.gltf");
useGLTF.preload("/models/knight/knight.gltf");
useGLTF.preload("/models/bishop/bishop.gltf");
useGLTF.preload("/models/queen/queen.gltf");
useGLTF.preload("/models/king/king.gltf");

// ---------- Tiles & Highlights ----------
function Tile({
  x,
  y,
  isLight,
  onClick,
}: {
  x: number;
  y: number;
  isLight: boolean;
  onClick: (x: number, y: number) => void;
}) {
  const color = isLight ? 0xb8c2d8 : 0x2c3648;
  const mat = useMemo(
    () => new THREE.MeshPhysicalMaterial({ color, roughness: 0.9 }),
    [color]
  );
  const pos: [number, number, number] = [x - 3.5, 0, y - 3.5];
  const handle = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      onClick(x, y);
    },
    [x, y, onClick]
  );
  return (
    <group position={pos}>
      <mesh receiveShadow material={mat} onPointerDown={handle}>
        <boxGeometry args={[TILE, 0.12, TILE]} />
      </mesh>
      <Text
        position={[0, 0.08, 0]}
        rotation-x={-Math.PI / 2}
        fontSize={0.22}
        color={isLight ? "#1a2332" : "#d6def3"}
        anchorX="center"
        anchorY="middle"
      >
        {toAlgebraic(x, y)}
      </Text>
    </group>
  );
}

function Highlight({ x, y }: { x: number; y: number }) {
  const pos: [number, number, number] = [x - 3.5, 0.07, y - 3.5];
  return (
    <mesh position={pos} rotation-x={-Math.PI / 2}>
      <torusGeometry args={[0.32, 0.06, 12, 24]} />
      <meshBasicMaterial color={0x6aa0ff} />
    </mesh>
  );
}

function CheckHighlight({ x, y, isMate }: { x: number; y: number; isMate: boolean }) {
  const pos: [number, number, number] = [x - 3.5, 0.075, y - 3.5];
  const color = isMate ? 0xff3b5c : 0xff7a5a;
  return (
    <mesh position={pos} rotation-x={-Math.PI / 2}>
      <ringGeometry args={[0.18, 0.42, 28]} />
      <meshBasicMaterial color={color} />
    </mesh>
  );
}

// ---------- Main Scene ----------
function ChessScene() {
  const [board, setBoard] = useState<Board>(() => createEmptyBoard());
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [turn, setTurn] = useState<Color>(WHITE);
  const [mode, setMode] = useState<Mode>("free");
  const [playerColor, setPlayerColor] = useState<Color>(WHITE);
  const [selected, setSelected] = useState<Piece | null>(null);
  const [legal, setLegal] = useState<Move[]>([]);
  const [view, setView] = useState<"3d" | "top">("3d");

  const aiColor: Color = playerColor === WHITE ? BLACK : WHITE;

  const gameStatus = useMemo<GameStatus>(() => {
    const king = findKing(board, turn);
    const defaultStatus: GameStatus = {
      inCheck: false,
      isCheckmate: false,
      isStalemate: false,
      winner: null,
      checkedKing: null,
    };
    if (!king) {
      return defaultStatus;
    }
    const opponent = turn === WHITE ? BLACK : WHITE;
    const inCheck = isSquareAttacked(board, king.x, king.y, opponent);
    let hasMoves = false;
    for (const piece of pieces) {
      if (piece.color !== turn) continue;
      const moves = legalMovesFor(board, piece);
      if (moves.length > 0) {
        hasMoves = true;
        break;
      }
    }
    const isCheckmate = inCheck && !hasMoves;
    const isStalemate = !inCheck && !hasMoves;
    return {
      inCheck,
      isCheckmate,
      isStalemate,
      winner: isCheckmate ? opponent : null,
      checkedKing: inCheck ? king : null,
    };
  }, [board, pieces, turn]);

  const lastSentCommand = useRef<string | null>(null);
  const aiThinking = useRef(false);
  const modeRef = useRef<Mode>(mode);
  const boardRef = useRef(board);
  const turnRef = useRef(turn);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  useEffect(() => {
    turnRef.current = turn;
  }, [turn]);

  const applyStartingPosition = useCallback(() => {
    const { board: b, pieces: p } = parseFEN(STARTING_FEN);
    setBoard(b);
    setPieces(p);
    setTurn(WHITE);
    setSelected(null);
    setLegal([]);
  }, []);

  const refreshContext = useCallback(async (): Promise<boolean> => {
    if (modeRef.current !== "free") {
      return false;
    }
    try {
      const response = await fetch(`${SERVER_ENDPOINT}/context`);
      if (!response.ok) {
        console.error(`Failed to fetch context: ${response.status}`);
        return false;
      }
      const payload = await response.json().catch(() => null);
      const state = payload && typeof payload === "object" ? payload.state : null;
      if (!state || typeof state !== "object") {
        console.error("Context payload missing state information");
        return false;
      }

      let nextBoard: Board | null = null;
      let nextPieces: Piece[] | null = null;

      if (Array.isArray(state.pieces)) {
        const boardData = createEmptyBoard();
        const pieceList: Piece[] = [];
        for (const entry of state.pieces) {
          if (!entry || typeof entry !== "object") continue;
          const square = typeof entry.square === "string" ? entry.square : "";
          const coords = fromAlgebraic(square);
          if (!coords) continue;
          const rawPiece = typeof entry.piece === "string" ? entry.piece.toLowerCase() : "";
          const type = PIECE_NAME_TO_TYPE[rawPiece];
          if (!type) continue;
          const rawColor = typeof entry.color === "string" ? entry.color.toLowerCase() : "";
          const color: Color = rawColor === "black" ? BLACK : WHITE;
          const pieceId = typeof entry.id === "string" && entry.id ? entry.id : id();
          const piece: Piece = { id: pieceId, type, color, x: coords.x, y: coords.y };
          pieceList.push(piece);
          boardData[coords.y][coords.x] = piece;
        }
        nextBoard = boardData;
        nextPieces = pieceList;
      }

      if (!nextBoard || !nextPieces) {
        const fen = typeof state.fen === "string" && state.fen ? state.fen : STARTING_FEN;
        const parsed = parseFEN(fen);
        nextBoard = parsed.board;
        nextPieces = parsed.pieces;
      }

      if (modeRef.current !== "free") {
        return false;
      }

      setBoard(nextBoard);
      setPieces(nextPieces);
      const turnColor = state.turn === "black" ? BLACK : WHITE;
      setTurn(turnColor);
      setSelected(null);
      setLegal([]);
      return true;
    } catch (error) {
      console.error("Failed to refresh context", error);
      return false;
    }
  }, [modeRef]);

  const sendCommand = useCallback(
    async (
      cmd: string,
      options?: {
        sync?: boolean;
      }
    ): Promise<boolean> => {
      const shouldSync = options?.sync ?? modeRef.current === "free";
      try {
        const response = await fetch(SERVER_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cmd }),
        });
        if (!response.ok) {
          console.error(`Command failed with status ${response.status}`);
          return false;
        }
        const data = await response.json().catch(() => null);
        const handled = Boolean(data && typeof data === "object" && data.handled);
        if (handled && shouldSync) {
          const refreshed = await refreshContext();
          if (refreshed) {
            lastSentCommand.current = cmd;
          } else {
            lastSentCommand.current = null;
          }
        } else {
          lastSentCommand.current = null;
          if (!handled) {
            console.warn(`Server did not handle command: ${cmd}`);
          }
        }
        return handled;
      } catch (error) {
        console.error("Failed to send command", error);
        return false;
      }
    },
    [refreshContext]
  );

  const performLocalMove = useCallback(
    (pieceId: string, destX: number, destY: number): boolean => {
      if (!inBounds(destX, destY)) {
        return false;
      }
      const moving = pieces.find((p) => p.id === pieceId);
      if (!moving) {
        return false;
      }

      const moves = legalMovesFor(board, moving);
      if (!moves.some((m) => m.x === destX && m.y === destY)) {
        return false;
      }

      const boardCopy = board.map((row) => row.slice());
      const target = boardCopy[destY][destX];
      if (target && target.color === moving.color) {
        return false;
      }

      boardCopy[moving.y][moving.x] = null;

      let nextType = moving.type;
      if (moving.type === "p" && (destY === 7 || destY === 0)) {
        nextType = "q";
      }

      const updatedPiece: Piece = { ...moving, x: destX, y: destY, type: nextType };
      boardCopy[destY][destX] = updatedPiece;

      const nextPieces: Piece[] = [];
      for (const piece of pieces) {
        if (piece.id === moving.id) {
          continue;
        }
        if (target && piece.id === target.id) {
          continue;
        }
        nextPieces.push(piece);
      }
      nextPieces.push(updatedPiece);

      setBoard(boardCopy);
      setPieces(nextPieces);
      setTurn(moving.color === WHITE ? BLACK : WHITE);
      setSelected(null);
      setLegal([]);
      return true;
    },
    [board, pieces]
  );

  const handleRemoteCommandInAiMode = useCallback(
    (command: string): boolean => {
      if (command === "reset" || command === "reset_board") {
        applyStartingPosition();
        return true;
      }

      const match = GENERAL_MOVE_RE.exec(command);
      if (!match) {
        return false;
      }

      const [, rawColor, , fromSquare, toSquare] = match;
      const color: Color = rawColor === "black" ? BLACK : WHITE;
      if (color !== playerColor) {
        return false;
      }
      if (turnRef.current !== color) {
        return false;
      }

      const from = fromAlgebraic(fromSquare);
      const to = fromAlgebraic(toSquare);
      if (!from || !to) {
        return false;
      }

      const boardSnapshot = boardRef.current;
      const piece = boardSnapshot[from.y]?.[from.x];
      if (!piece || piece.color !== color) {
        return false;
      }

      const applied = performLocalMove(piece.id, to.x, to.y);
      if (!applied) {
        console.warn(`Failed to apply remote command in AI mode: ${command}`);
      }
      return applied;
    },
    [applyStartingPosition, performLocalMove, playerColor]
  );

  const handleRemoteCommandRef = useRef(handleRemoteCommandInAiMode);
  useEffect(() => {
    handleRemoteCommandRef.current = handleRemoteCommandInAiMode;
  }, [handleRemoteCommandInAiMode]);

  const pickAiMove = useCallback(() => {
    if (mode !== "ai") {
      return null;
    }
    type Candidate = { pieceId: string; move: Move; score: number };
    const candidates: Candidate[] = [];
    for (const piece of pieces) {
      if (piece.color !== aiColor) {
        continue;
      }
      const moves = legalMovesFor(board, piece);
      for (const move of moves) {
        const target = board[move.y][move.x];
        let score = Math.random() * 0.1;
        if (target) {
          score += (PIECE_VALUES[target.type] ?? 0) + 5;
        }
        if (piece.type === "p" && (move.y === 7 || move.y === 0)) {
          score += 8;
        }
        candidates.push({ pieceId: piece.id, move, score });
      }
    }
    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((a, b) => b.score - a.score);
    const bestScore = candidates[0].score;
    const topMoves = candidates.filter((c) => bestScore - c.score < 0.5);
    const choice =
      topMoves[Math.floor(Math.random() * topMoves.length)] ?? candidates[0];
    return choice;
  }, [aiColor, board, mode, pieces]);

  useEffect(() => {
    applyStartingPosition();
  }, [applyStartingPosition]);

  useEffect(() => {
    if (mode === "ai") {
      lastSentCommand.current = null;
      aiThinking.current = false;
      applyStartingPosition();
    }
  }, [applyStartingPosition, mode, playerColor]);

  useEffect(() => {
    if (mode === "free") {
      void refreshContext();
    }
  }, [mode, refreshContext]);

  useEffect(() => {
    if (mode !== "ai") {
      return;
    }
    const ws = new WebSocket("ws://localhost:8765");
    ws.onmessage = (event) => {
      const cmd = String(event.data ?? "").trim();
      if (!cmd) {
        return;
      }
      if (lastSentCommand.current && lastSentCommand.current === cmd) {
        lastSentCommand.current = null;
        return;
      }
      const handler = handleRemoteCommandRef.current;
      const handled = handler(cmd);
      if (!handled && cmd.startsWith("move_")) {
        console.warn(`Unhandled remote AI-mode command: ${cmd}`);
      }
    };
    ws.onerror = (error) => {
      console.error("WebSocket error in AI mode", error);
    };
    return () => ws.close();
  }, [mode]);

  const handleTileClick = useCallback(
    async (x: number, y: number) => {
      if (gameStatus.isCheckmate || gameStatus.isStalemate) {
        return;
      }
      const target = board[y][x];

      if (mode === "ai") {
        if (turn !== playerColor) {
          return;
        }
        if (!selected) {
          if (target && target.color === playerColor) {
            const moves = legalMovesFor(board, target);
            setSelected(target);
            setLegal(moves);
          }
          return;
        }
        if (target && target.color === playerColor) {
          const moves = legalMovesFor(board, target);
          setSelected(target);
          setLegal(moves);
          return;
        }
        const moves = legal;
        if (moves.some((m) => m.x === x && m.y === y)) {
          const moveCommand = createMoveCommand(selected, x, y);
          const success = performLocalMove(selected.id, x, y);
          if (!success) {
            console.warn("Failed to apply local move");
            return;
          }
          lastSentCommand.current = moveCommand;
          void sendCommand(moveCommand, { sync: false });
        } else {
          setSelected(null);
          setLegal([]);
        }
        return;
      }

      if (!selected) {
        if (target && target.color === turn) {
          const moves = legalMovesFor(board, target);
          setSelected(target);
          setLegal(moves);
        }
        return;
      }
      if (target && target.color === selected.color) {
        const moves = legalMovesFor(board, target);
        setSelected(target);
        setLegal(moves);
        return;
      }
      const moves = legal;
      if (moves.some((m) => m.x === x && m.y === y)) {
        const command = createMoveCommand(selected, x, y);
        const handled = await sendCommand(command);
        if (handled) {
          setSelected(null);
          setLegal([]);
        }
      } else {
        setSelected(null);
        setLegal([]);
      }
    },
    [board, gameStatus, legal, mode, performLocalMove, playerColor, selected, sendCommand, turn]
  );

  const handleReset = useCallback(async () => {
    if (mode === "ai") {
      applyStartingPosition();
      return;
    }
    const handled = await sendCommand("reset");
    if (!handled) {
      console.warn("Reset command was not handled by the server");
    }
  }, [applyStartingPosition, mode, sendCommand]);

  useEffect(() => {
    if (mode !== "ai") {
      aiThinking.current = false;
      return;
    }
    if (gameStatus.isCheckmate || gameStatus.isStalemate) {
      aiThinking.current = false;
      return;
    }
    if (turn !== aiColor) {
      aiThinking.current = false;
      return;
    }
    if (aiThinking.current) {
      return;
    }
    aiThinking.current = true;
      const timer = window.setTimeout(() => {
        const nextMove = pickAiMove();
        if (nextMove) {
          const applied = performLocalMove(nextMove.pieceId, nextMove.move.x, nextMove.move.y);
          if (!applied) {
            console.warn("AI move failed to apply");
          }
        } else {
          console.info("AI has no legal moves");
        }
        aiThinking.current = false;
      }, AI_MOVE_DELAY_MS);
      return () => {
        aiThinking.current = false;
        window.clearTimeout(timer);
      };
  }, [aiColor, gameStatus, mode, performLocalMove, pickAiMove, turn]);

  useEffect(() => {
    if (mode !== "free") {
      return;
    }
    const ws = new WebSocket("ws://localhost:8765");
    ws.onopen = () => {
      void refreshContext();
    };
    ws.onmessage = (event) => {
      const cmd = String(event.data).trim();
      if (cmd && lastSentCommand.current === cmd) {
        lastSentCommand.current = null;
        return;
      }
      void refreshContext();
    };
    ws.onerror = (error) => {
      console.error("WebSocket error", error);
    };
    return () => ws.close();
  }, [mode, refreshContext]);

  return (
    <div className="min-h-screen text-slate-100" style={{ background: "#0b0f17" }}>
      <header
        className="flex items-center gap-3 px-4 py-2"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0))",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          backdropFilter: "blur(6px)",
        }}
      >
        <h1 className="text-sm font-semibold tracking-wide opacity-85 m-0">
          Omni Link Chess
        </h1>
        <div className="text-xs opacity-90">
          Turn: <b>{turn === WHITE ? "White" : "Black"}</b>
          {mode === "ai" ? (
            <span> {turn === playerColor ? "(You)" : "(AI)"}</span>
          ) : null}
        </div>
        {gameStatus.isCheckmate ? (
          <div className="px-3 py-1 rounded-xl text-xs font-semibold border border-red-400/40 bg-red-500/10 text-red-200">
            Checkmate! {gameStatus.winner === WHITE ? "White" : "Black"} wins.
          </div>
        ) : gameStatus.isStalemate ? (
          <div className="px-3 py-1 rounded-xl text-xs font-semibold border border-amber-400/30 bg-amber-500/10 text-amber-100">
            Stalemate.
          </div>
        ) : gameStatus.inCheck ? (
          <div className="px-3 py-1 rounded-xl text-xs font-semibold border border-red-400/40 bg-red-500/10 text-red-200">
            Check on {turn === WHITE ? "White" : "Black"}!
          </div>
        ) : null}
        <div className="inline-flex items-center gap-1 text-xs">
          <span>Mode:</span>
          <button
            onClick={() => setMode("free")}
            className={`px-3 py-1 rounded-xl text-xs font-semibold border ${
              mode === "free"
                ? "bg-white/20 border-white/30"
                : "bg-white/10 border-white/20"
            }`}
          >
            Free
          </button>
          <button
            onClick={() => setMode("ai")}
            className={`px-3 py-1 rounded-xl text-xs font-semibold border ${
              mode === "ai"
                ? "bg-white/20 border-white/30"
                : "bg-white/10 border-white/20"
            }`}
          >
            Vs AI
          </button>
        </div>
        {mode === "ai" && (
          <div className="inline-flex items-center gap-1 text-xs">
            <span>Play as:</span>
            <button
              onClick={() => setPlayerColor(WHITE)}
              className={`px-3 py-1 rounded-xl text-xs font-semibold border ${
                playerColor === WHITE
                  ? "bg-white/20 border-white/30"
                  : "bg-white/10 border-white/20"
              }`}
            >
              White
            </button>
            <button
              onClick={() => setPlayerColor(BLACK)}
              className={`px-3 py-1 rounded-xl text-xs font-semibold border ${
                playerColor === BLACK
                  ? "bg-white/20 border-white/30"
                  : "bg-white/10 border-white/20"
              }`}
            >
              Black
            </button>
          </div>
        )}
        <div className="flex-1" />
        <div className="inline-flex items-center gap-1">
          <button
            onClick={() => setView("3d")}
            className={`px-3 py-1 rounded-xl text-xs font-semibold border ${
              view === "3d"
                ? "bg-white/20 border-white/30"
                : "bg-white/10 border-white/20"
            }`}
          >
            3D
          </button>
          <button
            onClick={() => setView("top")}
            className={`px-3 py-1 rounded-xl text-xs font-semibold border ${
              view === "top"
                ? "bg-white/20 border-white/30"
                : "bg-white/10 border-white/20"
            }`}
          >
            Top
          </button>
        </div>
        <button
          onClick={handleReset}
          className="px-3 py-1 rounded-xl text-xs font-semibold border bg-white/10 border-white/20"
        >
          Reset
        </button>
      </header>

      <div className="relative" style={{ height: "calc(100vh - 48px)" }}>
        {/* HUD */}
        <div className="absolute z-10 left-3 top-16 grid gap-2">
          <div className="px-3 py-2 rounded-xl border bg-white/5 border-white/10 text-xs flex items-center gap-2">
            <span
              style={{ background: "#f3f5ff", width: 10, height: 10, borderRadius: 999 }}
            />
            White pieces
          </div>
          <div className="px-3 py-2 rounded-xl border bg-white/5 border-white/10 text-xs flex items-center gap-2">
            <span
              style={{ background: "#111826", width: 10, height: 10, borderRadius: 999 }}
            />
            Black pieces
          </div>
          <div className="px-3 py-2 rounded-xl border bg-white/5 border-white/10 text-xs max-w-xs">
            Click a piece → click a square to move. Check and checkmate are enforced. (Castling/en passant not yet implemented.)
          </div>
        </div>

        {/* Coordinates */}
        <div
          className="absolute z-10 bottom-2 left-1/2 -translate-x-1/2 flex gap-2 opacity-70 text-xs"
        >
          {"12345678".split("").map((r) => (
            <div key={r} style={{ width: 28, textAlign: "center" }}>
              {r}
            </div>
          ))}
        </div>
        <div
          className="absolute z-10 left-2 top-1/2 -translate-y-1/2 grid gap-1 opacity-70 text-xs"
        >
          {"abcdefgh"
            .split("")
            .reverse()
            .map((f) => (
              <div key={f} style={{ height: 28, width: 16, textAlign: "center" }}>
                {f}
              </div>
            ))}
        </div>

        {/* 3D Canvas */}
        <Canvas shadows dpr={[1, 2]}>
          <color attach="background" args={["#0b0f17"]} />

          {/* Camera & controls */}
          <PerspectiveCamera makeDefault fov={55} position={view === "top" ? [0, 12, 0.01] : [6, 8.5, 9.5]} />
          <OrbitControls
            target={[0, 0, 0]}
            enableRotate={view === "3d"}
            maxPolarAngle={view === "3d" ? Math.PI * 0.49 : Math.PI / 2}
            minPolarAngle={view === "3d" ? 0.2 : 0}
            minDistance={6}
            maxDistance={24}
            enablePan={true}
          />

          {/* Lights */}
          <hemisphereLight args={[0xffffff, 0x19202a, 1.3]} />
          <directionalLight
            position={[8, 12, 6]}
            castShadow
            intensity={1.5}
            shadow-mapSize={[2048, 2048]}
          />

          {/* Ground (shadow receiver) */}
          <mesh rotation-x={-Math.PI / 2} position-y={-0.01} receiveShadow>
            <planeGeometry args={[40, 40]} />
            <shadowMaterial opacity={0.2} />
          </mesh>

          {/* Frame */}
          <mesh position-y={-0.1} castShadow receiveShadow>
            <boxGeometry args={[BOARD_SIZE + 1, 0.2, BOARD_SIZE + 1]} />
            <meshPhysicalMaterial color={0x101827} metalness={0.2} roughness={0.4} />
          </mesh>

          {/* Tiles */}
          {Array.from({ length: 8 }).map((_, y) =>
            Array.from({ length: 8 }).map((__, x) => (
              <Tile
                key={`t-${x}-${y}`}
                x={x}
                y={y}
                isLight={(x + y) % 2 === 0}
                onClick={handleTileClick}
              />
            ))
          )}

          {/* Legal highlights */}
          {selected &&
            legal.map((m) => <Highlight key={`h-${m.x}-${m.y}`} x={m.x} y={m.y} />)}

          {/* Check indicator */}
          {gameStatus.inCheck && gameStatus.checkedKing ? (
            <CheckHighlight
              x={gameStatus.checkedKing.x}
              y={gameStatus.checkedKing.y}
              isMate={gameStatus.isCheckmate}
            />
          ) : null}

          {/* Pieces */}
          {pieces.map((p) => (
            <PieceMesh key={p.id} piece={p} />
          ))}
        </Canvas>
      </div>

      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; }
        button { cursor: pointer; }
      `}</style>
    </div>
  );
}

export default function App() {
  return <ChessScene />;
}
