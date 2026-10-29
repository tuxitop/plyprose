import {
  useEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
  forwardRef,
  useImperativeHandle,
  Fragment,
} from 'react';
import { Chess } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Config } from '@lichess-org/chessground/config';
import type { Key, Color, Dests } from '@lichess-org/chessground/types';
import type { DrawShape } from '@lichess-org/chessground/draw';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Play,
  Pause,
  RotateCcw,
  Settings as SettingsIcon,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Zap,
  Activity,
} from 'lucide-react';
import { StockfishService, type EngineLine } from '../lib/stockfishService';
import { EvaluationChart } from './EvaluationChart';

export type BoardTheme = 'green' | 'brown' | 'blue' | 'dark' | 'icicle';
export type PieceTheme = 'cburnett' | 'merida' | 'alpha';

export interface CriticalMomentData {
  ply: number;
  move_number: number;
  color: string;
  classification: string;
  move_played_san: string;
  best_move_san: string;
  eval_before_cp?: number | null;
  eval_after_cp?: number | null;
  mate_before?: number | null;
  mate_after?: number | null;
  eval_before?: number;
  eval_after?: number;
  cp_loss?: number;
  narrative?: string;
  pv_san?: string[];
  refutation_san?: string[];
}

export interface GamePly {
  ply: number;
  fen: string;
  san: string;
  moveNumber: number;
  color: 'w' | 'b';
  from?: Key;
  to?: Key;
  criticalMoment?: CriticalMomentData;
}

export interface VariationPly {
  plyIndex: number;
  fen: string;
  san: string;
  moveNumber: number;
  color: 'w' | 'b';
  from?: Key;
  to?: Key;
}

export interface InteractiveBoardHandle {
  startVariation: (branchPly: number, moves: string[]) => void;
  resetVariation: () => void;
}

export interface InteractiveBoardProps {
  pgnText: string;
  payloadJson?: string;
  currentPly: number;
  onSelectPly: (ply: number) => void;
  onClose: () => void;
  userSide?: string;
  sidebarWidth?: number;
  initialVariation?: {
    branchPly: number;
    moves: string[];
  } | null;
}

// Classification badge configuration for moves that stand out
function getClassificationBadge(classification?: string) {
  if (!classification) return null;
  const lower = classification.toLowerCase();
  if (lower.includes('blunder')) {
    return { symbol: '??', label: 'Blunder', bgClass: 'bg-rose-600' };
  }
  if (lower.includes('mistake')) {
    return { symbol: '?', label: 'Mistake', bgClass: 'bg-orange-500' };
  }
  if (lower.includes('inaccuracy')) {
    return { symbol: '?!', label: 'Inaccuracy', bgClass: 'bg-amber-500 text-slate-900' };
  }
  if (lower.includes('miss')) {
    return { symbol: '❌', label: 'Miss', bgClass: 'bg-rose-700' };
  }
  if (lower.includes('brilliant')) {
    return { symbol: '!!', label: 'Brilliant', bgClass: 'bg-cyan-500' };
  }
  if (lower.includes('great') || lower.includes('critical turning point')) {
    return { symbol: '!', label: 'Great Move', bgClass: 'bg-blue-600' };
  }
  return null;
}

