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
  Sparkles,
  List,
  Send,
  Check,
  Plus,
  ExternalLink,
  Trophy,
  Clock,
} from 'lucide-react';
import { MoveBadgeGlyph } from './MoveBadgeGlyph';
import { askMoveQuestion, appendQAToReport, isDirectMode } from '../lib/api';
import {
  formatPlyEval,
  formatSecondsToClock,
  getBaseClockSeconds,
  getClassificationBadge,
  getClassificationTextColor,
  sortTagsNegativeFirst,
} from '../lib/badges';
import { classifyReportMove } from '../lib/chessNav';
import { getDeterministicMoveExplanation, renderCoachAnswerHtml } from '../lib/coachFormat';
import type { AskMoveResponse } from '../types';
import { StockfishService, type EngineLine } from '../lib/stockfishService';
import { EvaluationChart } from './EvaluationChart';
import { TagCapsule } from './TagCapsule';

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
  clock_seconds_remaining?: number | null;
  time_spent_seconds?: number | null;
  tags?: string[];
  facts_before_move?: {
    hanging_pieces?: string[];
    is_check?: boolean;
    fen?: string;
  };
  facts_after_played_move?: {
    hanging_pieces?: string[];
    is_check?: boolean;
    fen?: string;
  };
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
  clockSecondsRemaining?: number | null;
  timeSpentSeconds?: number | null;
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

export interface SubVariation {
  branchPlyIndex: number;
  parentFen: string;
  moves: VariationPly[];
}