export const InteractiveBoard = forwardRef<InteractiveBoardHandle, InteractiveBoardProps>(
  function InteractiveBoard(
    {
      pgnText,
      payloadJson,
      currentPly,
      onSelectPly,
      onClose,
      userSide,
      sidebarWidth = 420,
      initialVariation,
    }: InteractiveBoardProps,
    ref,
  ) {
    const boardElRef = useRef<HTMLDivElement>(null);
    const cgApiRef = useRef<Api | null>(null);
    const moveListRef = useRef<HTMLDivElement>(null);

    // Preferences saved in localStorage
    const [boardTheme, setBoardTheme] = useState<BoardTheme>(() => {
      return (localStorage.getItem('chess_board_theme') as BoardTheme) || 'green';
    });
    const [pieceTheme, setPieceTheme] = useState<PieceTheme>(() => {
      return (localStorage.getItem('chess_piece_theme') as PieceTheme) || 'cburnett';
    });
    const [showSettings, setShowSettings] = useState(false);

    // Resizable chessboard dimensions
    const [boardSize, setBoardSize] = useState<number>(() => {
      const saved = localStorage.getItem('chess_board_size');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= 180 && parsed <= 550) return parsed;
      }
      return 300;
    });

    // Constrain board size to current sidebar container width (accounting for vertical eval bar)
    const maxBoardWidth = Math.max(180, sidebarWidth - 56);
    const effectiveBoardSize = Math.max(180, Math.min(boardSize, maxBoardWidth));

    // Orientation
    const [orientation, setOrientation] = useState<Color>(() => {
      if (userSide?.toLowerCase().includes('black')) return 'black';
      return 'white';
    });

    // Evaluation Chart Visibility
    const [showEvalChart, setShowEvalChart] = useState<boolean>(() => {
      return localStorage.getItem('chess_show_eval_chart') === 'true';
    });

    // Autoplay
    const [isAutoplaying, setIsAutoplaying] = useState(false);
    const autoplayTimerRef = useRef<number | null>(null);

    // ── In-Browser Stockfish 19 Live Analysis ────────────────────────────────
    const [isAnalyzing, setIsAnalyzing] = useState<boolean>(() => {
      return localStorage.getItem('chess_live_analysis') === 'true';
    });
    const [engineLines, setEngineLines] = useState<EngineLine[]>([]);
    const [multiPvSetting, setMultiPvSetting] = useState<number>(() => {
      const saved = localStorage.getItem('chess_sf_multipv');
      return saved ? parseInt(saved, 10) : 2;
    });
    const [depthSetting, setDepthSetting] = useState<number>(() => {
      const saved = localStorage.getItem('chess_sf_depth');
      return saved ? parseInt(saved, 10) : 18;
    });
    const sfServiceRef = useRef<StockfishService | null>(null);

    // User drawn shapes (persistent per session)
    const [userShapes, setUserShapes] = useState<DrawShape[]>([]);

    // Board Splitter dragging (resizing chessboard vs move list)
    const isDraggingBoardSplitter = useRef(false);
    const dragStartY = useRef(0);
    const initialDragSize = useRef(0);

    const handleBoardSplitterStart = useCallback(
      (e: React.MouseEvent) => {
        e.preventDefault();
        isDraggingBoardSplitter.current = true;
        dragStartY.current = e.clientY;
        initialDragSize.current = effectiveBoardSize;
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';

        const onMouseMove = (moveEvent: MouseEvent) => {
          if (!isDraggingBoardSplitter.current) return;
          const deltaY = moveEvent.clientY - dragStartY.current;
          const maxAllowed = Math.max(220, maxBoardWidth);
          const nextSize = Math.max(180, Math.min(initialDragSize.current + deltaY, maxAllowed));
          setBoardSize(nextSize);
        };

        const onMouseUp = () => {
          isDraggingBoardSplitter.current = false;
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
          setBoardSize(s => {
            localStorage.setItem('chess_board_size', String(s));
            return s;
          });
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      },
      [effectiveBoardSize, maxBoardWidth],
    );

    const parsedPayload = useMemo(() => {
      if (!payloadJson) return null;
      try {
        return JSON.parse(payloadJson);
      } catch (e) {
        console.warn('Failed to parse payloadJson in InteractiveBoard', e);
        return null;
      }
    }, [payloadJson]);

    // ── Parse Ground-Truth Game Plies from PGN & Critical Moments ─────────────
    const plies = useMemo(() => {
      const cmMap = new Map<number, CriticalMomentData>();
      if (parsedPayload?.critical_moments && Array.isArray(parsedPayload.critical_moments)) {
        for (const cm of parsedPayload.critical_moments) {
          cmMap.set(cm.ply, cm);
        }
      }

      const gamePlies: GamePly[] = [];
      const c = new Chess();

      // Ply 0: initial position
      gamePlies.push({
        ply: 0,
        fen: c.fen(),
        san: 'Start',
        moveNumber: 0,
        color: 'w',
      });

      if (pgnText) {
        try {
          c.loadPgn(pgnText);
          const history = c.history({ verbose: true });
          history.forEach((m, idx) => {
            const plyNum = idx + 1;
            const moveNum = Math.floor(idx / 2) + 1;
            gamePlies.push({
              ply: plyNum,
              fen: m.after,
              san: m.san,
              moveNumber: moveNum,
              color: m.color,
              from: m.from as Key,
              to: m.to as Key,
              criticalMoment: cmMap.get(plyNum),
            });
          });
        } catch (err) {
          console.warn('Could not parse full PGN in InteractiveBoard', err);
        }
      }

      return gamePlies;
    }, [pgnText, parsedPayload]);

    const initialVarData = useMemo(() => {
      if (!initialVariation || !initialVariation.moves.length || !plies.length) return null;
      const { branchPly: bPly, moves } = initialVariation;
      if (bPly < 0 || bPly >= plies.length) return null;

      const baseFen = plies[bPly].fen;
      const sim = new Chess(baseFen);
      const newVarPlies: VariationPly[] = [];
      const baseMoveNum = plies[bPly].moveNumber;
      const baseColor = plies[bPly].color;

      for (let i = 0; i < moves.length; i++) {
        try {
          const moveRes = sim.move(moves[i]);
          if (!moveRes) break;
          const moveNumber =
            baseColor === 'b'
              ? baseMoveNum + 1 + Math.floor(i / 2)
              : baseMoveNum + Math.floor((i + 1) / 2);

          newVarPlies.push({
            plyIndex: i,
            fen: sim.fen(),
            san: moveRes.san,
            moveNumber,
            color: moveRes.color,
            from: moveRes.from as Key,
            to: moveRes.to as Key,
          });
        } catch {
          break;
        }
      }
      return newVarPlies.length > 0 ? { branchPly: bPly, varPlies: newVarPlies } : null;
    }, [initialVariation, plies]);

    // ── Lichess-Style Exploration Variations ─────────────────────────────────
    const [isFreePlay, setIsFreePlay] = useState<boolean>(() => Boolean(initialVarData));
    const [branchPly, setBranchPly] = useState<number>(() => initialVarData?.branchPly ?? 0);
    const [variationPlies, setVariationPlies] = useState<VariationPly[]>(
      () => initialVarData?.varPlies ?? [],
    );
    const [currentVarIndex, setCurrentVarIndex] = useState<number>(() => (initialVarData ? 0 : -1));
    const [freeChess, setFreeChess] = useState<Chess | null>(() =>
      initialVarData && initialVarData.varPlies.length > 0
        ? new Chess(initialVarData.varPlies[0].fen)
        : null,
    );

    const startVariation = useCallback(
      (bPly: number, moves: string[]) => {
        if (bPly < 0 || bPly >= plies.length || !moves || moves.length === 0) return;
        const baseFen = plies[bPly].fen;
        const sim = new Chess(baseFen);
        const newVarPlies: VariationPly[] = [];
        const baseMoveNum = plies[bPly].moveNumber;
        const baseColor = plies[bPly].color;

        for (let i = 0; i < moves.length; i++) {
          try {
            const moveRes = sim.move(moves[i]);
            if (!moveRes) break;
            const moveNumber =
              baseColor === 'b'
                ? baseMoveNum + 1 + Math.floor(i / 2)
                : baseMoveNum + Math.floor((i + 1) / 2);

            newVarPlies.push({
              plyIndex: i,
              fen: sim.fen(),
              san: moveRes.san,
              moveNumber,
              color: moveRes.color,
              from: moveRes.from as Key,
              to: moveRes.to as Key,
            });
          } catch {
            break;
          }
        }

        if (newVarPlies.length > 0) {
          setBranchPly(bPly);
          setVariationPlies(newVarPlies);
          setCurrentVarIndex(0);
          setIsFreePlay(true);
          setFreeChess(new Chess(newVarPlies[0].fen));
          onSelectPly(bPly);
        }
      },
      [plies, onSelectPly],
    );

    const resetVariation = useCallback(() => {
      setIsFreePlay(false);
      setVariationPlies([]);
      setCurrentVarIndex(-1);
      setFreeChess(null);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        startVariation,
        resetVariation,
      }),
      [startVariation, resetVariation],
    );

    // Current active ply clamped to range
    const safePly = Math.max(0, Math.min(currentPly, plies.length - 1));
    const currentPlyData = plies[safePly] || plies[0];

    // Active FEN on the board (either free play variation or mainline)
    const activeFen = useMemo(() => {
      if (isFreePlay) {
        if (currentVarIndex >= 0 && variationPlies[currentVarIndex]) {
          return variationPlies[currentVarIndex].fen;
        }
        if (freeChess) {
          return freeChess.fen();
        }
      }
      return currentPlyData?.fen || 'start';
    }, [isFreePlay, currentVarIndex, variationPlies, freeChess, currentPlyData]);

    // ── Stockfish 19 Service Management ─────────────────────────────────────
    useEffect(() => {
      if (!isAnalyzing) {
        if (sfServiceRef.current) {
          sfServiceRef.current.destroy();
          sfServiceRef.current = null;
        }
        return;
      }

      if (!sfServiceRef.current) {
        sfServiceRef.current = new StockfishService({
          multiPv: multiPvSetting,
          maxDepth: depthSetting,
        });
        sfServiceRef.current.onUpdate(lines => {
          setEngineLines(lines);
        });
        sfServiceRef.current.init().then(() => {
          if (activeFen) sfServiceRef.current?.evaluate(activeFen);
        });
      } else {
        sfServiceRef.current.evaluate(activeFen);
      }

      return () => {
        // Don't terminate on every FEN change; evaluate stops previous search
      };
    }, [isAnalyzing, activeFen, multiPvSetting, depthSetting]);

    // Cleanup Stockfish on component unmount
    useEffect(() => {
      return () => {
        if (sfServiceRef.current) {
          sfServiceRef.current.destroy();
          sfServiceRef.current = null;
        }
      };
    }, []);

    // Calculate legal move destinations (Dests) for Chessground
    const getLegalDests = useCallback((fen: string): Dests => {
      const dests: Dests = new Map();
      try {
        const temp = new Chess(fen);
        for (const m of temp.moves({ verbose: true })) {
          const from = m.from as Key;
          const to = m.to as Key;
          if (!dests.has(from)) dests.set(from, []);
          dests.get(from)!.push(to);
        }
      } catch {
        // fallback
      }
      return dests;
    }, []);

    const isValidSquare = (s?: string): s is Key => Boolean(s && /^[a-h][1-8]$/.test(s));

    // Derive auto-shapes for the current position
    // 1. If Stockfish Live Analysis is ON: show PV 1 (Dark Gray) and PV 2 (Light Gray)
    // 2. Otherwise if on a critical moment: show blunder (red) and best move (green)
    const currentAutoShapes = useMemo((): DrawShape[] => {
      if (isAnalyzing && engineLines.length > 0 && engineLines[0]?.fen === activeFen) {
        const shapes: DrawShape[] = [];
        // Top engine move: Dark Gray arrow
        if (isValidSquare(engineLines[0]?.from) && isValidSquare(engineLines[0]?.to)) {
          shapes.push({
            orig: engineLines[0].from,
            dest: engineLines[0].to,
            brush: 'darkGray',
          });
        }
        // Second alternative move: Light Gray arrow
        if (isValidSquare(engineLines[1]?.from) && isValidSquare(engineLines[1]?.to)) {
          shapes.push({
            orig: engineLines[1].from,
            dest: engineLines[1].to,
            brush: 'lightGray',
          });
        }
        return shapes;
      }

      if (isFreePlay || !currentPlyData?.criticalMoment) return [];
      const cm = currentPlyData.criticalMoment;
      const shapes: DrawShape[] = [];

      const prevPly = plies[safePly - 1];
      if (prevPly) {
        try {
          const temp = new Chess(prevPly.fen);
          if (isValidSquare(currentPlyData.from) && isValidSquare(currentPlyData.to)) {
            shapes.push({
              orig: currentPlyData.from,
              dest: currentPlyData.to,
              brush: 'red',
            });
          }
          if (cm.best_move_san) {
            const best = temp.move(cm.best_move_san);
            if (best && isValidSquare(best.from) && isValidSquare(best.to)) {
              shapes.push({
                orig: best.from,
                dest: best.to,
                brush: 'green',
              });
            }
          }
        } catch {
          // ignore
        }
      }
      return shapes;
    }, [isAnalyzing, engineLines, activeFen, isFreePlay, currentPlyData, plies, safePly]);

    // Handle user making an experimental move on the board
    const handleUserMove = useCallback(
      (orig: Key, dest: Key) => {
        const chessInst = new Chess(activeFen);

        try {
          const moveRes = chessInst.move({ from: orig, to: dest, promotion: 'q' });
          if (moveRes) {
            const nextFen = chessInst.fen();
            const newMoveNum = !isFreePlay
              ? currentPlyData.moveNumber
              : Math.floor((variationPlies.length + 1) / 2) + currentPlyData.moveNumber;

            const newVarPly: VariationPly = {
              plyIndex: variationPlies.length,
              fen: nextFen,
              san: moveRes.san,
              moveNumber: newMoveNum,
              color: moveRes.color,
              from: orig,
              to: dest,
            };

            if (!isFreePlay) {
              setBranchPly(safePly);
              setVariationPlies([newVarPly]);
              setCurrentVarIndex(0);
              setIsFreePlay(true);
            } else {
              setVariationPlies(prev => [...prev, newVarPly]);
              setCurrentVarIndex(variationPlies.length);
            }

            setFreeChess(chessInst);

            if (cgApiRef.current) {
              const turnColor: Color = chessInst.turn() === 'w' ? 'white' : 'black';
              cgApiRef.current.set({
                fen: nextFen,
                turnColor,
                lastMove: [orig, dest],
                check: chessInst.inCheck() ? turnColor : false,
                movable: {
                  color: 'both',
                  dests: getLegalDests(nextFen),
                },
              });
            }
          }
        } catch (e) {
          console.warn('Illegal user exploration move', e);
        }
      },
      [activeFen, isFreePlay, currentPlyData, variationPlies, safePly, getLegalDests],
    );

    // Initialize or update Chessground
    useEffect(() => {
      if (!boardElRef.current) return;

      const turnColor: Color = activeFen.split(' ')[1] === 'b' ? 'black' : 'white';
      const lastMove = isFreePlay
        ? currentVarIndex >= 0 && variationPlies[currentVarIndex]
          ? [variationPlies[currentVarIndex].from, variationPlies[currentVarIndex].to]
          : undefined
        : currentPlyData?.from && currentPlyData?.to
          ? [currentPlyData.from, currentPlyData.to]
          : undefined;

      const config: Config = {
        fen: activeFen,
        orientation: orientation,
        turnColor: turnColor,
        lastMove: lastMove as Key[] | undefined,
        coordinates: true,
        coordinatesOnSquares: false, // Clean edge coordinates; prevents stacked square coordinates
        highlight: {
          lastMove: true,
          check: true,
        },
        animation: {
          enabled: true,
          duration: 200,
        },
        movable: {
          free: false,
          color: 'both',
          dests: getLegalDests(activeFen),
          events: {
            after: (orig, dest) => handleUserMove(orig as Key, dest as Key),
          },
        },
        drawable: {
          enabled: true,
          visible: true,
          defaultSnapToValidMove: true,
          brushes: {
            green: { key: 'green', color: '#15803d', opacity: 0.85, lineWidth: 10 },
            red: { key: 'red', color: '#dc2626', opacity: 0.85, lineWidth: 10 },
            blue: { key: 'blue', color: '#2563eb', opacity: 0.85, lineWidth: 10 },
            yellow: { key: 'yellow', color: '#eab308', opacity: 0.85, lineWidth: 10 },
            darkGray: { key: 'darkGray', color: '#374151', opacity: 0.9, lineWidth: 10 },
            lightGray: { key: 'lightGray', color: '#9ca3af', opacity: 0.78, lineWidth: 8 },
          },
          shapes: userShapes,
          autoShapes: currentAutoShapes,
          onChange: shapes => setUserShapes(shapes),
        },
      };

      if (!cgApiRef.current) {
        cgApiRef.current = Chessground(boardElRef.current, config);
      } else {
        cgApiRef.current.set(config);
      }
    }, [
      activeFen,
      orientation,
      isFreePlay,
      currentVarIndex,
      variationPlies,
      userShapes,
      currentAutoShapes,
      currentPlyData,
      getLegalDests,
      handleUserMove,
    ]);

    // Invalidate Chessground's cached DOM bounds so that square hit-testing is always pixel-perfect
    const clearBoardBounds = useCallback(() => {
      interface ChessgroundWithBounds {
        state?: {
          dom?: {
            bounds?: {
              clear?: () => void;
            };
          };
        };
      }
      const cg = cgApiRef.current as ChessgroundWithBounds | null;
      if (cg?.state?.dom?.bounds?.clear) {
        cg.state.dom.bounds.clear();
      }
    }, []);

    // Safely redraw board only if container has valid non-zero dimensions to avoid SVG NaN coordinates
    const safeRedraw = useCallback(() => {
      const el = boardElRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      clearBoardBounds();
      cgApiRef.current?.redrawAll();
    }, [clearBoardBounds]);

    // Redraw board whenever board size changes
    useEffect(() => {
      if (cgApiRef.current) {
        safeRedraw();
      }
    }, [effectiveBoardSize, safeRedraw]);

    // Clear cached Chessground bounds immediately before any mouse/touch interaction
    // to ensure square detection is 100% accurate even after dynamic layout shifts above the board
    useEffect(() => {
      const el = boardElRef.current;
      if (!el) return;

      const handleInteraction = () => {
        clearBoardBounds();
      };

      const listenerOpts: AddEventListenerOptions = { capture: true, passive: true };

      el.addEventListener('pointerdown', handleInteraction, listenerOpts);
      el.addEventListener('mousedown', handleInteraction, listenerOpts);
      el.addEventListener('touchstart', handleInteraction, listenerOpts);
      el.addEventListener('pointerenter', handleInteraction, listenerOpts);
      el.addEventListener('mouseenter', handleInteraction, listenerOpts);

      return () => {
        el.removeEventListener('pointerdown', handleInteraction, listenerOpts);
        el.removeEventListener('mousedown', handleInteraction, listenerOpts);
        el.removeEventListener('touchstart', handleInteraction, listenerOpts);
        el.removeEventListener('pointerenter', handleInteraction, listenerOpts);
        el.removeEventListener('mouseenter', handleInteraction, listenerOpts);
      };
    }, [clearBoardBounds]);

    // Invalidate Chessground bounds whenever components above or below the board mount/resize
    useEffect(() => {
      clearBoardBounds();
      const rafId = requestAnimationFrame(() => {
        clearBoardBounds();
      });
      const timer = setTimeout(clearBoardBounds, 120);
      return () => {
        cancelAnimationFrame(rafId);
        clearTimeout(timer);
      };
    }, [isAnalyzing, showSettings, multiPvSetting, showEvalChart, isFreePlay, clearBoardBounds]);

    // Cleanup on unmount
    useEffect(() => {
      return () => {
        if (cgApiRef.current) {
          cgApiRef.current.destroy();
          cgApiRef.current = null;
        }
      };
    }, []);

    // ResizeObserver to redraw board when container dimensions change
    useEffect(() => {
      const el = boardElRef.current;
      if (!el) return;
      const parent = el.parentElement;
      const ro = new ResizeObserver(() => {
        safeRedraw();
      });
      ro.observe(el);
      if (parent) ro.observe(parent);
      return () => ro.disconnect();
    }, [safeRedraw]);

    // Auto-scroll move list to keep active move visible
    useEffect(() => {
      const activeEl = moveListRef.current?.querySelector(`[data-ply="${safePly}"]`);
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }, [safePly]);

    // Autoplay loop
    useEffect(() => {
      if (!isAutoplaying) {
        if (autoplayTimerRef.current) {
          clearInterval(autoplayTimerRef.current);
          autoplayTimerRef.current = null;
        }
        return;
      }

      autoplayTimerRef.current = window.setInterval(() => {
        if (safePly >= plies.length - 1) {
          setIsAutoplaying(false);
        } else {
          onSelectPly(safePly + 1);
        }
      }, 1100);

      return () => {
        if (autoplayTimerRef.current) {
          clearInterval(autoplayTimerRef.current);
        }
      };
    }, [isAutoplaying, safePly, plies.length, onSelectPly]);

    // Reset exploration mode back to game mainline
    const handleResetToMainline = () => {
      setIsFreePlay(false);
      setFreeChess(null);
      setVariationPlies([]);
      setCurrentVarIndex(-1);
    };

    // Navigation handlers
    const handleGoToPly = (ply: number) => {
      setIsFreePlay(false);
      setFreeChess(null);
      setVariationPlies([]);
      setCurrentVarIndex(-1);
      onSelectPly(Math.max(0, Math.min(ply, plies.length - 1)));
    };

    const handleGoToVariationPly = (vIdx: number) => {
      if (variationPlies[vIdx]) {
        setCurrentVarIndex(vIdx);
        setFreeChess(new Chess(variationPlies[vIdx].fen));
      }
    };

    const handlePrev = () => {
      if (isFreePlay) {
        if (currentVarIndex > 0) {
          handleGoToVariationPly(currentVarIndex - 1);
        } else {
          handleResetToMainline();
        }
        return;
      }
      handleGoToPly(safePly - 1);
    };

    const handleNext = () => {
      if (isFreePlay) {
        if (currentVarIndex < variationPlies.length - 1) {
          handleGoToVariationPly(currentVarIndex + 1);
        }
        return;
      }
      handleGoToPly(safePly + 1);
    };

    const handleFirst = () => handleGoToPly(0);
    const handleLast = () => handleGoToPly(plies.length - 1);

    const handleFlip = () => {
      const nextOrient = orientation === 'white' ? 'black' : 'white';
      setOrientation(nextOrient);
      cgApiRef.current?.toggleOrientation();
    };

    const handleClearShapes = () => {
      setUserShapes([]);
      cgApiRef.current?.setShapes([]);
    };

    const handleToggleAnalysis = () => {
      const next = !isAnalyzing;
      setIsAnalyzing(next);
      if (!next) {
        setEngineLines([]);
      }
      localStorage.setItem('chess_live_analysis', String(next));
      clearBoardBounds();
      requestAnimationFrame(() => {
        safeRedraw();
      });
    };

    const handleSetMultiPv = (pv: number) => {
      setMultiPvSetting(pv);
      localStorage.setItem('chess_sf_multipv', String(pv));
      sfServiceRef.current?.updateSettings({ multiPv: pv });
    };

    const handleSetDepth = (depth: number) => {
      setDepthSetting(depth);
      localStorage.setItem('chess_sf_depth', String(depth));
      sfServiceRef.current?.updateSettings({ maxDepth: depth });
    };

    const handleSetBoardTheme = (theme: BoardTheme) => {
      setBoardTheme(theme);
      localStorage.setItem('chess_board_theme', theme);
    };

    const handleSetPieceTheme = (theme: PieceTheme) => {
      setPieceTheme(theme);
      localStorage.setItem('chess_piece_theme', theme);
    };

    const handlePresetBoardSize = (size: number) => {
      setBoardSize(size);
      localStorage.setItem('chess_board_size', String(size));
    };

    // Keyboard navigation
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          handlePrev();
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          handleNext();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          handleFirst();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          handleLast();
        } else if (e.key === 'f' || e.key === 'F') {
          handleFlip();
        } else if (e.key === ' ') {
          e.preventDefault();
          setIsAutoplaying(p => !p);
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    });

    // Format move pairs for timeline
    const movePairs = useMemo(() => {
      const pairs: Array<{
        moveNumber: number;
        white?: GamePly;
        black?: GamePly;
      }> = [];

      for (let i = 1; i < plies.length; i += 2) {
        const white = plies[i];
        const black = plies[i + 1];
        pairs.push({
          moveNumber: white.moveNumber,
          white,
          black,
        });
      }
      return pairs;
    }, [plies]);

    const activeBadge = useMemo(() => {
      if (isFreePlay || !currentPlyData?.criticalMoment || !currentPlyData?.to) return null;
      const badge = getClassificationBadge(currentPlyData.criticalMoment.classification);
      if (!badge) return null;

      // Calculate grid square col and row on the board
      const to = currentPlyData.to;
      const fileIdx = to.charCodeAt(0) - 'a'.charCodeAt(0);
      const rankNum = parseInt(to[1], 10);
      const col = orientation === 'white' ? fileIdx : 7 - fileIdx;
      const row = orientation === 'white' ? 8 - rankNum : rankNum - 1;

      return {
        ...badge,
        col,
        row,
        square: to,
      };
    }, [isFreePlay, currentPlyData, orientation]);

    // Pre-computed game evaluations for each ply (0..total_plies)
    const gamePlyEvals = useMemo<number[]>(() => {
      // 1. If parsedPayload has ply_evals
      if (
        parsedPayload?.ply_evals &&
        Array.isArray(parsedPayload.ply_evals) &&
        parsedPayload.ply_evals.length > 0
      ) {
        return parsedPayload.ply_evals.map((v: unknown) => (typeof v === 'number' ? v : 0));
      }

      // 2. Otherwise reconstruct/interpolate from critical moments:
      const total = plies.length;
      const evals = new Array(total).fill(null);
      evals[0] = 20; // Starting position: +0.20

      if (parsedPayload?.critical_moments && Array.isArray(parsedPayload.critical_moments)) {
        for (const cm of parsedPayload.critical_moments) {
          if (typeof cm.ply === 'number' && cm.ply < total) {
            if (cm.mate_after !== undefined && cm.mate_after !== null) {
              evals[cm.ply] = cm.mate_after > 0 ? 10000 - cm.mate_after : -10000 - cm.mate_after;
            } else {
              const cp =
                cm.eval_after_cp ??
                (cm.eval_after !== undefined ? Math.round(cm.eval_after * 100) : null);
              if (cp !== null) evals[cm.ply] = cp;
            }
            if (cm.ply > 1 && evals[cm.ply - 1] === null) {
              if (cm.mate_before !== undefined && cm.mate_before !== null) {
                evals[cm.ply - 1] =
                  cm.mate_before > 0 ? 10000 - cm.mate_before : -10000 - cm.mate_before;
              } else {
                const cp =
                  cm.eval_before_cp ??
                  (cm.eval_before !== undefined ? Math.round(cm.eval_before * 100) : null);
                if (cp !== null) evals[cm.ply - 1] = cp;
              }
            }
          }
        }
      }

      // Linear interpolation for missing gaps between known points
      let lastKnown = 20;
      for (let i = 0; i < total; i++) {
        if (evals[i] !== null) {
          lastKnown = evals[i];
        } else {
          let nextKnown = lastKnown;
          let nextIdx = i;
          for (let j = i + 1; j < total; j++) {
            if (evals[j] !== null) {
              nextKnown = evals[j];
              nextIdx = j;
              break;
            }
          }
          const span = nextIdx - (i - 1);
          const step = (nextKnown - lastKnown) / (span || 1);
          evals[i] = Math.round(lastKnown + step * (i - (i - 1)));
        }
      }

      return evals;
    }, [parsedPayload, plies]);

    // Current evaluation calculation for the eval bar
    const currentEval = useMemo(() => {
      // 1. If live analysis is active and we have engine lines for the current position:
      if (isAnalyzing && engineLines.length > 0 && engineLines[0]?.fen === activeFen) {
        const top = engineLines[0];
        if (top.scoreMate !== null) {
          return {
            cp: top.scoreMate > 0 ? 10000 - top.scoreMate : -10000 - top.scoreMate,
            mate: top.scoreMate,
            formatted:
              top.scoreMate > 0
                ? `+M${top.scoreMate}`
                : top.scoreMate < 0
                  ? `-M${Math.abs(top.scoreMate)}`
                  : 'M0',
            short:
              top.scoreMate > 0
                ? `M${top.scoreMate}`
                : top.scoreMate < 0
                  ? `-M${Math.abs(top.scoreMate)}`
                  : 'M0',
            source: 'Live Stockfish 19',
          };
        }
        if (top.scoreCp !== null) {
          const cp = top.scoreCp;
          const pawn = (cp / 100).toFixed(1);
          return {
            cp,
            mate: null,
            formatted: cp > 0 ? `+${pawn}` : pawn,
            short: cp > 0 ? `+${pawn}` : pawn,
            source: 'Live Stockfish 19',
          };
        }
      }

      // 2. Analyzed game data from payloadJson
      if (gamePlyEvals && gamePlyEvals[safePly] !== undefined && gamePlyEvals[safePly] !== null) {
        const cp = gamePlyEvals[safePly];
        if (Math.abs(cp) >= 9000) {
          const rawMate = cp > 0 ? 10000 - cp : -(10000 + cp);
          const mate = rawMate === 0 ? (cp > 0 ? 1 : -1) : rawMate;
          return {
            cp,
            mate,
            formatted:
              mate > 0 ? `+M${mate}` : mate < 0 ? `-M${Math.abs(mate)}` : cp > 0 ? '+M0' : '-M0',
            short: mate > 0 ? `M${mate}` : mate < 0 ? `-M${Math.abs(mate)}` : cp > 0 ? 'M0' : '-M0',
            source: 'Game Analysis',
          };
        }
        const pawn = (cp / 100).toFixed(1);
        return {
          cp,
          mate: null,
          formatted: cp > 0 ? `+${pawn}` : pawn,
          short: cp > 0 ? `+${pawn}` : pawn,
          source: 'Game Analysis',
        };
      }

      // 3. Fallback: if safePly has a criticalMoment
      if (currentPlyData?.criticalMoment) {
        const cm = currentPlyData.criticalMoment;
        if (cm.mate_after !== undefined && cm.mate_after !== null) {
          return {
            cp: cm.mate_after > 0 ? 10000 - cm.mate_after : -10000 - cm.mate_after,
            mate: cm.mate_after,
            formatted:
              cm.mate_after > 0
                ? `+M${cm.mate_after}`
                : cm.mate_after < 0
                  ? `-M${Math.abs(cm.mate_after)}`
                  : 'M0',
            short:
              cm.mate_after > 0
                ? `M${cm.mate_after}`
                : cm.mate_after < 0
                  ? `-M${Math.abs(cm.mate_after)}`
                  : 'M0',
            source: 'Critical Moment',
          };
        }
        const evalCp =
          cm.eval_after_cp ??
          (cm.eval_after !== undefined ? Math.round(cm.eval_after * 100) : null);
        if (evalCp !== null) {
          const pawn = (evalCp / 100).toFixed(1);
          return {
            cp: evalCp,
            mate: null,
            formatted: evalCp > 0 ? `+${pawn}` : pawn,
            short: evalCp > 0 ? `+${pawn}` : pawn,
            source: 'Critical Moment',
          };
        }
      }

      return {
        cp: 20,
        mate: null,
        formatted: '+0.2',
        short: '+0.2',
        source: 'Initial Position',
      };
    }, [isAnalyzing, engineLines, activeFen, gamePlyEvals, safePly, currentPlyData]);

    const evalBarData = useMemo(() => {
      const { cp, mate, formatted, short, source } = currentEval;
      let whitePercent: number;
      if (mate !== null) {
        whitePercent = mate > 0 ? 100 : 0;
      } else {
        const winProb = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
        whitePercent = Math.max(4, Math.min(96, winProb));
      }

      const isWhiteBottom = orientation === 'white';
      const bottomHeightPercent = isWhiteBottom ? whitePercent : 100 - whitePercent;

      return {
        whitePercent,
        bottomHeightPercent,
        isWhiteBottom,
        text: formatted,
        shortText: short,
        source,
      };
    }, [currentEval, orientation]);

    const handleToggleEvalChart = () => {
      setShowEvalChart(prev => {
        const next = !prev;
        localStorage.setItem('chess_show_eval_chart', String(next));
        return next;
      });
      clearBoardBounds();
    };

    const handleToggleSettings = () => {
      setShowSettings(prev => !prev);
      clearBoardBounds();
      requestAnimationFrame(() => {
        safeRedraw();
      });
    };

    const isSearchingCurrentFen = Boolean(
      isAnalyzing && (!engineLines.length || engineLines[0]?.fen !== activeFen),
    );

    return (
      <div className="flex flex-col h-full bg-white dark:bg-slate-900 select-none overflow-hidden">
        {/* Top Header: Analysis Toggle & Controls */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0 gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Live Analysis Toggle Button */}
            <button
              onClick={handleToggleAnalysis}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                isAnalyzing
                  ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs'
                  : 'bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700'
              }`}
              title="Toggle in-browser Stockfish 19 live analysis"
            >
              <Zap
                size={13}
                className={isAnalyzing ? 'animate-pulse text-amber-300' : 'text-slate-400'}
              />
              <span>Stockfish 19</span>
              <span className="text-[10px] font-normal opacity-90">
                {isAnalyzing ? 'ON' : 'OFF'}
              </span>
            </button>

            {/* Compact Return to Mainline Icon when in a variation */}
            {isFreePlay && (
              <button
                onClick={handleResetToMainline}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-amber-500 hover:bg-amber-600 text-white transition-colors cursor-pointer"
                title="Return to Game Mainline"
              >
                <RotateCcw size={12} />
                <span>Mainline</span>
              </button>
            )}

            {/* Current move indicator if not in variation */}
            {!isFreePlay && safePly > 0 && (
              <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                {currentPlyData.moveNumber}.{currentPlyData.color === 'b' ? '..' : ''}{' '}
                {currentPlyData.san}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1">
            {/* Quick Board Size Presets */}
            <div className="flex items-center bg-slate-100 dark:bg-slate-800 rounded p-0.5 text-[10px] font-semibold text-slate-500 dark:text-slate-400">
              <button
                onClick={() => handlePresetBoardSize(220)}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  effectiveBoardSize <= 240
                    ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-xs'
                    : 'hover:text-slate-900 dark:hover:text-slate-100'
                }`}
                title="Compact Board (220px) — Maximizes move list space"
              >
                S
              </button>
              <button
                onClick={() => handlePresetBoardSize(300)}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  effectiveBoardSize > 240 && effectiveBoardSize < 360
                    ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-xs'
                    : 'hover:text-slate-900 dark:hover:text-slate-100'
                }`}
                title="Medium Board (300px)"
              >
                M
              </button>
              <button
                onClick={() => handlePresetBoardSize(380)}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  effectiveBoardSize >= 360
                    ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-xs'
                    : 'hover:text-slate-900 dark:hover:text-slate-100'
                }`}
                title="Large Board (380px)"
              >
                L
              </button>
            </div>

            <button
              onClick={handleToggleSettings}
              title="Analysis & Board settings"
              className={`p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 transition-colors ${
                showSettings
                  ? 'bg-slate-100 dark:bg-slate-800 text-blue-600 dark:text-blue-400'
                  : ''
              }`}
            >
              <SettingsIcon size={15} />
            </button>
            <button
              onClick={onClose}
              title="Close board sidebar"
              className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Settings Panel Popover */}
        {showSettings && (
          <div className="p-3 bg-slate-50 dark:bg-slate-800/90 border-b border-slate-200 dark:border-slate-700/60 text-xs flex flex-col gap-3 shrink-0">
            {/* Live Analysis Engine Settings */}
            <div>
              <span className="font-semibold text-slate-700 dark:text-slate-200 block mb-1">
                Stockfish 19 Engine Settings
              </span>
              <div className="flex items-center gap-3">
                <label
                  htmlFor="sf-multipv-select"
                  className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300"
                >
                  <span>Multi-PV:</span>
                  <select
                    id="sf-multipv-select"
                    value={multiPvSetting}
                    onChange={e => handleSetMultiPv(parseInt(e.target.value, 10))}
                    className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-0.5 text-xs cursor-pointer"
                  >
                    <option value={1}>1 line</option>
                    <option value={2}>2 lines (Default)</option>
                    <option value={3}>3 lines</option>
                  </select>
                </label>

                <label
                  htmlFor="sf-depth-select"
                  className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300"
                >
                  <span>Depth:</span>
                  <select
                    id="sf-depth-select"
                    value={depthSetting}
                    onChange={e => handleSetDepth(parseInt(e.target.value, 10))}
                    className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-0.5 text-xs cursor-pointer"
                  >
                    <option value={14}>14 (Fast)</option>
                    <option value={18}>18 (Standard)</option>
                    <option value={22}>22 (Deep)</option>
                  </select>
                </label>
              </div>
            </div>

            <div>
              <span className="font-semibold text-slate-700 dark:text-slate-200 block mb-1">
                Board Color Theme
              </span>
              <div className="grid grid-cols-5 gap-1.5">
                {(
                  [
                    { id: 'green', label: 'Green', light: '#eeeed2', dark: '#769656' },
                    { id: 'brown', label: 'Wood', light: '#f0d9b5', dark: '#b58863' },
                    { id: 'blue', label: 'Blue', light: '#dee3e6', dark: '#8ca2ad' },
                    { id: 'dark', label: 'Dark', light: '#8e9499', dark: '#4b5358' },
                    { id: 'icicle', label: 'Ice', light: '#e0e6ed', dark: '#5a7b94' },
                  ] as const
                ).map(t => (
                  <button
                    key={t.id}
                    onClick={() => handleSetBoardTheme(t.id)}
                    className={`flex flex-col items-center gap-1 p-1 rounded border transition-all ${
                      boardTheme === t.id
                        ? 'border-blue-500 ring-2 ring-blue-500/20 bg-white dark:bg-slate-900 font-bold'
                        : 'border-slate-300 dark:border-slate-700 hover:border-slate-400'
                    }`}
                  >
                    <div className="w-5 h-5 rounded-xs grid grid-cols-2 grid-rows-2 overflow-hidden border border-slate-400/40">
                      <div style={{ backgroundColor: t.light }} />
                      <div style={{ backgroundColor: t.dark }} />
                      <div style={{ backgroundColor: t.dark }} />
                      <div style={{ backgroundColor: t.light }} />
                    </div>
                    <span className="text-[10px] text-slate-600 dark:text-slate-400">
                      {t.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="font-semibold text-slate-700 dark:text-slate-200 block mb-1">
                Piece Theme
              </span>
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    { id: 'cburnett', label: 'Cburnett (Lichess)' },
                    { id: 'merida', label: 'Merida (Staunton)' },
                    { id: 'alpha', label: 'Alpha (Modern)' },
                  ] as const
                ).map(p => (
                  <button
                    key={p.id}
                    onClick={() => handleSetPieceTheme(p.id)}
                    className={`py-1 px-2 rounded border text-center transition-all ${
                      pieceTheme === p.id
                        ? 'border-blue-500 bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 font-semibold shadow-xs'
                        : 'border-slate-300 dark:border-slate-700 hover:border-slate-400 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Live Engine Multi-PV Analysis Lines */}
        {isAnalyzing && (
          <div
            style={{
              height: multiPvSetting === 1 ? '32px' : multiPvSetting === 2 ? '52px' : '72px',
            }}
            className="px-3 py-1.5 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 font-mono text-xs shrink-0 overflow-hidden box-border"
          >
            {engineLines.length === 0 ? (
              <div className="flex flex-col gap-1">
                {Array.from({ length: multiPvSetting }).map((_, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 text-[11px] leading-tight h-[18px] text-slate-400 dark:text-slate-500"
                  >
                    <span className="w-2.5 h-2.5 rounded-full shrink-0 border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800" />
                    <span className="font-bold w-12 text-right opacity-30">—</span>
                    <span className="text-[10px] opacity-30">d—</span>
                    <span className="truncate text-slate-400 dark:text-slate-500 flex-1 font-sans text-xs flex items-center gap-1.5">
                      {i === 0 ? (
                        <>
                          <svg
                            className="animate-spin h-3 w-3 text-emerald-500 shrink-0 inline"
                            viewBox="0 0 24 24"
                            fill="none"
                          >
                            <circle
                              className="opacity-25"
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              strokeWidth="4"
                            />
                            <path
                              className="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8v8z"
                            />
                          </svg>
                          <span>Stockfish 19 searching…</span>
                        </>
                      ) : (
                        <span className="opacity-40">Calculating line {i + 1}…</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div
                className={`flex flex-col gap-1 transition-opacity duration-150 ${isSearchingCurrentFen ? 'opacity-70' : 'opacity-100'}`}
              >
                {engineLines.map(line => (
                  <div
                    key={line.multipv}
                    className="flex items-center gap-2 text-[11px] leading-tight h-[18px]"
                  >
                    <span
                      className={`w-2.5 h-2.5 rounded-full shrink-0 border ${
                        line.multipv === 1
                          ? 'bg-slate-700 border-slate-800 dark:bg-slate-300 dark:border-slate-100'
                          : 'bg-slate-400 border-slate-500 dark:bg-slate-500 dark:border-slate-400'
                      }`}
                      title={
                        line.multipv === 1
                          ? 'Best move (Dark Gray Arrow)'
                          : 'Alternative (Light Gray Arrow)'
                      }
                    />
                    <span className="font-bold w-12 text-right text-slate-900 dark:text-slate-100">
                      {line.formattedScore}
                    </span>
                    <span className="text-[10px] text-slate-400">d{line.depth}</span>
                    <span className="truncate text-slate-600 dark:text-slate-300 flex-1 font-sans text-xs">
                      {line.pvSan.slice(0, 6).join(' ')}
                    </span>
                    {isSearchingCurrentFen && line.multipv === 1 && (
                      <svg
                        className="animate-spin h-2.5 w-2.5 text-emerald-500 shrink-0 inline ml-1 opacity-70"
                        viewBox="0 0 24 24"
                        fill="none"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                      </svg>
                    )}
                  </div>
                ))}
                {/* Fill remaining lines if engineLines has fewer lines than multiPvSetting */}
                {Array.from({ length: Math.max(0, multiPvSetting - engineLines.length) }).map(
                  (_, i) => (
                    <div
                      key={`fill-${i}`}
                      className="flex items-center gap-2 text-[11px] leading-tight h-[18px] text-slate-400 dark:text-slate-500 opacity-40"
                    >
                      <span className="w-2.5 h-2.5 rounded-full shrink-0 border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800" />
                      <span className="font-bold w-12 text-right">—</span>
                      <span className="text-[10px]">d—</span>
                      <span className="truncate text-slate-400 dark:text-slate-500 flex-1 font-sans text-xs">
                        Calculating line {engineLines.length + i + 1}…
                      </span>
                    </div>
                  ),
                )}
              </div>
            )}
          </div>
        )}

        {/* Chessboard Container + Evaluation Bar */}
        <div className="p-2 bg-slate-100 dark:bg-slate-950 flex justify-center items-center gap-2 shrink-0">
          <div
            style={{ width: `${effectiveBoardSize}px`, height: `${effectiveBoardSize}px` }}
            onPointerDownCapture={clearBoardBounds}
            onMouseDownCapture={clearBoardBounds}
            onTouchStartCapture={clearBoardBounds}
            onMouseEnter={clearBoardBounds}
            className={`chessground-board-wrap relative board-theme-${boardTheme} ${
              pieceTheme !== 'cburnett' ? `piece-theme-${pieceTheme}` : ''
            }`}
          >
            <div ref={boardElRef} className="w-full h-full" />

            {/* Floating Move Classification Badge on Landing Square (only for moves that stand out) */}
            {activeBadge && (
              <div
                style={{
                  left: `${activeBadge.col * 12.5 + 12.5}%`,
                  top: `${activeBadge.row * 12.5}%`,
                  transform: 'translate(-85%, -15%)',
                }}
                className={`absolute z-10 w-5 h-5 rounded-full flex items-center justify-center font-black text-[10px] text-white shadow-lg border-2 border-white dark:border-slate-900 pointer-events-none select-none ${activeBadge.bgClass}`}
                title={`${activeBadge.label}: ${currentPlyData.san}`}
              >
                {activeBadge.symbol}
              </div>
            )}
          </div>

          {/* Vertical Evaluation Bar on Right */}
          <div
            style={{ height: `${effectiveBoardSize}px` }}
            className={`w-7 sm:w-8 rounded-sm overflow-hidden flex flex-col justify-end border border-slate-300 dark:border-slate-700 relative select-none shadow-sm shrink-0 cursor-default group transition-colors ${
              evalBarData.isWhiteBottom ? 'bg-slate-900' : 'bg-white'
            }`}
            title={`Evaluation: ${evalBarData.text} (${evalBarData.source})`}
          >
            {/* Subtle 50% Center Equilibrium Line */}
            <div className="absolute top-1/2 inset-x-0 h-px bg-slate-400/60 pointer-events-none z-10" />

            {/* Bottom Dynamic Portion */}
            <div
              style={{ height: `${evalBarData.bottomHeightPercent}%` }}
              className={`w-full transition-all duration-300 ease-out ${
                evalBarData.isWhiteBottom ? 'bg-white' : 'bg-slate-900'
              }`}
            />

            {/* Numeric eval label positioned in dominant side's territory */}
            <div
              className={`absolute inset-x-0 text-center font-sans font-bold leading-tight z-20 px-0.5 select-none whitespace-nowrap overflow-hidden text-ellipsis pointer-events-none ${
                evalBarData.shortText.length >= 5
                  ? 'text-[8.5px] tracking-tight'
                  : evalBarData.shortText.length === 4
                    ? 'text-[9.5px]'
                    : 'text-[10.5px]'
              } ${
                evalBarData.whitePercent >= 50
                  ? evalBarData.isWhiteBottom
                    ? 'bottom-1.5 text-slate-900'
                    : 'top-1.5 text-slate-900'
                  : evalBarData.isWhiteBottom
                    ? 'top-1.5 text-white'
                    : 'bottom-1.5 text-white'
              }`}
            >
              {evalBarData.shortText}
            </div>
          </div>
        </div>

        {/* Navigation Toolbar */}
        <div className="px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-white dark:bg-slate-900 shrink-0">
          <div className="flex items-center gap-0.5">
            <button
              onClick={handleFirst}
              disabled={safePly === 0 && !isFreePlay}
              title="First Move (Up Arrow)"
              className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent text-slate-600 dark:text-slate-300 transition-colors"
            >
              <ChevronsLeft size={15} />
            </button>
            <button
              onClick={handlePrev}
              disabled={safePly === 0 && !isFreePlay}
              title="Previous Move (Left Arrow)"
              className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent text-slate-600 dark:text-slate-300 transition-colors"
            >
              <ChevronLeft size={15} />
            </button>
            <button
              onClick={() => setIsAutoplaying(p => !p)}
              title={isAutoplaying ? 'Pause Autoplay (Space)' : 'Autoplay Game (Space)'}
              className={`p-1.5 rounded transition-colors ${
                isAutoplaying
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
            >
              {isAutoplaying ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <button
              onClick={handleNext}
              disabled={safePly >= plies.length - 1 && !isFreePlay}
              title="Next Move (Right Arrow)"
              className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent text-slate-600 dark:text-slate-300 transition-colors"
            >
              <ChevronRight size={15} />
            </button>
            <button
              onClick={handleLast}
              disabled={safePly >= plies.length - 1 && !isFreePlay}
              title="Last Move (Down Arrow)"
              className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent text-slate-600 dark:text-slate-300 transition-colors"
            >
              <ChevronsRight size={15} />
            </button>

            {/* Quick Zoom In / Out to fine-tune board size */}
            <div className="flex items-center gap-0.5 border-l border-slate-200 dark:border-slate-800 pl-1 ml-1 text-slate-500">
              <button
                onClick={() => handlePresetBoardSize(Math.max(180, effectiveBoardSize - 35))}
                title="Make chessboard smaller (expand move list)"
                className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 transition-colors"
              >
                <ZoomOut size={13} />
              </button>
              <button
                onClick={() =>
                  handlePresetBoardSize(Math.min(maxBoardWidth, effectiveBoardSize + 35))
                }
                title="Make chessboard larger"
                className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 transition-colors"
              >
                <ZoomIn size={13} />
              </button>
              <button
                onClick={() => handlePresetBoardSize(maxBoardWidth)}
                title="Fit board to sidebar width"
                className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 transition-colors"
              >
                <Maximize2 size={12} />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={handleFlip}
              title="Flip Board Orientation (F)"
              className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
            >
              <RotateCcw size={14} />
            </button>
            <button
              onClick={handleToggleEvalChart}
              title={showEvalChart ? 'Hide Evaluation Chart' : 'Show Evaluation Chart'}
              className={`p-1.5 rounded transition-colors cursor-pointer ${
                showEvalChart
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
            >
              <Activity size={14} />
            </button>
            {userShapes.length > 0 && (
              <button
                onClick={handleClearShapes}
                title="Clear Drawn Arrows & Circles"
                className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-rose-600 transition-colors cursor-pointer"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Centipawn Evaluation Chart */}
        {showEvalChart && (
          <EvaluationChart
            evals={gamePlyEvals}
            currentPly={safePly}
            onSelectPly={handleGoToPly}
            plies={plies}
            liveEval={
              isAnalyzing && engineLines.length > 0 && engineLines[0]?.fen === activeFen
                ? currentEval.formatted
                : undefined
            }
          />
        )}

        {/* Draggable Vertical Splitter Bar between Board Controls and Move List */}
        <div
          onMouseDown={handleBoardSplitterStart}
          onDoubleClick={() => handlePresetBoardSize(300)}
          className="h-2.5 w-full cursor-row-resize bg-slate-100 dark:bg-slate-800 hover:bg-blue-500/20 active:bg-blue-500/40 border-y border-slate-200 dark:border-slate-800 transition-colors flex items-center justify-center group select-none shrink-0"
          title="Drag up or down to resize chessboard and gain more move list space (Double-click to reset)"
        >
          <div className="w-10 h-0.5 rounded-full bg-slate-300 dark:bg-slate-600 group-hover:bg-blue-500 group-active:bg-blue-600 transition-colors" />
        </div>

        {/* Move Timeline List (Header removed to maximize vertical space) */}
        <div
          className="flex-1 overflow-y-auto min-h-0 bg-white dark:bg-slate-900"
          ref={moveListRef}
        >
          <div className="p-1.5 text-xs">
            <table className="w-full text-xs">
              <tbody>
                {/* Branch variation at starting position (before move 1) */}
                {isFreePlay && branchPly === 0 && variationPlies.length > 0 && (
                  <tr className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800">
                    <td
                      colSpan={3}
                      className="py-1.5 px-2.5 bg-amber-500/10 dark:bg-amber-500/15 border-l-2 border-amber-500"
                    >
                      <div className="flex flex-wrap items-center gap-1 text-[11px] font-mono leading-relaxed">
                        <span className="text-amber-700 dark:text-amber-400 font-sans font-semibold text-[10px] uppercase tracking-wider mr-1">
                          Var:
                        </span>
                        <span className="text-slate-400 dark:text-slate-500 font-sans">(</span>
                        {variationPlies.map((vm, vIdx) => {
                          const isActive = currentVarIndex === vIdx;
                          return (
                            <button
                              key={vIdx}
                              onClick={e => {
                                e.currentTarget.blur();
                                handleGoToVariationPly(vIdx);
                              }}
                              className={`px-1.5 py-0.5 rounded transition-colors cursor-pointer focus:outline-none focus:ring-0 focus-visible:outline-none ${
                                isActive
                                  ? 'bg-amber-600 text-white font-bold shadow-xs'
                                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                              }`}
                            >
                              {vm.color === 'w'
                                ? `${vm.moveNumber}. `
                                : vIdx === 0
                                  ? `${vm.moveNumber}... `
                                  : ''}
                              {vm.san}
                            </button>
                          );
                        })}
                        <span className="text-slate-400 dark:text-slate-500 font-sans">)</span>
                      </div>
                    </td>
                  </tr>
                )}

                {movePairs.map(pair => {
                  const whiteActive = pair.white && safePly === pair.white.ply && !isFreePlay;
                  const blackActive = pair.black && safePly === pair.black.ply && !isFreePlay;

                  const whiteBadge = pair.white
                    ? getClassificationBadge(pair.white.criticalMoment?.classification)
                    : null;
                  const blackBadge = pair.black
                    ? getClassificationBadge(pair.black.criticalMoment?.classification)
                    : null;

                  // Check if this move is where the current exploration variation branched off
                  const isBranchRow =
                    isFreePlay && pair.moveNumber === Math.floor((branchPly - 1) / 2) + 1;

                  return (
                    <Fragment key={pair.moveNumber}>
                      <tr className="border-b border-slate-100 dark:border-slate-800/50 hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
                        <td className="w-8 py-1 px-1.5 font-mono text-slate-400 text-right select-none font-medium">
                          {pair.moveNumber}.
                        </td>

                        {/* White move */}
                        <td className="w-[45%] py-0.5 px-0.5">
                          {pair.white && (
                            <button
                              data-ply={pair.white.ply}
                              onClick={e => {
                                e.currentTarget.blur();
                                handleGoToPly(pair.white!.ply);
                              }}
                              className={`w-full text-left px-2 py-1 rounded font-mono transition-colors flex items-center justify-between cursor-pointer focus:outline-none focus:ring-0 focus-visible:outline-none ${
                                whiteActive
                                  ? 'bg-blue-600 text-white font-bold shadow-xs'
                                  : 'hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200'
                              }`}
                            >
                              <span>{pair.white.san}</span>
                              {whiteBadge && (
                                <span
                                  className={`text-[9px] font-black px-1 py-0.2 rounded font-sans text-white ${whiteBadge.bgClass}`}
                                  title={whiteBadge.label}
                                >
                                  {whiteBadge.symbol}
                                </span>
                              )}
                            </button>
                          )}
                        </td>

                        {/* Black move */}
                        <td className="w-[45%] py-0.5 px-0.5">
                          {pair.black && (
                            <button
                              data-ply={pair.black.ply}
                              onClick={e => {
                                e.currentTarget.blur();
                                handleGoToPly(pair.black!.ply);
                              }}
                              className={`w-full text-left px-2 py-1 rounded font-mono transition-colors flex items-center justify-between cursor-pointer focus:outline-none focus:ring-0 focus-visible:outline-none ${
                                blackActive
                                  ? 'bg-blue-600 text-white font-bold shadow-xs'
                                  : 'hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200'
                              }`}
                            >
                              <span>{pair.black.san}</span>
                              {blackBadge && (
                                <span
                                  className={`text-[9px] font-black px-1 py-0.2 rounded font-sans text-white ${blackBadge.bgClass}`}
                                  title={blackBadge.label}
                                >
                                  {blackBadge.symbol}
                                </span>
                              )}
                            </button>
                          )}
                        </td>
                      </tr>

                      {/* Lichess-Style Inline Variation Row directly beneath the move pair row */}
                      {isBranchRow && variationPlies.length > 0 && (
                        <tr className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800">
                          <td
                            colSpan={3}
                            className="py-1.5 px-2.5 bg-amber-500/10 dark:bg-amber-500/15 border-l-2 border-amber-500"
                          >
                            <div className="flex flex-wrap items-center gap-1 text-[11px] font-mono leading-relaxed">
                              <span className="text-amber-700 dark:text-amber-400 font-sans font-semibold text-[10px] uppercase tracking-wider mr-1">
                                Var:
                              </span>
                              <span className="text-slate-400 dark:text-slate-500 font-sans">
                                (
                              </span>
                              {variationPlies.map((vm, vIdx) => {
                                const isActive = currentVarIndex === vIdx;
                                return (
                                  <button
                                    key={vIdx}
                                    onClick={e => {
                                      e.currentTarget.blur();
                                      handleGoToVariationPly(vIdx);
                                    }}
                                    className={`px-1.5 py-0.5 rounded transition-colors cursor-pointer focus:outline-none focus:ring-0 focus-visible:outline-none ${
                                      isActive
                                        ? 'bg-amber-600 text-white font-bold shadow-xs'
                                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                                    }`}
                                  >
                                    {vm.color === 'w'
                                      ? `${vm.moveNumber}. `
                                      : vIdx === 0
                                        ? `${vm.moveNumber}... `
                                        : ''}
                                    {vm.san}
                                  </button>
                                );
                              })}
                              <span className="text-slate-400 dark:text-slate-500 font-sans">
                                )
                              </span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  },
);