function simulateVariationMoves(
  baseFen: string,
  moves: string[],
  baseMoveNumber: number,
  baseColor: 'w' | 'b',
): VariationPly[] {
  const sim = new Chess(baseFen);
  const result: VariationPly[] = [];
  for (let i = 0; i < moves.length; i++) {
    try {
      const moveRes = sim.move(moves[i]);
      if (!moveRes) break;
      const moveNumber =
        baseColor === 'b'
          ? baseMoveNumber + 1 + Math.floor(i / 2)
          : baseMoveNumber + Math.floor((i + 1) / 2);
      result.push({
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
  return result;
}

function getAdvantageText(cp: number, mate?: number | null) {
  if (mate !== undefined && mate !== null) {
    if (mate > 0)
      return { label: 'Winning Attack', shortScore: `+M${mate}`, isWhite: true, isEqual: false };
    return {
      label: 'Massively Better',
      shortScore: `-M${Math.abs(mate)}`,
      isWhite: false,
      isEqual: false,
    };
  }
  const clampedCp = Math.max(-1000, Math.min(1000, cp));
  const abs = Math.abs(clampedCp);
  const isWhite = clampedCp >= 0;
  const scoreStr =
    clampedCp > 0 ? `+${(clampedCp / 100).toFixed(1)}` : (clampedCp / 100).toFixed(1);
  if (abs <= 30) {
    return { label: 'Equal Position', shortScore: '0.0', isWhite: true, isEqual: true };
  }
  if (abs <= 100) {
    return { label: 'Slightly Better', shortScore: scoreStr, isWhite, isEqual: false };
  }
  if (abs <= 250) {
    return { label: 'Clearly Better', shortScore: scoreStr, isWhite, isEqual: false };
  }
  if (abs <= 500) {
    return { label: 'Winning Advantage', shortScore: scoreStr, isWhite, isEqual: false };
  }
  return { label: 'Massively Better', shortScore: scoreStr, isWhite, isEqual: false };
}

export interface InteractiveBoardHandle {
  startVariation: (branchPly: number, moves: string[]) => void;
  resetVariation: () => void;
  highlightSquare?: (square: string) => void;
  toggleAnalysis?: () => void;
  toggleSettings?: () => void;
  isAnalyzing?: () => boolean;
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
  analysisId?: number | string;
  onReportUpdated?: (reportHtml: string, reportMd: string) => void;
  onScrollToSection?: (sectionName: string) => void;
  isMobileDocked?: boolean;
  hideHeader?: boolean;
  onAnalysisToggled?: (analyzing: boolean) => void;
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
      analysisId,
      onReportUpdated,
      onScrollToSection,
      isMobileDocked = false,
      hideHeader = false,
      onAnalysisToggled,
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

    // Constrain board size to current container / viewport width
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 420;
    const effectiveContainerWidth = Math.min(sidebarWidth, viewportWidth);
    const maxBoardWidth = Math.max(180, effectiveContainerWidth - 32);
    // On mobile docked split view, reserve 38px for the vertical eval bar (30px) + gap (8px).
    // On desktop view, evaluation bar is horizontal below board, so full board width is used.
    const effectiveBoardSize = isMobileDocked
      ? Math.min(260, Math.max(180, maxBoardWidth - 38))
      : Math.max(180, Math.min(boardSize, maxBoardWidth));

    // Dynamic scaling for badges and coordinates based on square size
    const squareSize = effectiveBoardSize / 8;
    const badgeDiameter = Math.max(14, Math.min(24, Math.round(squareSize * 0.52)));
    const glyphSize = Math.max(10, Math.min(18, Math.round(badgeDiameter * 0.72)));
    const coordSize = Math.max(7, Math.min(11, Math.round(effectiveBoardSize / 36)));

    // Orientation
    const [orientation, setOrientation] = useState<Color>(() => {
      if (userSide?.toLowerCase().includes('black')) return 'black';
      return 'white';
    });

    // Evaluation Chart Visibility
    const [showEvalChart, setShowEvalChart] = useState<boolean>(() => {
      const saved = localStorage.getItem('chess_show_eval_chart');
      return saved !== null ? saved === 'true' : true;
    });

    // Move List Evaluation Visibility
    const [showMoveListEvals, setShowMoveListEvals] = useState<boolean>(() => {
      const saved = localStorage.getItem('chess_show_movelist_evals');
      return saved !== null ? saved === 'true' : true;
    });

    // Mobile Coach Drawer Visibility (in docked split mode)
    const [isMobileCoachOpen, setIsMobileCoachOpen] = useState(false);

    const handleToggleMoveListEvals = () => {
      setShowMoveListEvals(prev => {
        const next = !prev;
        localStorage.setItem('chess_show_movelist_evals', String(next));
        return next;
      });
    };

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

    const handleBoardSplitterTouchStart = useCallback(
      (e: React.TouchEvent) => {
        if (!e.touches[0]) return;
        isDraggingBoardSplitter.current = true;
        dragStartY.current = e.touches[0].clientY;
        initialDragSize.current = effectiveBoardSize;

        const onTouchMove = (moveEvent: TouchEvent) => {
          if (!isDraggingBoardSplitter.current || !moveEvent.touches[0]) return;
          const deltaY = moveEvent.touches[0].clientY - dragStartY.current;
          const maxAllowed = Math.max(220, maxBoardWidth);
          const nextSize = Math.max(160, Math.min(initialDragSize.current + deltaY, maxAllowed));
          setBoardSize(nextSize);
        };

        const onTouchEnd = () => {
          isDraggingBoardSplitter.current = false;
          window.removeEventListener('touchmove', onTouchMove);
          window.removeEventListener('touchend', onTouchEnd);
          setBoardSize(s => {
            localStorage.setItem('chess_board_size', String(s));
            return s;
          });
        };

        window.addEventListener('touchmove', onTouchMove, { passive: true });
        window.addEventListener('touchend', onTouchEnd);
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
          const plyClocks = parsedPayload?.ply_clocks;
          const plyTimes = parsedPayload?.ply_times_spent;

          history.forEach((m, idx) => {
            const plyNum = idx + 1;
            const moveNum = Math.floor(idx / 2) + 1;
            const cm = cmMap.get(plyNum);
            const clk = cm?.clock_seconds_remaining ?? (plyClocks ? plyClocks[plyNum] : undefined);
            const spent = cm?.time_spent_seconds ?? (plyTimes ? plyTimes[plyNum] : undefined);

            gamePlies.push({
              ply: plyNum,
              fen: m.after,
              san: m.san,
              moveNumber: moveNum,
              color: m.color,
              from: m.from as Key,
              to: m.to as Key,
              criticalMoment: cm,
              clockSecondsRemaining: clk,
              timeSpentSeconds: spent,
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
      const baseMoveNum = plies[bPly].moveNumber;
      const baseColor = plies[bPly].color;
      const newVarPlies = simulateVariationMoves(baseFen, moves, baseMoveNum, baseColor);
      return newVarPlies.length > 0 ? { branchPly: bPly, varPlies: newVarPlies } : null;
    }, [initialVariation, plies]);

    // ── Lichess-Style Exploration Variations ─────────────────────────────────
    const lastVarIdx = initialVarData ? initialVarData.varPlies.length - 1 : -1;
    const [isFreePlay, setIsFreePlay] = useState<boolean>(() => Boolean(initialVarData));
    const [branchPly, setBranchPly] = useState<number>(() => initialVarData?.branchPly ?? 0);
    const [variationPlies, setVariationPlies] = useState<VariationPly[]>(
      () => initialVarData?.varPlies ?? [],
    );
    const [currentVarIndex, setCurrentVarIndex] = useState<number>(() => lastVarIdx);
    const [freeChess, setFreeChess] = useState<Chess | null>(() =>
      initialVarData && lastVarIdx >= 0 ? new Chess(initialVarData.varPlies[lastVarIdx].fen) : null,
    );
    const [subVariations, setSubVariations] = useState<SubVariation[]>([]);

    // Square highlight state & auto-dismiss timer
    const [highlightedSquare, setHighlightedSquare] = useState<string | null>(null);
    const highlightedSquareRef = useRef<string | null>(null);
    const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const dismissHighlight = useCallback(() => {
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
      if (highlightedSquareRef.current) {
        highlightedSquareRef.current = null;
        setHighlightedSquare(null);
      }
    }, []);

    useEffect(() => {
      return () => {
        if (highlightTimerRef.current) {
          clearTimeout(highlightTimerRef.current);
          highlightTimerRef.current = null;
        }
      };
    }, []);

    const startVariation = useCallback(
      (bPly: number, moves: string[]) => {
        if (bPly < 0 || bPly >= plies.length || !moves || moves.length === 0) return;
        dismissHighlight();
        const baseFen = plies[bPly].fen;
        const baseMoveNum = plies[bPly].moveNumber;
        const baseColor = plies[bPly].color;
        const newVarPlies = simulateVariationMoves(baseFen, moves, baseMoveNum, baseColor);

        if (newVarPlies.length > 0) {
          const lastIdx = newVarPlies.length - 1;
          setBranchPly(bPly);
          setVariationPlies(newVarPlies);
          setCurrentVarIndex(lastIdx);
          setIsFreePlay(true);
          setFreeChess(new Chess(newVarPlies[lastIdx].fen));
          setSubVariations([]);
          onSelectPly(bPly);
        }
      },
      [plies, onSelectPly, dismissHighlight],
    );

    const handleSelectVariationMove = useCallback(
      (bPly: number, fullVarPlies: VariationPly[], targetVarIdx: number) => {
        dismissHighlight();
        setBranchPly(bPly);
        setVariationPlies(fullVarPlies);
        setCurrentVarIndex(targetVarIdx);
        setIsFreePlay(true);
        setFreeChess(new Chess(fullVarPlies[targetVarIdx].fen));
      },
      [dismissHighlight],
    );

    const resetVariation = useCallback(() => {
      dismissHighlight();
      setIsFreePlay(false);
      setVariationPlies([]);
      setCurrentVarIndex(-1);
      setFreeChess(null);
      setSubVariations([]);
    }, [dismissHighlight]);

    const highlightSquare = useCallback((square: string) => {
      const sq = square.toLowerCase().trim();
      if (!/^[a-h][1-8]$/.test(sq)) return;

      // Clear any pending timer
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }

      // Toggle off if already highlighted
      if (highlightedSquareRef.current === sq) {
        highlightedSquareRef.current = null;
        setHighlightedSquare(null);
        return;
      }

      // Highlight target square
      highlightedSquareRef.current = sq;
      setHighlightedSquare(sq);

      // Auto-dismiss after 3.5 seconds
      highlightTimerRef.current = setTimeout(() => {
        highlightedSquareRef.current = null;
        setHighlightedSquare(null);
        highlightTimerRef.current = null;
      }, 3500);
    }, []);

    // Current active ply clamped to range
    const safePly = Math.max(0, Math.min(currentPly, plies.length - 1));
    const currentPlyData = plies[safePly] || plies[0];

    // Precomputed suggested engine variations for each critical moment ply
    const engineVariationsByPly = useMemo(() => {
      const map = new Map<number, VariationPly[]>();
      if (!plies.length) return map;

      for (let i = 1; i < plies.length; i++) {
        const ply = plies[i];
        const cm = ply.criticalMoment;
        if (!cm) continue;

        // Never display an alternative variation for checkmate (the game is over)
        if (
          ply.san.includes('#') ||
          (cm.classification && cm.classification.toLowerCase().includes('checkmate'))
        ) {
          continue;
        }

        // An alternative variation is only meaningful when the move played was suboptimal
        // (blunder, mistake, inaccuracy, missed win, missed tactic) and differs from the recommendation
        const isSuboptimal =
          cm.classification &&
          ['blunder', 'mistake', 'inaccuracy', 'missed win', 'missed tactic', 'miss'].some(cls =>
            cm.classification.toLowerCase().includes(cls),
          );

        const isDifferentMove =
          cm.best_move_san &&
          cm.best_move_san !== ply.san &&
          cm.pv_san &&
          cm.pv_san.length > 0 &&
          cm.pv_san[0] !== ply.san;

        if (isSuboptimal && isDifferentMove && cm.pv_san && cm.pv_san.length > 0) {
          const bPly = i - 1;
          const baseFen = plies[bPly].fen;
          const baseMoveNum = plies[bPly].moveNumber;
          const baseColor = plies[bPly].color;
          const varPlies = simulateVariationMoves(baseFen, cm.pv_san, baseMoveNum, baseColor);
          if (varPlies.length > 0) {
            map.set(i, varPlies);
          }
        }
      }
      return map;
    }, [plies]);

    // Player metadata & remaining clock times
    const pgnHeaders = useMemo(() => {
      if (!pgnText) return {} as Record<string, string>;
      try {
        const c = new Chess();
        c.loadPgn(pgnText);
        return c.header();
      } catch {
        return {} as Record<string, string>;
      }
    }, [pgnText]);

    const whiteName = parsedPayload?.white_player || pgnHeaders?.White || 'White';
    const blackName = parsedPayload?.black_player || pgnHeaders?.Black || 'Black';
    const whiteElo = parsedPayload?.white_elo || pgnHeaders?.WhiteElo || '';
    const blackElo = parsedPayload?.black_elo || pgnHeaders?.BlackElo || '';

    const whiteInitial = (whiteName.trim()[0] || 'W').toUpperCase();
    const blackInitial = (blackName.trim()[0] || 'B').toUpperCase();

    const baseClockSecs = useMemo(() => {
      return (
        getBaseClockSeconds(
          parsedPayload?.time_control || pgnHeaders?.TimeControl,
          parsedPayload?.ply_clocks,
        ) ?? 300
      );
    }, [parsedPayload, pgnHeaders]);

    const { whiteClock, blackClock } = useMemo(() => {
      let wSecs: number | null | undefined = null;
      let bSecs: number | null | undefined = null;

      if (safePly === 0) {
        wSecs = baseClockSecs;
        bSecs = baseClockSecs;
      } else {
        for (let p = safePly; p >= 1; p--) {
          const ply = plies[p];
          if (
            ply &&
            ply.color === 'w' &&
            ply.clockSecondsRemaining !== undefined &&
            ply.clockSecondsRemaining !== null
          ) {
            wSecs = ply.clockSecondsRemaining;
            break;
          }
        }
        if (wSecs === null) {
          wSecs = baseClockSecs;
        }

        for (let p = safePly; p >= 1; p--) {
          const ply = plies[p];
          if (
            ply &&
            ply.color === 'b' &&
            ply.clockSecondsRemaining !== undefined &&
            ply.clockSecondsRemaining !== null
          ) {
            bSecs = ply.clockSecondsRemaining;
            break;
          }
        }
        if (bSecs === null) {
          bSecs = baseClockSecs;
        }
      }

      return {
        whiteClock: formatSecondsToClock(wSecs),
        blackClock: formatSecondsToClock(bSecs),
      };
    }, [safePly, plies, baseClockSecs]);

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
          let best: { from: Key; to: Key } | null = null;
          if (cm.best_move_san) {
            const bestMoveObj = temp.move(cm.best_move_san);
            if (bestMoveObj && isValidSquare(bestMoveObj.from) && isValidSquare(bestMoveObj.to)) {
              best = { from: bestMoveObj.from as Key, to: bestMoveObj.to as Key };
            }
          }

          const pFrom = currentPlyData.from;
          const pTo = currentPlyData.to;
          const hasValidPlayedMove = Boolean(
            pFrom && pTo && isValidSquare(pFrom) && isValidSquare(pTo),
          );

          const isSameMove =
            best !== null && hasValidPlayedMove && best.from === pFrom && best.to === pTo;

          if (isSameMove && pFrom && pTo) {
            // Player played the engine's best move: draw a single green arrow
            shapes.push({
              orig: pFrom,
              dest: pTo,
              brush: 'green',
            });
          } else {
            // Played move was different from best move: show played in red and recommendation in green
            if (hasValidPlayedMove && pFrom && pTo) {
              shapes.push({
                orig: pFrom,
                dest: pTo,
                brush: 'red',
              });
            }
            if (best) {
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
        const moveNum = chessInst.moveNumber();

        try {
          const moveRes = chessInst.move({ from: orig, to: dest, promotion: 'q' });
          if (moveRes) {
            const nextFen = chessInst.fen();

            if (!isFreePlay) {
              setBranchPly(safePly);
              const newVarPly: VariationPly = {
                plyIndex: 0,
                fen: nextFen,
                san: moveRes.san,
                moveNumber: moveNum,
                color: moveRes.color,
                from: orig,
                to: dest,
              };
              setVariationPlies([newVarPly]);
              setCurrentVarIndex(0);
              setIsFreePlay(true);
            } else {
              // User is already exploring a variation.
              // If user was at move index k < length - 1, preserve the previous continuation as sub-variation
              if (currentVarIndex >= 0 && currentVarIndex < variationPlies.length - 1) {
                const subBranchPlies = variationPlies.slice(currentVarIndex + 1);
                setSubVariations(prev => [
                  ...prev,
                  {
                    branchPlyIndex: currentVarIndex,
                    parentFen: activeFen,
                    moves: subBranchPlies,
                  },
                ]);
              }
              const basePlies =
                currentVarIndex >= 0 ? variationPlies.slice(0, currentVarIndex + 1) : [];
              const newVarPly: VariationPly = {
                plyIndex: basePlies.length,
                fen: nextFen,
                san: moveRes.san,
                moveNumber: moveNum,
                color: moveRes.color,
                from: orig,
                to: dest,
              };
              const nextPlies = [...basePlies, newVarPly];
              setVariationPlies(nextPlies);
              setCurrentVarIndex(nextPlies.length - 1);
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
      [activeFen, isFreePlay, currentVarIndex, variationPlies, safePly, getLegalDests],
    );

    // Initialize or update Chessground
    useEffect(() => {
      if (!boardElRef.current) return;

      const sim = new Chess(activeFen);
      const inCheck = sim.inCheck();
      const checkColor: Color | boolean = inCheck
        ? sim.turn() === 'w'
          ? 'white'
          : 'black'
        : false;

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
        check: checkColor,
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
      dismissHighlight();
      setIsFreePlay(false);
      setFreeChess(null);
      setVariationPlies([]);
      setSubVariations([]);
      setCurrentVarIndex(-1);
    };

    // Navigation handlers
    const handleGoToPly = useCallback(
      (ply: number) => {
        dismissHighlight();
        setIsFreePlay(false);
        setFreeChess(null);
        setVariationPlies([]);
        setSubVariations([]);
        setCurrentVarIndex(-1);
        onSelectPly(Math.max(0, Math.min(ply, plies.length - 1)));
      },
      [onSelectPly, plies.length, dismissHighlight],
    );

    const handleGoToVariationPly = (vIdx: number) => {
      dismissHighlight();
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

    const criticalPlies = useMemo(() => {
      return plies.filter(p => Boolean(p.criticalMoment)).map(p => p.ply);
    }, [plies]);

    const prevCriticalPly = useMemo(() => {
      for (let i = criticalPlies.length - 1; i >= 0; i--) {
        if (criticalPlies[i] < safePly) {
          return criticalPlies[i];
        }
      }
      return null;
    }, [criticalPlies, safePly]);

    const nextCriticalPly = useMemo(() => {
      for (let i = 0; i < criticalPlies.length; i++) {
        if (criticalPlies[i] > safePly) {
          return criticalPlies[i];
        }
      }
      return null;
    }, [criticalPlies, safePly]);

    const handlePrevCritical = useCallback(() => {
      if (prevCriticalPly !== null) {
        handleGoToPly(prevCriticalPly);
      }
    }, [prevCriticalPly, handleGoToPly]);

    const handleNextCritical = useCallback(() => {
      if (nextCriticalPly !== null) {
        handleGoToPly(nextCriticalPly);
      }
    }, [nextCriticalPly, handleGoToPly]);

    const prevCriticalTooltip = useMemo(() => {
      if (prevCriticalPly !== null) {
        const p = plies[prevCriticalPly];
        const cm = p?.criticalMoment;
        const moveLabel = `${p.moveNumber}.${p.color === 'b' ? '..' : ''} ${p.san}`;
        return `Previous Critical Moment: ${moveLabel} (${cm?.classification ?? 'Critical'}) (Shift+Left)`;
      }
      return criticalPlies.length > 0
        ? 'No earlier critical moments (Shift+Left)'
        : 'No critical moments in this game';
    }, [prevCriticalPly, plies, criticalPlies.length]);

    const nextCriticalTooltip = useMemo(() => {
      if (nextCriticalPly !== null) {
        const p = plies[nextCriticalPly];
        const cm = p?.criticalMoment;
        const moveLabel = `${p.moveNumber}.${p.color === 'b' ? '..' : ''} ${p.san}`;
        return `Next Critical Moment: ${moveLabel} (${cm?.classification ?? 'Critical'}) (Shift+Right)`;
      }
      return criticalPlies.length > 0
        ? 'No later critical moments (Shift+Right)'
        : 'No critical moments in this game';
    }, [nextCriticalPly, plies, criticalPlies.length]);

    const handleFlip = () => {
      const nextOrient = orientation === 'white' ? 'black' : 'white';
      setOrientation(nextOrient);
      cgApiRef.current?.toggleOrientation();
    };

    // Touch swipe / scrub navigation on toolbar
    const touchNavStartXRef = useRef<number | null>(null);
    const touchNavStartYRef = useRef<number | null>(null);
    const touchNavAccumulatedXRef = useRef<number>(0);
    const hasNavSwipedRef = useRef<boolean>(false);

    const handleToolbarTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
      if (e.touches.length > 0) {
        touchNavStartXRef.current = e.touches[0].clientX;
        touchNavStartYRef.current = e.touches[0].clientY;
        touchNavAccumulatedXRef.current = 0;
        hasNavSwipedRef.current = false;
      }
    };

    const handleToolbarTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
      if (
        e.touches.length === 0 ||
        touchNavStartXRef.current === null ||
        touchNavStartYRef.current === null
      ) {
        return;
      }
      const touch = e.touches[0];
      const diffX = touch.clientX - touchNavStartXRef.current;
      const diffY = touch.clientY - touchNavStartYRef.current;

      // Only engage if horizontal swipe is dominant
      if (Math.abs(diffX) > Math.abs(diffY)) {
        const STEP_THRESHOLD = 28;
        const deltaSinceLastStep = diffX - touchNavAccumulatedXRef.current;

        if (deltaSinceLastStep >= STEP_THRESHOLD) {
          // Swiped right -> Next move
          handleNext();
          touchNavAccumulatedXRef.current += STEP_THRESHOLD;
          hasNavSwipedRef.current = true;
          if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
            try {
              navigator.vibrate?.(5);
            } catch {
              // Ignore haptic error
            }
          }
        } else if (deltaSinceLastStep <= -STEP_THRESHOLD) {
          // Swiped left -> Previous move
          handlePrev();
          touchNavAccumulatedXRef.current -= STEP_THRESHOLD;
          hasNavSwipedRef.current = true;
          if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
            try {
              navigator.vibrate?.(5);
            } catch {
              // Ignore haptic error
            }
          }
        }
      }
    };

    const handleToolbarTouchEnd = () => {
      touchNavStartXRef.current = null;
      touchNavStartYRef.current = null;
      touchNavAccumulatedXRef.current = 0;
      if (hasNavSwipedRef.current) {
        setTimeout(() => {
          hasNavSwipedRef.current = false;
        }, 80);
      }
    };

    const handleToolbarClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
      if (hasNavSwipedRef.current) {
        e.stopPropagation();
        e.preventDefault();
      }
    };

    const handleClearShapes = () => {
      setUserShapes([]);
      cgApiRef.current?.setShapes([]);
    };

    const handleToggleAnalysis = useCallback(() => {
      setIsAnalyzing(prev => {
        const next = !prev;
        if (!next) {
          setEngineLines([]);
        }
        localStorage.setItem('chess_live_analysis', String(next));
        onAnalysisToggled?.(next);
        return next;
      });
      clearBoardBounds();
      requestAnimationFrame(() => {
        safeRedraw();
      });
    }, [onAnalysisToggled, clearBoardBounds, safeRedraw]);

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

    // ── Ask Coach Feature State & Handlers ───────────────────────────────────
    const [activeSidebarTab, setActiveSidebarTab] = useState<'moves' | 'coach'>('moves');
    const [userQuestion, setUserQuestion] = useState('');
    const [isAskingCoach, setIsAskingCoach] = useState(false);
    const [coachAnswer, setCoachAnswer] = useState<AskMoveResponse | null>(null);
    const [coachError, setCoachError] = useState<string | null>(null);
    const [isAppendingQA, setIsAppendingQA] = useState(false);
    const [appendedSuccess, setAppendedSuccess] = useState(false);

    const moveExplanationMarkdown = useMemo(() => {
      return getDeterministicMoveExplanation(currentPlyData);
    }, [currentPlyData]);

    const moveExplanationHtml = useMemo(() => {
      if (!moveExplanationMarkdown) return '';
      return renderCoachAnswerHtml(moveExplanationMarkdown, pgnText);
    }, [moveExplanationMarkdown, pgnText]);

    const activeCoachAnswer = useMemo(() => {
      if (!coachAnswer) return null;
      return coachAnswer.ply === safePly ? coachAnswer : null;
    }, [coachAnswer, safePly]);

    const coachAnswerHtml = useMemo(() => {
      if (!activeCoachAnswer?.answer_markdown) return '';
      return renderCoachAnswerHtml(activeCoachAnswer.answer_markdown, pgnText);
    }, [activeCoachAnswer, pgnText]);

    const handleAskCoach = useCallback(
      async (overrideQuestion?: string) => {
        const q = (overrideQuestion ?? userQuestion).trim();
        if (!q || !analysisId) return;

        setIsAskingCoach(true);
        setCoachError(null);
        setAppendedSuccess(false);

        const ply = safePly;
        const moveNumber = currentPlyData?.moveNumber ?? 1;
        const color = currentPlyData?.color === 'w' ? 'White' : 'Black';

        if (isDirectMode()) {
          setIsAskingCoach(false);
          const explanation = moveExplanationMarkdown
            ? `> 📱 **Mobile Reader Mode:** *Interactive LLM narrative questions require the PlyProse desktop backend server. Here is the verified deterministic engine facts for this move:*\n\n${moveExplanationMarkdown}`
            : `> 📱 **Mobile Reader Mode:** *Interactive LLM narrative questions require the PlyProse desktop backend server.*`;
          setCoachAnswer({
            formal_question: q,
            answer_markdown: explanation,
            move_context: currentPlyData?.san || '',
            ply,
            move_number: moveNumber,
            color,
          });
          setUserQuestion('');
          return;
        }

        try {
          const res = await askMoveQuestion(analysisId, {
            question: q,
            ply,
            move_number: moveNumber,
            color,
          });
          setCoachAnswer(res);
          setUserQuestion('');
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to consult coach';
          setCoachError(msg);
        } finally {
          setIsAskingCoach(false);
        }
      },
      [analysisId, userQuestion, safePly, currentPlyData, moveExplanationMarkdown],
    );

    const handleAppendQA = useCallback(async () => {
      if (!analysisId || !activeCoachAnswer) return;

      if (isDirectMode()) {
        alert(
          'Appending Q&A to the study repository report requires the PlyProse desktop backend server.',
        );
        return;
      }

      setIsAppendingQA(true);
      try {
        const res = await appendQAToReport(analysisId, {
          formal_question: activeCoachAnswer.formal_question,
          answer_markdown: activeCoachAnswer.answer_markdown,
          move_context: activeCoachAnswer.move_context,
          ply: activeCoachAnswer.ply,
        });
        if (res.ok) {
          setAppendedSuccess(true);
          onReportUpdated?.(res.report_html, res.report_md);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to add Q&A to review';
        alert(msg);
      } finally {
        setIsAppendingQA(false);
      }
    }, [analysisId, activeCoachAnswer, onReportUpdated]);

    const handleCoachAnswerClick = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement;
        if (!target) return;

        // 1. Clicked on a chessboard square pill (.chess-square-pill)
        const sqPill = target.closest('.chess-square-pill');
        if (sqPill) {
          const sq = sqPill.getAttribute('data-square');
          if (sq) {
            highlightSquare(sq);
            return;
          }
        }

        // 2. Clicked on a chess move button (.chess-move-btn)
        const moveBtn = target.closest('.chess-move-btn');
        if (moveBtn) {
          const moveType = moveBtn.getAttribute('data-move-type');
          if (moveType === 'variation') {
            const branchPlyStr = moveBtn.getAttribute('data-branch-ply');
            const movesRaw = moveBtn.getAttribute('data-moves');
            if (branchPlyStr && movesRaw) {
              const branch = parseInt(branchPlyStr, 10);
              try {
                const moves = JSON.parse(decodeURIComponent(movesRaw)) as string[];
                if (Array.isArray(moves) && moves.length > 0) {
                  startVariation(branch, moves);
                  return;
                }
              } catch {
                // ignore
              }
            }
          } else if (moveType === 'mainline') {
            const plyStr = moveBtn.getAttribute('data-ply');
            if (plyStr) {
              const ply = parseInt(plyStr, 10);
              if (!isNaN(ply)) {
                resetVariation();
                handleGoToPly(ply);
                return;
              }
            }
          }
        }

        // 3. Fallback for code elements (including bare squares or moves)
        const codeOrCell = target.closest('code');
        if (codeOrCell) {
          const text = (codeOrCell.textContent || '').trim();
          if (/^[a-h][1-8]$/i.test(text)) {
            highlightSquare(text);
            return;
          }
          const navTarget = classifyReportMove(text, pgnText, codeOrCell as HTMLElement);
          if (navTarget) {
            if (navTarget.type === 'variation' && navTarget.variationMoves?.length) {
              startVariation(navTarget.ply, navTarget.variationMoves);
              return;
            } else {
              resetVariation();
              handleGoToPly(navTarget.ply);
              return;
            }
          }
        }
      },
      [highlightSquare, startVariation, resetVariation, handleGoToPly, pgnText],
    );

    // Keyboard navigation
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (e.shiftKey || e.altKey) {
            handlePrevCritical();
          } else {
            handlePrev();
          }
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          if (e.shiftKey || e.altKey) {
            handleNextCritical();
          } else {
            handleNext();
          }
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

    // Grid coordinates for highlighted square
    const highlightedSquareCoord = useMemo(() => {
      if (!highlightedSquare || !/^[a-h][1-8]$/.test(highlightedSquare)) return null;
      const fileIdx = highlightedSquare.charCodeAt(0) - 'a'.charCodeAt(0);
      const rankNum = parseInt(highlightedSquare[1], 10);
      const col = orientation === 'white' ? fileIdx : 7 - fileIdx;
      const row = orientation === 'white' ? 8 - rankNum : rankNum - 1;
      return { col, row, square: highlightedSquare };
    }, [highlightedSquare, orientation]);

    // Pre-computed game evaluations for each ply (0..total_plies)
    const gamePlyEvals = useMemo<number[]>(() => {
      // 1. If parsedPayload has ply_evals
      if (
        parsedPayload?.ply_evals &&
        Array.isArray(parsedPayload.ply_evals) &&
        parsedPayload.ply_evals.length > 0
      ) {
        const rawEvals = parsedPayload.ply_evals;
        const hasNulls = rawEvals.some((v: unknown) => typeof v !== 'number');
        if (!hasNulls) {
          return rawEvals as number[];
        }
        const total = rawEvals.length;
        const evals: (number | null)[] = rawEvals.map((v: unknown) =>
          typeof v === 'number' ? v : null,
        );
        let lastKnown = evals[0] ?? 20;
        for (let i = 0; i < total; i++) {
          if (evals[i] !== null) {
            lastKnown = evals[i] as number;
          } else {
            let nextKnown = lastKnown;
            let nextIdx = i;
            for (let j = i + 1; j < total; j++) {
              if (evals[j] !== null) {
                nextKnown = evals[j] as number;
                nextIdx = j;
                break;
              }
            }
            const span = nextIdx - (i - 1);
            const step = (nextKnown - lastKnown) / (span || 1);
            evals[i] = Math.round(lastKnown + step * (i - (i - 1)));
          }
        }
        return evals as number[];
      }

      // 2. Otherwise reconstruct/interpolate from critical moments:
      const total = plies.length;
      if (total === 0) return [];
      const evals: (number | null)[] = new Array(total).fill(null);
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
        const val = evals[i];
        if (val !== null && val !== undefined) {
          lastKnown = val;
        } else {
          let nextKnown = lastKnown;
          let nextIdx = i;
          for (let j = i + 1; j < total; j++) {
            const nextVal = evals[j];
            if (nextVal !== null && nextVal !== undefined) {
              nextKnown = nextVal;
              nextIdx = j;
              break;
            }
          }
          const span = nextIdx - (i - 1);
          const step = (nextKnown - lastKnown) / (span || 1);
          evals[i] = Math.round(lastKnown + step * (i - (i - 1)));
        }
      }

      return evals.map(v => (typeof v === 'number' ? v : 0));
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
          const clamped = Math.max(-1000, Math.min(1000, cp));
          const pawn = (clamped / 100).toFixed(1);
          return {
            cp: clamped,
            mate: null,
            formatted: clamped > 0 ? `+${pawn}` : pawn,
            short: clamped > 0 ? `+${pawn}` : pawn,
            source: 'Live Stockfish 19',
          };
        }
      }

      // 2. Analyzed game data from payloadJson
      if (gamePlyEvals && gamePlyEvals[safePly] !== undefined && gamePlyEvals[safePly] !== null) {
        const cp = gamePlyEvals[safePly];
        if (Math.abs(cp) >= 9900) {
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
        const clamped = Math.max(-1000, Math.min(1000, cp));
        const pawn = (clamped / 100).toFixed(1);
        return {
          cp: clamped,
          mate: null,
          formatted: clamped > 0 ? `+${pawn}` : pawn,
          short: clamped > 0 ? `+${pawn}` : pawn,
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
          const clamped = Math.max(-1000, Math.min(1000, evalCp));
          const pawn = (clamped / 100).toFixed(1);
          return {
            cp: clamped,
            mate: null,
            formatted: clamped > 0 ? `+${pawn}` : pawn,
            short: clamped > 0 ? `+${pawn}` : pawn,
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
      if (mate !== null && mate !== undefined) {
        whitePercent = mate > 0 ? 100 : 0;
      } else {
        const winProb = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
        whitePercent = Math.max(0, Math.min(100, winProb));
      }

      const advantage = getAdvantageText(cp, mate);

      return {
        whitePercent,
        text: formatted,
        shortText: short,
        source,
        advantage,
      };
    }, [currentEval]);

    const handleToggleEvalChart = () => {
      setShowEvalChart(prev => {
        const next = !prev;
        localStorage.setItem('chess_show_eval_chart', String(next));
        return next;
      });
      clearBoardBounds();
    };

    const handleToggleSettings = useCallback(() => {
      setShowSettings(prev => !prev);
      clearBoardBounds();
      requestAnimationFrame(() => {
        safeRedraw();
      });
    }, [clearBoardBounds, safeRedraw]);

    useImperativeHandle(
      ref,
      () => ({
        startVariation,
        resetVariation,
        highlightSquare,
        toggleAnalysis: handleToggleAnalysis,
        toggleSettings: handleToggleSettings,
        isAnalyzing: () => isAnalyzing,
      }),
      [
        startVariation,
        resetVariation,
        highlightSquare,
        handleToggleAnalysis,
        handleToggleSettings,
        isAnalyzing,
      ],
    );

    const isSearchingCurrentFen = Boolean(
      isAnalyzing && (!engineLines.length || engineLines[0]?.fen !== activeFen),
    );

    const shouldHideHeader = hideHeader || isMobileDocked;

    // Header of the chessboard showing players, ratings, and clocks (same width as chessboard)
    const playerInfoBar = (
      <div
        style={{ width: `${effectiveBoardSize}px` }}
        className="px-2.5 py-1.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg flex items-center justify-between text-xs select-none shadow-xs"
      >
        {/* White Player (Left) */}
        <div className="flex flex-col items-start min-w-0 pr-2">
          <span
            className="font-bold text-slate-800 dark:text-slate-100 truncate max-w-[95px] sm:max-w-[220px]"
            title={whiteName}
          >
            {whiteName}
          </span>
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            <span className="flex items-center gap-1 font-mono">
              <Trophy size={11} className="text-amber-500 shrink-0" />
              {whiteElo || '—'}
            </span>
            <span>-</span>
            <span className="flex items-center gap-1 font-mono">
              <Clock size={11} className="text-slate-400 shrink-0" />
              {whiteClock || '—'}
            </span>
          </div>
        </div>

        {/* Black Player (Right) */}
        <div className="flex flex-col items-end min-w-0 pl-2">
          <span
            className="font-bold text-slate-800 dark:text-slate-100 truncate max-w-[95px] sm:max-w-[220px] text-right"
            title={blackName}
          >
            {blackName}
          </span>
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 justify-end">
            <span className="flex items-center gap-1 font-mono">
              <Clock size={11} className="text-slate-400 shrink-0" />
              {blackClock || '—'}
            </span>
            <span>-</span>
            <span className="flex items-center gap-1 font-mono">
              <Trophy size={11} className="text-amber-500 shrink-0" />
              {blackElo || '—'}
            </span>
          </div>
        </div>
      </div>
    );

    return (
      <div className="flex flex-col h-full bg-white dark:bg-slate-900 select-none overflow-hidden">
        {/* Top Header: Analysis Toggle & Controls */}
        {!shouldHideHeader && (
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
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-slate-700 hover:bg-slate-800 dark:bg-slate-600 dark:hover:bg-slate-500 text-white transition-colors cursor-pointer shadow-xs"
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
              {/* Quick Board Size Presets (hidden in mobile docked split mode) */}
              {!isMobileDocked && (
                <div className="flex items-center bg-slate-100 dark:bg-slate-800 rounded p-0.5 text-xs sm:text-[10px] font-semibold text-slate-500 dark:text-slate-400">
                  <button
                    onClick={() => handlePresetBoardSize(220)}
                    className={`min-h-[28px] min-w-[28px] sm:min-h-0 sm:min-w-0 px-2 sm:px-1.5 py-1 sm:py-0.5 rounded transition-colors flex items-center justify-center cursor-pointer ${
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
                    className={`min-h-[28px] min-w-[28px] sm:min-h-0 sm:min-w-0 px-2 sm:px-1.5 py-1 sm:py-0.5 rounded transition-colors flex items-center justify-center cursor-pointer ${
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
                    className={`min-h-[28px] min-w-[28px] sm:min-h-0 sm:min-w-0 px-2 sm:px-1.5 py-1 sm:py-0.5 rounded transition-colors flex items-center justify-center cursor-pointer ${
                      effectiveBoardSize >= 360
                        ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-xs'
                        : 'hover:text-slate-900 dark:hover:text-slate-100'
                    }`}
                    title="Large Board (380px)"
                  >
                    L
                  </button>
                </div>
              )}

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
        )}

        {/* Settings Panel Popover */}
        {showSettings && (
          <div className="p-3 bg-slate-50 dark:bg-slate-800/90 border-b border-slate-200 dark:border-slate-700/60 text-xs flex flex-col gap-3 shrink-0">
            <div className="flex items-center justify-between pb-1 border-b border-slate-200 dark:border-slate-700">
              <span className="font-bold text-slate-800 dark:text-slate-100">
                Board & Engine Settings
              </span>
              <button
                onClick={handleToggleSettings}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded cursor-pointer"
                title="Close settings"
                aria-label="Close settings"
              >
                <X size={14} />
              </button>
            </div>
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
                Move List Display
              </span>
              <label className="flex items-center gap-2 cursor-pointer select-none text-xs text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={showMoveListEvals}
                  onChange={handleToggleMoveListEvals}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-900"
                />
                <span>Show evaluations for each move</span>
              </label>
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

        {/* Chessboard Section with Top Player Bar and Evaluation Bar */}
        <div className="p-2 bg-slate-100 dark:bg-slate-950 flex flex-col items-center justify-center shrink-0">
          {/* Dual Evaluation Bar & Chessboard Layout:
              - Mobile Docked Split View: Vertical evaluation bar alongside the right of [Player Header + Chessboard], spanning their combined height.
              - Desktop Sidebar View: Player Header on top of Chessboard with Horizontal evaluation bar below. */}
          {isMobileDocked ? (
            /* Mobile Docked View: Row container with [Player Header + Chessboard] on Left and Vertical Eval Bar on Right */
            <div className="flex items-stretch justify-center gap-2 shrink-0">
              {/* Left Column: Player Header + Chessboard */}
              <div className="flex flex-col items-center gap-1.5 shrink-0">
                {playerInfoBar}

                {/* Chessground Board */}
                <div
                  style={{
                    width: `${effectiveBoardSize}px`,
                    height: `${effectiveBoardSize}px`,
                    ['--board-coord-size' as string]: `${coordSize}px`,
                  }}
                  onPointerDownCapture={() => {
                    clearBoardBounds();
                    dismissHighlight();
                  }}
                  onMouseDownCapture={clearBoardBounds}
                  onTouchStartCapture={() => {
                    clearBoardBounds();
                    dismissHighlight();
                  }}
                  onMouseEnter={clearBoardBounds}
                  className={`chessground-board-wrap relative board-theme-${boardTheme} ${
                    pieceTheme !== 'cburnett' ? `piece-theme-${pieceTheme}` : ''
                  }`}
                >
                  <div ref={boardElRef} className="w-full h-full" />

                  {/* High-contrast Square Highlight Overlay */}
                  {highlightedSquareCoord && (
                    <div
                      style={{
                        left: `${highlightedSquareCoord.col * 12.5}%`,
                        top: `${highlightedSquareCoord.row * 12.5}%`,
                        width: '12.5%',
                        height: '12.5%',
                      }}
                      className="chess-square-highlight absolute pointer-events-none"
                    >
                      <span className="absolute top-0.5 right-0.5 px-1 py-0.5 rounded bg-amber-500 text-slate-950 font-bold text-[9px] font-mono tracking-tight shadow-sm select-none leading-none border border-amber-300">
                        {highlightedSquareCoord.square}
                      </span>
                    </div>
                  )}

                  {/* Floating Move Classification Badge on Landing Square (only for moves that stand out) */}
                  {activeBadge && (
                    <div
                      style={{
                        left: `${activeBadge.col * 12.5 + 12.5}%`,
                        top: `${activeBadge.row * 12.5}%`,
                        width: `${badgeDiameter}px`,
                        height: `${badgeDiameter}px`,
                        transform: 'translate(-80%, -20%)',
                      }}
                      className={`absolute z-10 rounded-full flex items-center justify-center text-white shadow-md pointer-events-none select-none ${activeBadge.bgClass}`}
                      title={`${activeBadge.label}: ${currentPlyData.san}`}
                    >
                      <MoveBadgeGlyph
                        type={activeBadge.type}
                        style={{ width: `${glyphSize}px`, height: `${glyphSize}px` }}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Vertical Evaluation Bar alongside right of Board (height spans both Header and Board) */}
              <div
                style={{ width: '30px' }}
                className="self-stretch rounded-lg overflow-hidden border border-slate-300 dark:border-slate-700 relative flex flex-col select-none shadow-xs cursor-default bg-slate-900 dark:bg-slate-950 shrink-0"
                title={`Evaluation: ${evalBarData.text} (${evalBarData.source})`}
              >
                {orientation === 'white' ? (
                  <>
                    {/* Black section (top) */}
                    <div
                      style={{ height: `${100 - evalBarData.whitePercent}%` }}
                      className="w-full bg-slate-900 dark:bg-slate-950 transition-all duration-300 ease-out flex flex-col items-center justify-start shrink-0 overflow-hidden"
                    >
                      {!evalBarData.advantage.isWhite && !evalBarData.advantage.isEqual && (
                        <span className="pt-1.5 px-0.5 text-center font-mono font-bold text-[11px] text-white tracking-tight select-none leading-none">
                          {evalBarData.advantage.shortScore}
                        </span>
                      )}
                    </div>

                    {/* White section (bottom) */}
                    <div
                      style={{ height: `${evalBarData.whitePercent}%` }}
                      className={`w-full bg-slate-100 dark:bg-slate-200 ${
                        evalBarData.whitePercent > 0 && evalBarData.whitePercent < 100
                          ? 'border-t border-slate-400/80 dark:border-slate-500/80'
                          : ''
                      } transition-all duration-300 ease-out flex flex-col items-center justify-end shrink-0 overflow-hidden`}
                    >
                      {(evalBarData.advantage.isWhite || evalBarData.advantage.isEqual) && (
                        <span className="pb-1.5 px-0.5 text-center font-mono font-bold text-[11px] text-slate-900 tracking-tight select-none leading-none">
                          {evalBarData.advantage.shortScore}
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    {/* Orientation is black: White is top, Black is bottom */}
                    {/* White section (top) */}
                    <div
                      style={{ height: `${evalBarData.whitePercent}%` }}
                      className={`w-full bg-slate-100 dark:bg-slate-200 ${
                        evalBarData.whitePercent > 0 && evalBarData.whitePercent < 100
                          ? 'border-b border-slate-400/80 dark:border-slate-500/80'
                          : ''
                      } transition-all duration-300 ease-out flex flex-col items-center justify-start shrink-0 overflow-hidden`}
                    >
                      {(evalBarData.advantage.isWhite || evalBarData.advantage.isEqual) && (
                        <span className="pt-1.5 px-0.5 text-center font-mono font-bold text-[11px] text-slate-900 tracking-tight select-none leading-none">
                          {evalBarData.advantage.shortScore}
                        </span>
                      )}
                    </div>

                    {/* Black section (bottom) */}
                    <div
                      style={{ height: `${100 - evalBarData.whitePercent}%` }}
                      className="w-full bg-slate-900 dark:bg-slate-950 transition-all duration-300 ease-out flex flex-col items-center justify-end shrink-0 overflow-hidden"
                    >
                      {!evalBarData.advantage.isWhite && !evalBarData.advantage.isEqual && (
                        <span className="pb-1.5 px-0.5 text-center font-mono font-bold text-[11px] text-white tracking-tight select-none leading-none">
                          {evalBarData.advantage.shortScore}
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : (
            /* Desktop Sidebar View: Chessground Board with Horizontal Eval Bar below */
            <div className="flex flex-col items-center gap-1.5 shrink-0">
              {playerInfoBar}
              {/* Chessground Board */}
              <div
                style={{
                  width: `${effectiveBoardSize}px`,
                  height: `${effectiveBoardSize}px`,
                  ['--board-coord-size' as string]: `${coordSize}px`,
                }}
                onPointerDownCapture={() => {
                  clearBoardBounds();
                  dismissHighlight();
                }}
                onMouseDownCapture={clearBoardBounds}
                onTouchStartCapture={() => {
                  clearBoardBounds();
                  dismissHighlight();
                }}
                onMouseEnter={clearBoardBounds}
                className={`chessground-board-wrap relative board-theme-${boardTheme} ${
                  pieceTheme !== 'cburnett' ? `piece-theme-${pieceTheme}` : ''
                }`}
              >
                <div ref={boardElRef} className="w-full h-full" />

                {/* High-contrast Square Highlight Overlay */}
                {highlightedSquareCoord && (
                  <div
                    style={{
                      left: `${highlightedSquareCoord.col * 12.5}%`,
                      top: `${highlightedSquareCoord.row * 12.5}%`,
                      width: '12.5%',
                      height: '12.5%',
                    }}
                    className="chess-square-highlight absolute pointer-events-none"
                  >
                    <span className="absolute top-0.5 right-0.5 px-1 py-0.5 rounded bg-amber-500 text-slate-950 font-bold text-[9px] font-mono tracking-tight shadow-sm select-none leading-none border border-amber-300">
                      {highlightedSquareCoord.square}
                    </span>
                  </div>
                )}

                {/* Floating Move Classification Badge on Landing Square (only for moves that stand out) */}
                {activeBadge && (
                  <div
                    style={{
                      left: `${activeBadge.col * 12.5 + 12.5}%`,
                      top: `${activeBadge.row * 12.5}%`,
                      width: `${badgeDiameter}px`,
                      height: `${badgeDiameter}px`,
                      transform: 'translate(-80%, -20%)',
                    }}
                    className={`absolute z-10 rounded-full flex items-center justify-center text-white shadow-md pointer-events-none select-none ${activeBadge.bgClass}`}
                    title={`${activeBadge.label}: ${currentPlyData.san}`}
                  >
                    <MoveBadgeGlyph
                      type={activeBadge.type}
                      style={{ width: `${glyphSize}px`, height: `${glyphSize}px` }}
                    />
                  </div>
                )}
              </div>

              {/* Horizontal Evaluation Bar below Board */}
              <div
                style={{ width: `${effectiveBoardSize}px` }}
                className="h-7 rounded-lg overflow-hidden border border-slate-300 dark:border-slate-700 relative flex items-center select-none shadow-xs cursor-default bg-slate-900 shrink-0 mt-2"
                title={`Evaluation: ${evalBarData.text} (${evalBarData.source})`}
              >
                {/* White Initial [W| on Left */}
                <div className="flex items-center justify-center px-2.5 z-20 pointer-events-none shrink-0 bg-slate-100 dark:bg-slate-200 h-full border-r border-slate-400/80 dark:border-slate-500/80">
                  <span className="font-bold text-xs tracking-tight text-slate-800 dark:text-slate-900">
                    {whiteInitial}
                  </span>
                </div>

                {/* Evaluation Fill Bar (starts at left | and ends at right |) */}
                <div className="flex-1 h-full relative overflow-hidden flex items-center bg-slate-900 dark:bg-slate-950">
                  <div
                    style={{ width: `${evalBarData.whitePercent}%` }}
                    className={`h-full bg-slate-100 dark:bg-slate-200 ${
                      evalBarData.whitePercent > 0 && evalBarData.whitePercent < 100
                        ? 'border-r border-slate-400/80 dark:border-slate-500/80'
                        : ''
                    } transition-all duration-300 ease-out shrink-0`}
                  />
                  <div
                    style={{ width: `${100 - evalBarData.whitePercent}%` }}
                    className="h-full bg-slate-900 dark:bg-slate-950 transition-all duration-300 ease-out shrink-0"
                  />

                  {/* Dynamic Advantage Text & Score */}
                  <div className="absolute inset-0 flex items-center justify-between text-[11px] font-sans font-semibold pointer-events-none z-10">
                    {evalBarData.advantage.isEqual ? (
                      <span className="w-full text-center text-slate-700 dark:text-slate-300 font-medium">
                        Equal Position 0.0
                      </span>
                    ) : evalBarData.advantage.isWhite ? (
                      <>
                        <span className="text-slate-800 dark:text-slate-900 truncate max-w-[45%] pl-2">
                          {evalBarData.advantage.label}
                        </span>
                        <span
                          style={{
                            position: 'absolute',
                            right: `calc(${100 - evalBarData.whitePercent}% + 6px)`,
                          }}
                          className="text-slate-800 dark:text-slate-900 font-bold font-mono text-[11px]"
                        >
                          {evalBarData.advantage.shortScore}
                        </span>
                      </>
                    ) : (
                      <>
                        <span
                          style={{
                            position: 'absolute',
                            left: `calc(${evalBarData.whitePercent}% + 6px)`,
                          }}
                          className="text-white font-bold font-mono text-[11px]"
                        >
                          {evalBarData.advantage.shortScore}
                        </span>
                        <span className="text-slate-200 truncate max-w-[45%] ml-auto pr-2">
                          {evalBarData.advantage.label}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {/* Black Initial |B] on Right */}
                <div className="flex items-center justify-center px-2.5 z-20 pointer-events-none shrink-0 bg-slate-900 dark:bg-slate-950 h-full border-l border-slate-600/80 dark:border-slate-700/80">
                  <span className="font-bold text-xs tracking-tight text-slate-200">
                    {blackInitial}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Navigation Toolbar (Fixed-width Move Badge + Stable Navigation Buttons + Touch Swipe) */}
        <div
          onTouchStart={handleToolbarTouchStart}
          onTouchMove={handleToolbarTouchMove}
          onTouchEnd={handleToolbarTouchEnd}
          onTouchCancel={handleToolbarTouchEnd}
          onClickCapture={handleToolbarClickCapture}
          className="px-2 sm:px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-white dark:bg-slate-900 shrink-0 gap-1 select-none touch-pan-y"
        >
          {/* Left Group: Stepping controls + Fixed-width Current Move Played badge */}
          <div className="flex items-center gap-0.5 sm:gap-1 min-w-0">
            <button
              onClick={handleFirst}
              disabled={safePly === 0 && !isFreePlay}
              title="First Move (Up Arrow)"
              className="min-h-[36px] w-[32px] sm:w-auto sm:min-h-0 sm:min-w-0 p-1.5 sm:p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent text-slate-600 dark:text-slate-300 transition-colors cursor-pointer disabled:cursor-default flex items-center justify-center shrink-0"
            >
              <ChevronsLeft size={16} className="sm:w-[15px] sm:h-[15px]" />
            </button>

            <button
              onClick={handlePrevCritical}
              disabled={prevCriticalPly === null}
              title={prevCriticalTooltip}
              aria-label="Previous Critical Moment"
              className="min-h-[36px] w-[32px] sm:w-auto sm:min-h-0 sm:min-w-0 p-1.5 sm:p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent text-slate-600 dark:text-slate-300 transition-colors inline-flex items-center justify-center cursor-pointer disabled:cursor-default shrink-0"
            >
              <ChevronLeft size={13} className="-mr-0.5 sm:w-[12px] sm:h-[12px]" />
              <span className="font-extrabold text-xs sm:text-[11px] font-mono leading-none select-none">
                !
              </span>
            </button>

            <button
              onClick={handlePrev}
              disabled={safePly === 0 && !isFreePlay}
              title="Previous Move (Left Arrow)"
              className="min-h-[36px] w-[32px] sm:w-auto sm:min-h-0 sm:min-w-0 p-1.5 sm:p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent text-slate-600 dark:text-slate-300 transition-colors cursor-pointer disabled:cursor-default flex items-center justify-center shrink-0"
            >
              <ChevronLeft size={16} className="sm:w-[15px] sm:h-[15px]" />
            </button>

            {/* Current Move Played Badge (Fixed width to prevent navigation buttons from shifting) */}
            <button
              type="button"
              onClick={() => {
                if (isMobileDocked) {
                  setIsMobileCoachOpen(prev => !prev);
                } else {
                  setActiveSidebarTab(t => (t === 'coach' ? 'moves' : 'coach'));
                }
              }}
              className={`relative min-h-[34px] sm:min-h-0 w-[80px] sm:w-[94px] px-1 py-1 sm:py-0.5 rounded-md text-xs font-mono font-bold transition-colors cursor-pointer flex items-center justify-center text-center select-none shrink-0 ${
                currentPlyData?.criticalMoment
                  ? 'bg-amber-100 hover:bg-amber-200 text-amber-900 dark:bg-amber-950/70 dark:text-amber-200 border border-amber-300 dark:border-amber-700 shadow-xs'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700'
              }`}
              title={
                currentPlyData?.criticalMoment
                  ? `${currentPlyData.criticalMoment.classification}: Click to toggle Coach explanation`
                  : 'Click to toggle Coach move breakdown'
              }
              aria-label={
                currentPlyData?.criticalMoment
                  ? `Current move ${currentPlyData.san}, ${currentPlyData.criticalMoment.classification}`
                  : `Current move ${currentPlyData?.san || 'Start'}`
              }
            >
              <span className="truncate w-full text-center">
                {isFreePlay
                  ? currentVarIndex >= 0 && variationPlies[currentVarIndex]
                    ? `${variationPlies[currentVarIndex].moveNumber}.${variationPlies[currentVarIndex].color === 'b' ? '..' : ''} ${variationPlies[currentVarIndex].san}`
                    : 'Var'
                  : safePly > 0
                    ? `${currentPlyData.moveNumber}.${currentPlyData.color === 'b' ? '..' : ''} ${currentPlyData.san}`
                    : 'Start'}
              </span>
              {currentPlyData?.criticalMoment && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-500 ring-2 ring-white dark:ring-slate-900 animate-pulse pointer-events-none" />
              )}
            </button>

            <button
              onClick={handleNext}
              disabled={safePly >= plies.length - 1 && !isFreePlay}
              title="Next Move (Right Arrow)"
              className="min-h-[36px] w-[32px] sm:w-auto sm:min-h-0 sm:min-w-0 p-1.5 sm:p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent text-slate-600 dark:text-slate-300 transition-colors cursor-pointer disabled:cursor-default flex items-center justify-center shrink-0"
            >
              <ChevronRight size={16} className="sm:w-[15px] sm:h-[15px]" />
            </button>

            {/* Next Critical Moment button */}
            <button
              onClick={handleNextCritical}
              disabled={nextCriticalPly === null}
              title={nextCriticalTooltip}
              aria-label="Next Critical Moment"
              className="min-h-[36px] w-[32px] sm:w-auto sm:min-h-0 sm:min-w-0 p-1.5 sm:p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent text-slate-600 dark:text-slate-300 transition-colors inline-flex items-center justify-center cursor-pointer disabled:cursor-default shrink-0"
            >
              <span className="font-extrabold text-xs sm:text-[11px] font-mono leading-none select-none">
                !
              </span>
              <ChevronRight size={13} className="-ml-0.5 sm:w-[12px] sm:h-[12px]" />
            </button>

            <button
              onClick={handleLast}
              disabled={safePly >= plies.length - 1 && !isFreePlay}
              title="Last Move (Down Arrow)"
              className="min-h-[36px] w-[32px] sm:w-auto sm:min-h-0 sm:min-w-0 p-1.5 sm:p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent text-slate-600 dark:text-slate-300 transition-colors cursor-pointer disabled:cursor-default flex items-center justify-center shrink-0"
            >
              <ChevronsRight size={16} className="sm:w-[15px] sm:h-[15px]" />
            </button>

            {/* Desktop Autoplay */}
            <button
              onClick={() => setIsAutoplaying(p => !p)}
              title={isAutoplaying ? 'Pause Autoplay (Space)' : 'Autoplay Game (Space)'}
              className={`hidden sm:flex min-h-[36px] min-w-[32px] sm:min-h-0 sm:min-w-0 p-1.5 sm:p-1 rounded transition-colors cursor-pointer items-center justify-center shrink-0 ${
                isAutoplaying
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
            >
              {isAutoplaying ? <Pause size={15} /> : <Play size={15} />}
            </button>

            {/* Quick Zoom In / Out on desktop */}
            <div className="hidden sm:flex items-center gap-0.5 border-l border-slate-200 dark:border-slate-800 pl-1 ml-0.5 text-slate-500">
              <button
                onClick={() => handlePresetBoardSize(Math.max(180, effectiveBoardSize - 35))}
                title="Make chessboard smaller"
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
                title="Fit board to width"
                className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 transition-colors"
              >
                <Maximize2 size={12} />
              </button>
            </div>
          </div>

          {/* Right Group: Flip, Evaluation Chart, and AI Coach (AI Coach hidden on mobile since clicking the move badge opens it) */}
          <div className="flex items-center gap-1 shrink-0">
            {isFreePlay && shouldHideHeader && (
              <button
                onClick={handleResetToMainline}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-slate-700 hover:bg-slate-800 dark:bg-slate-600 dark:hover:bg-slate-500 text-white transition-colors cursor-pointer shadow-xs shrink-0"
                title="Return to Game Mainline"
              >
                <RotateCcw size={12} />
                <span className="hidden sm:inline">Mainline</span>
              </button>
            )}

            {/* AI Coach Button (only shown on desktop sm:flex; on mobile, clicking the move badge opens it) */}
            {!isMobileDocked && (
              <button
                onClick={() => {
                  setActiveSidebarTab(t => (t === 'coach' ? 'moves' : 'coach'));
                }}
                title={
                  currentPlyData?.criticalMoment
                    ? `Coach: ${currentPlyData.criticalMoment.classification}`
                    : safePly > 0
                      ? `Ask Coach about ${currentPlyData.moveNumber}.${currentPlyData.san}`
                      : 'Ask Coach'
                }
                className={`hidden sm:flex min-h-[36px] min-w-[36px] sm:min-h-0 sm:min-w-0 p-1.5 rounded transition-colors cursor-pointer relative items-center justify-center shrink-0 ${
                  activeSidebarTab === 'coach'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
                aria-label="Toggle AI Coach breakdown"
              >
                <Sparkles size={16} className="sm:w-[15px] sm:h-[15px]" />
                {currentPlyData?.criticalMoment && (
                  <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                )}
              </button>
            )}

            {/* Flip Board Icon */}
            <button
              onClick={handleFlip}
              title="Flip Board Orientation (F)"
              className="min-h-[36px] min-w-[36px] sm:min-h-0 sm:min-w-0 p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors cursor-pointer flex items-center justify-center shrink-0"
              aria-label="Flip board orientation"
            >
              <RotateCcw size={16} />
            </button>

            {/* Evaluation Graph Icon */}
            <button
              onClick={handleToggleEvalChart}
              title={showEvalChart ? 'Hide Evaluation Chart' : 'Show Evaluation Chart'}
              className={`min-h-[36px] min-w-[36px] sm:min-h-0 sm:min-w-0 p-1.5 rounded transition-colors cursor-pointer flex items-center justify-center shrink-0 ${
                showEvalChart
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
              aria-label="Toggle evaluation chart"
            >
              <Activity size={16} />
            </button>

            {userShapes.length > 0 && (
              <button
                onClick={handleClearShapes}
                title="Clear Drawn Arrows & Circles"
                className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-rose-600 transition-colors cursor-pointer flex items-center justify-center shrink-0"
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
        </div>

        {/* Mobile Coach Drawer (when opened on mobile docked split view) */}
        {isMobileDocked && isMobileCoachOpen && (
          <div className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 p-3 flex flex-col gap-2 max-h-60 overflow-y-auto shrink-0 select-text animate-in fade-in slide-in-from-top-1 duration-150 shadow-inner">
            {/* Header: Move + Classification + Close */}
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 pb-2">
              <div className="flex items-center gap-2 min-w-0 flex-wrap">
                <span className="flex items-center gap-1 font-bold text-xs text-slate-900 dark:text-slate-100">
                  <Sparkles size={14} className="text-amber-500 shrink-0" />
                  <span>
                    {safePly > 0
                      ? `${currentPlyData.moveNumber}.${currentPlyData.color === 'b' ? '..' : ''} ${currentPlyData.san}`
                      : 'Starting Position'}
                  </span>
                  {safePly > 0 && (
                    <span className="text-slate-400 font-normal text-[11px]">
                      ({currentPlyData.color === 'w' ? 'White' : 'Black'})
                    </span>
                  )}
                </span>
                {currentPlyData?.criticalMoment && (
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded text-white ${activeBadge?.bgClass ?? 'bg-amber-600'}`}
                  >
                    {currentPlyData.criticalMoment.classification}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setIsMobileCoachOpen(false)}
                className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
                title="Close Coach breakdown"
                aria-label="Close Coach breakdown"
              >
                <X size={15} />
              </button>
            </div>

            {/* Engine Alternative Line (Clickable to load on board) */}
            {currentPlyData?.criticalMoment?.best_move_san &&
              currentPlyData.criticalMoment.best_move_san !== currentPlyData.san && (
                <div className="flex items-center gap-2 p-1.5 rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs">
                  <span className="text-emerald-800 dark:text-emerald-200 font-medium shrink-0">
                    Engine recommends:
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        currentPlyData.criticalMoment?.pv_san &&
                        currentPlyData.criticalMoment.pv_san.length > 0
                      ) {
                        startVariation(safePly - 1, currentPlyData.criticalMoment.pv_san);
                        setIsMobileCoachOpen(false);
                      }
                    }}
                    className="font-mono font-bold text-emerald-700 dark:text-emerald-300 bg-white dark:bg-slate-900 px-2 py-0.5 rounded border border-emerald-300 dark:border-emerald-700 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 transition-colors cursor-pointer"
                    title="Load recommended engine variation on chessboard"
                  >
                    {currentPlyData.criticalMoment.best_move_san} ➔
                  </button>
                </div>
              )}

            {/* Tags & Time */}
            <div className="flex items-center justify-between gap-2 flex-wrap text-[11px] text-slate-500 dark:text-slate-400 font-mono">
              <span>
                ⏱️ Spent:{' '}
                {currentPlyData?.timeSpentSeconds !== undefined &&
                currentPlyData?.timeSpentSeconds !== null
                  ? `${currentPlyData.timeSpentSeconds}s`
                  : '—'}
              </span>
              {currentPlyData?.criticalMoment?.tags &&
                currentPlyData.criticalMoment.tags.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap">
                    {sortTagsNegativeFirst(currentPlyData.criticalMoment.tags).map(t => (
                      <TagCapsule key={t} tag={t} size="sm" />
                    ))}
                  </div>
                )}
            </div>

            {/* Deterministic Move Breakdown from payload.json */}
            <div
              className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed overflow-x-auto pt-1 border-t border-slate-200/60 dark:border-slate-800/60"
              onClick={handleCoachAnswerClick}
              dangerouslySetInnerHTML={{ __html: moveExplanationHtml }}
            />
          </div>
        )}

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

        {/* Draggable Vertical Splitter Bar between Board Controls and Move List (hidden in mobile docked split mode) */}
        {!isMobileDocked && (
          <>
            <div
              onMouseDown={handleBoardSplitterStart}
              onTouchStart={handleBoardSplitterTouchStart}
              onDoubleClick={() => handlePresetBoardSize(300)}
              className="h-2.5 w-full cursor-row-resize bg-slate-100 dark:bg-slate-800 hover:bg-blue-500/20 active:bg-blue-500/40 border-y border-slate-200 dark:border-slate-800 transition-colors flex items-center justify-center group select-none shrink-0"
              title="Drag up or down to resize chessboard and gain more move list space (Double-click to reset)"
            >
              <div className="w-10 h-0.5 rounded-full bg-slate-300 dark:bg-slate-600 group-hover:bg-blue-500 group-active:bg-blue-600 transition-colors" />
            </div>

            {activeSidebarTab === 'moves' ? (
              /* Move Timeline List (Header removed to maximize vertical space) */
              <div
                className="flex-1 overflow-y-auto min-h-0 bg-white dark:bg-slate-900"
                ref={moveListRef}
              >
                <div className="p-1.5 text-xs">
                  <table className="w-full text-xs">
                    <tbody>
                      {/* Branch variation at starting position (before move 1) */}
                      {isFreePlay && branchPly === 0 && variationPlies.length > 0 && (
                        <tr className="bg-slate-50/50 dark:bg-slate-800/30 border-b border-slate-200 dark:border-slate-800">
                          <td colSpan={3} className="py-1 px-1.5">
                            <div className="flex flex-wrap items-center gap-1 text-[11px] font-mono leading-relaxed ml-8 pl-2.5 border-l-2 border-slate-300 dark:border-slate-700">
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
                                    className={`px-1.5 py-0.5 rounded transition-colors cursor-pointer focus:outline-none focus:ring-0 ${
                                      isActive
                                        ? 'bg-slate-700 text-white dark:bg-slate-200 dark:text-slate-900 font-bold shadow-xs'
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

                      {movePairs.map(pair => {
                        const whiteActive = pair.white && safePly === pair.white.ply && !isFreePlay;
                        const blackActive = pair.black && safePly === pair.black.ply && !isFreePlay;

                        const whiteBadge = pair.white
                          ? getClassificationBadge(pair.white.criticalMoment?.classification)
                          : null;
                        const blackBadge = pair.black
                          ? getClassificationBadge(pair.black.criticalMoment?.classification)
                          : null;

                        const whiteEval = pair.white
                          ? formatPlyEval(gamePlyEvals[pair.white.ply])
                          : null;
                        const blackEval = pair.black
                          ? formatPlyEval(gamePlyEvals[pair.black.ply])
                          : null;

                        const whiteEngineVar = pair.white
                          ? engineVariationsByPly.get(pair.white.ply)
                          : undefined;
                        const blackEngineVar = pair.black
                          ? engineVariationsByPly.get(pair.black.ply)
                          : undefined;

                        const pairVariations: Array<{
                          id: string;
                          branchPly: number;
                          moves: VariationPly[];
                        }> = [];

                        // White engine suggestion preloaded
                        if (whiteEngineVar && whiteEngineVar.length > 0) {
                          pairVariations.push({
                            id: `w-engine-${pair.moveNumber}`,
                            branchPly: pair.white!.ply - 1,
                            moves: whiteEngineVar,
                          });
                        }

                        // White user exploration
                        if (
                          pair.white &&
                          isFreePlay &&
                          branchPly === pair.white.ply - 1 &&
                          variationPlies.length > 0
                        ) {
                          const isDup =
                            whiteEngineVar &&
                            whiteEngineVar.length === variationPlies.length &&
                            whiteEngineVar.every((m, idx) => m.san === variationPlies[idx].san);
                          if (!isDup) {
                            pairVariations.push({
                              id: `w-user-${pair.moveNumber}`,
                              branchPly: pair.white.ply - 1,
                              moves: variationPlies,
                            });
                          }
                        }

                        // Black engine suggestion preloaded
                        if (blackEngineVar && blackEngineVar.length > 0) {
                          pairVariations.push({
                            id: `b-engine-${pair.moveNumber}`,
                            branchPly: pair.black!.ply - 1,
                            moves: blackEngineVar,
                          });
                        }

                        // Black user exploration
                        if (
                          pair.black &&
                          isFreePlay &&
                          branchPly === pair.black.ply - 1 &&
                          variationPlies.length > 0
                        ) {
                          const isDup =
                            blackEngineVar &&
                            blackEngineVar.length === variationPlies.length &&
                            blackEngineVar.every((m, idx) => m.san === variationPlies[idx].san);
                          if (!isDup) {
                            pairVariations.push({
                              id: `b-user-${pair.moveNumber}`,
                              branchPly: pair.black.ply - 1,
                              moves: variationPlies,
                            });
                          }
                        }

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
                                    className={`w-full text-left px-2 py-1 rounded font-mono transition-colors flex items-center justify-between gap-1 cursor-pointer focus:outline-none focus:ring-0 focus-visible:outline-none ${
                                      whiteActive
                                        ? 'bg-blue-600 text-white font-bold shadow-xs'
                                        : 'hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200'
                                    }`}
                                  >
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      <span
                                        className={`truncate ${
                                          whiteActive
                                            ? 'text-white font-bold'
                                            : whiteBadge
                                              ? getClassificationTextColor(whiteBadge.type)
                                              : 'text-slate-800 dark:text-slate-200'
                                        }`}
                                      >
                                        {pair.white.san}
                                      </span>
                                      {whiteBadge && (
                                        <span
                                          className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-white shrink-0 ${whiteBadge.bgClass}`}
                                          title={whiteBadge.label}
                                        >
                                          <MoveBadgeGlyph
                                            type={whiteBadge.type}
                                            className="w-3 h-3"
                                          />
                                        </span>
                                      )}
                                    </div>
                                    {showMoveListEvals && whiteEval && (
                                      <span
                                        className={`text-[9.5px] font-mono shrink-0 select-none ${
                                          whiteActive
                                            ? 'text-white/80'
                                            : 'text-slate-400 dark:text-slate-500'
                                        }`}
                                      >
                                        {whiteEval}
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
                                    className={`w-full text-left px-2 py-1 rounded font-mono transition-colors flex items-center justify-between gap-1 cursor-pointer focus:outline-none focus:ring-0 focus-visible:outline-none ${
                                      blackActive
                                        ? 'bg-blue-600 text-white font-bold shadow-xs'
                                        : 'hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200'
                                    }`}
                                  >
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      <span
                                        className={`truncate ${
                                          blackActive
                                            ? 'text-white font-bold'
                                            : blackBadge
                                              ? getClassificationTextColor(blackBadge.type)
                                              : 'text-slate-800 dark:text-slate-200'
                                        }`}
                                      >
                                        {pair.black.san}
                                      </span>
                                      {blackBadge && (
                                        <span
                                          className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-white shrink-0 ${blackBadge.bgClass}`}
                                          title={blackBadge.label}
                                        >
                                          <MoveBadgeGlyph
                                            type={blackBadge.type}
                                            className="w-3 h-3"
                                          />
                                        </span>
                                      )}
                                    </div>
                                    {showMoveListEvals && blackEval && (
                                      <span
                                        className={`text-[9.5px] font-mono shrink-0 select-none ${
                                          blackActive
                                            ? 'text-white/80'
                                            : 'text-slate-400 dark:text-slate-500'
                                        }`}
                                      >
                                        {blackEval}
                                      </span>
                                    )}
                                  </button>
                                )}
                              </td>
                            </tr>

                            {/* Indented Variations underneath move pair */}
                            {pairVariations.length > 0 && (
                              <tr className="bg-slate-50/50 dark:bg-slate-800/30 border-b border-slate-100 dark:border-slate-800/40">
                                <td colSpan={3} className="py-1 px-1.5">
                                  <div className="ml-8 pl-2.5 border-l-2 border-slate-300 dark:border-slate-700 flex flex-col gap-1 text-[11px] font-mono leading-relaxed">
                                    {pairVariations.map(variation => (
                                      <div
                                        key={variation.id}
                                        className="flex flex-wrap items-center gap-1"
                                      >
                                        {variation.moves.map((vm, vIdx) => {
                                          const isMoveActive =
                                            isFreePlay &&
                                            branchPly === variation.branchPly &&
                                            activeFen === vm.fen;

                                          const subVars = subVariations.filter(
                                            sv =>
                                              sv.parentFen === vm.fen || sv.branchPlyIndex === vIdx,
                                          );

                                          return (
                                            <Fragment key={vIdx}>
                                              <button
                                                onClick={e => {
                                                  e.currentTarget.blur();
                                                  handleSelectVariationMove(
                                                    variation.branchPly,
                                                    variation.moves,
                                                    vIdx,
                                                  );
                                                }}
                                                className={`px-1 py-0.5 rounded transition-colors cursor-pointer focus:outline-none focus:ring-0 ${
                                                  isMoveActive
                                                    ? 'bg-slate-700 text-white dark:bg-slate-200 dark:text-slate-900 font-bold shadow-xs'
                                                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                                                }`}
                                                title={`Go to ${vm.san}`}
                                              >
                                                {vm.color === 'w'
                                                  ? `${vm.moveNumber}. `
                                                  : vIdx === 0
                                                    ? `${vm.moveNumber}... `
                                                    : ''}
                                                {vm.san}
                                              </button>

                                              {/* Render nested sub-variations in parentheses */}
                                              {subVars.map((sv, sIdx) => (
                                                <span
                                                  key={sIdx}
                                                  className="text-slate-500 dark:text-slate-400 font-sans inline-flex items-center gap-0.5 text-[10.5px]"
                                                >
                                                  <span>(</span>
                                                  {sv.moves.map((svm, svIdx) => {
                                                    const isSubActive =
                                                      isFreePlay && activeFen === svm.fen;
                                                    return (
                                                      <button
                                                        key={svIdx}
                                                        onClick={e => {
                                                          e.currentTarget.blur();
                                                          handleSelectVariationMove(
                                                            variation.branchPly,
                                                            sv.moves,
                                                            svIdx,
                                                          );
                                                        }}
                                                        className={`px-1 py-0.2 rounded transition-colors cursor-pointer font-mono ${
                                                          isSubActive
                                                            ? 'bg-slate-700 text-white dark:bg-slate-200 dark:text-slate-900 font-bold'
                                                            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                                                        }`}
                                                      >
                                                        {svm.color === 'w'
                                                          ? `${svm.moveNumber}. `
                                                          : svIdx === 0
                                                            ? `${svm.moveNumber}... `
                                                            : ''}
                                                        {svm.san}
                                                      </button>
                                                    );
                                                  })}
                                                  <span>)</span>
                                                </span>
                                              ))}
                                            </Fragment>
                                          );
                                        })}
                                      </div>
                                    ))}
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
            ) : (
              <div className="flex-1 overflow-y-auto min-h-0 bg-white dark:bg-slate-900 flex flex-col text-xs">
                {/* Context Header */}
                {/* Context Header */}
                <div className="p-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40 shrink-0">
                  {/* Line 1: Analyzing move & return to moves button */}
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                      <span className="text-slate-500 font-normal">Analyzing:</span>
                      <span className="font-mono bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded border border-blue-200 dark:border-blue-800 font-bold">
                        {safePly > 0
                          ? `${currentPlyData.moveNumber}.${currentPlyData.color === 'b' ? '..' : ''} ${currentPlyData.san}`
                          : 'Starting Position'}
                      </span>
                      {safePly > 0 && (
                        <span className="text-slate-400 text-[11px]">
                          ({currentPlyData.color === 'w' ? 'White' : 'Black'})
                        </span>
                      )}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {currentPlyData.criticalMoment && (
                        <span
                          className={`text-[10px] font-bold px-1.5 py-0.5 rounded text-white ${activeBadge?.bgClass ?? 'bg-amber-600'}`}
                        >
                          {currentPlyData.criticalMoment.classification}
                        </span>
                      )}
                      <button
                        onClick={() => setActiveSidebarTab('moves')}
                        title="Switch back to move list"
                        className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                      >
                        <List size={13} />
                      </button>
                    </div>
                  </div>

                  {/* Line 2: Spent & Clock on left, Tags on right */}
                  <div className="mt-1.5 flex items-center justify-between gap-2 flex-wrap">
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1.5 font-mono">
                      <span>
                        ⏱️ Spent:{' '}
                        {currentPlyData.timeSpentSeconds !== undefined &&
                        currentPlyData.timeSpentSeconds !== null
                          ? `${currentPlyData.timeSpentSeconds}s`
                          : '—'}
                      </span>
                      {currentPlyData.clockSecondsRemaining !== undefined &&
                        currentPlyData.clockSecondsRemaining !== null && (
                          <span className="text-slate-400 dark:text-slate-500">
                            · Clock: {formatSecondsToClock(currentPlyData.clockSecondsRemaining)}
                          </span>
                        )}
                    </div>
                    {currentPlyData.criticalMoment?.tags &&
                      currentPlyData.criticalMoment.tags.length > 0 && (
                        <div className="flex items-center gap-1 flex-wrap justify-end">
                          {sortTagsNegativeFirst(currentPlyData.criticalMoment.tags).map(t => (
                            <TagCapsule key={t} tag={t} size="sm" />
                          ))}
                        </div>
                      )}
                  </div>

                  {/* Line 3: Engine alternative beneath Line 2 */}
                  {currentPlyData.criticalMoment?.best_move_san &&
                    currentPlyData.criticalMoment.best_move_san !== currentPlyData.san &&
                    !currentPlyData.san.includes('#') &&
                    !currentPlyData.criticalMoment.classification
                      ?.toLowerCase()
                      .includes('checkmate') &&
                    [
                      'blunder',
                      'mistake',
                      'inaccuracy',
                      'missed win',
                      'missed tactic',
                      'miss',
                    ].some(cls =>
                      currentPlyData.criticalMoment?.classification?.toLowerCase().includes(cls),
                    ) && (
                      <div className="mt-1.5 text-[11px] text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
                        <span>Engine alternative:</span>
                        <button
                          type="button"
                          onClick={() => {
                            if (
                              currentPlyData.criticalMoment?.pv_san &&
                              currentPlyData.criticalMoment.pv_san.length > 0
                            ) {
                              startVariation(safePly - 1, currentPlyData.criticalMoment.pv_san);
                            }
                          }}
                          title="Click to load engine alternative line on board"
                          className="font-mono font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 px-1.5 py-0.5 rounded border border-emerald-300 dark:border-emerald-800 transition-colors cursor-pointer"
                        >
                          {currentPlyData.criticalMoment.best_move_san}
                        </button>
                      </div>
                    )}
                </div>

                {/* Deterministic Tactical Explanation (Always visible before Ask Coach) */}
                <div className="p-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400 mb-2 flex items-center gap-1.5">
                    <Sparkles size={12} />
                    <span>Move Breakdown</span>
                  </div>
                  <div
                    className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed overflow-x-auto"
                    onClick={handleCoachAnswerClick}
                    dangerouslySetInnerHTML={{ __html: moveExplanationHtml }}
                  />
                </div>

                {/* Custom Question Input Form */}
                <form
                  onSubmit={e => {
                    e.preventDefault();
                    void handleAskCoach();
                  }}
                  className="p-2.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-900/30 flex flex-col gap-2 shrink-0"
                >
                  <textarea
                    value={userQuestion}
                    onChange={e => setUserQuestion(e.target.value)}
                    placeholder={`Ask Coach anything about ${safePly > 0 ? `${currentPlyData.moveNumber}.${currentPlyData.san}` : 'this position'}...`}
                    rows={2}
                    className="w-full text-xs p-2 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void handleAskCoach();
                      }
                    }}
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-slate-400">Press Enter to ask</span>
                    <button
                      type="submit"
                      disabled={isAskingCoach || !userQuestion.trim()}
                      className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                    >
                      {isAskingCoach ? (
                        <>
                          <svg
                            className="animate-spin h-3 w-3 text-white"
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
                          <span>Analyzing...</span>
                        </>
                      ) : (
                        <>
                          <Send size={12} />
                          <span>Ask Coach</span>
                        </>
                      )}
                    </button>
                  </div>
                </form>

                {/* Answer Display */}
                <div className="p-3 flex-1">
                  {isAskingCoach && (
                    <div className="p-6 flex flex-col items-center justify-center gap-2 text-slate-500 text-xs">
                      <svg
                        className="animate-spin h-5 w-5 text-blue-600"
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
                      <span>Consulting coach and calculating tactical facts…</span>
                    </div>
                  )}

                  {coachError && (
                    <div className="p-3 rounded-md bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-700 dark:text-rose-300 text-xs">
                      <p className="font-semibold mb-1">Could not get coaching answer</p>
                      <p>{coachError}</p>
                    </div>
                  )}

                  {activeCoachAnswer && !isAskingCoach && (
                    <div className="flex flex-col gap-3">
                      {/* Formal Question Title */}
                      <div className="bg-slate-50 dark:bg-slate-800/60 p-2.5 rounded-md border border-slate-200 dark:border-slate-700">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400 mb-1">
                          Coaching Question
                        </div>
                        <div className="font-semibold text-slate-900 dark:text-slate-100 text-xs leading-snug">
                          {activeCoachAnswer.formal_question}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-1">
                          {activeCoachAnswer.move_context}
                        </div>
                      </div>

                      {/* Formatted Answer with Interactive Clickable Moves */}
                      <div
                        className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed overflow-x-auto"
                        onClick={handleCoachAnswerClick}
                        dangerouslySetInnerHTML={{ __html: coachAnswerHtml }}
                      />

                      {/* Add to Review Action */}
                      <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 flex-wrap">
                        {appendedSuccess ? (
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-semibold text-xs">
                              <Check size={14} />
                              <span>Added to Game Review!</span>
                            </span>
                            {onScrollToSection && (
                              <button
                                onClick={() => onScrollToSection('Follow-up Coaching & Deep Dives')}
                                className="text-xs text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1 cursor-pointer"
                              >
                                <span>View in Review</span>
                                <ExternalLink size={11} />
                              </button>
                            )}
                          </div>
                        ) : (
                          <button
                            onClick={handleAppendQA}
                            disabled={isAppendingQA}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-medium transition-colors cursor-pointer shadow-xs"
                            title="Append this Q&A into the official game review document"
                          >
                            {isAppendingQA ? (
                              <>
                                <svg
                                  className="animate-spin h-3 w-3 text-white"
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
                                <span>Updating Review...</span>
                              </>
                            ) : (
                              <>
                                <Plus size={13} />
                                <span>Add to Review</span>
                              </>
                            )}
                          </button>
                        )}

                        <button
                          onClick={() => {
                            setCoachAnswer(null);
                            setUserQuestion('');
                            setAppendedSuccess(false);
                          }}
                          className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 underline cursor-pointer"
                        >
                          Ask another
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  },
);
