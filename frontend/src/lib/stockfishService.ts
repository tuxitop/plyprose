import { Chess } from 'chess.js';

export interface EngineLine {
  multipv: number;
  depth: number;
  scoreCp: number | null;
  scoreMate: number | null;
  formattedScore: string;
  pvUci: string[];
  pvSan: string[];
  from?: string;
  to?: string;
  fen?: string;
}

export interface EngineSettings {
  multiPv: number; // default 2
  maxDepth: number; // default 18
}

type UpdateListener = (lines: EngineLine[]) => void;

export class StockfishService {
  private worker: Worker | null = null;
  private isReady = false;
  private currentFen = '';
  private listeners: Set<UpdateListener> = new Set();
  private linesMap: Map<number, EngineLine> = new Map();
  private settings: EngineSettings = {
    multiPv: 2,
    maxDepth: 18,
  };

  constructor(settings?: Partial<EngineSettings>) {
    if (settings) {
      this.settings = { ...this.settings, ...settings };
    }
  }

  public updateSettings(settings: Partial<EngineSettings>) {
    this.settings = { ...this.settings, ...settings };
    if (this.worker && this.isReady) {
      this.worker.postMessage(`setoption name MultiPV value ${this.settings.multiPv}`);
      if (this.currentFen) {
        this.evaluate(this.currentFen);
      }
    }
  }

  public init(): Promise<void> {
    if (this.worker) return Promise.resolve();

    return new Promise(resolve => {
      try {
        this.worker = new Worker('/stockfish/stockfish-19-lite-single.js');
        this.worker.onmessage = (event: MessageEvent<string>) => {
          this.handleWorkerMessage(event.data, resolve);
        };

        // Initialize UCI
        this.worker.postMessage('uci');
        this.worker.postMessage(`setoption name MultiPV value ${this.settings.multiPv}`);
        this.worker.postMessage('isready');
      } catch (err) {
        console.error('Failed to instantiate Stockfish 19 Web Worker', err);
        resolve();
      }
    });
  }

  private handleWorkerMessage(message: string, onReady?: () => void) {
    if (typeof message !== 'string') return;

    if (message === 'readyok' || message === 'uciok') {
      this.isReady = true;
      if (onReady) onReady();
      return;
    }

    // Example UCI info line:
    // "info depth 14 seldepth 19 multipv 1 score cp 45 nodes 12345 nps 600000 time 20 pv e2e4 e7e5 g1f3"
    if (message.startsWith('info ') && message.includes(' pv ')) {
      this.parseInfoLine(message);
    }
  }

  private parseInfoLine(line: string) {
    if (!this.currentFen) return;

    const depthMatch = line.match(/\bdepth (\d+)/);
    const multipvMatch = line.match(/\bmultipv (\d+)/);
    const scoreCpMatch = line.match(/\bscore cp (-?\d+)/);
    const scoreMateMatch = line.match(/\bscore mate (-?\d+)/);
    const pvIndex = line.indexOf(' pv ');

    if (pvIndex === -1) return;

    const depth = depthMatch ? parseInt(depthMatch[1], 10) : 0;
    const multipv = multipvMatch ? parseInt(multipvMatch[1], 10) : 1;
    const rawCp = scoreCpMatch ? parseInt(scoreCpMatch[1], 10) : null;
    const scoreMate = scoreMateMatch ? parseInt(scoreMateMatch[1], 10) : null;

    // Perspective conversion: in UCI, score is from side-to-move's perspective
    // In UI, standard is White-centric (+ for White advantage, - for Black)
    const isWhiteTurn = this.currentFen.split(' ')[1] === 'w';
    let formattedScore = '0.00';
    let scoreCp = rawCp;

    if (scoreMate !== null) {
      const mateFromWhite = isWhiteTurn ? scoreMate : -scoreMate;
      formattedScore = mateFromWhite > 0 ? `+M${mateFromWhite}` : `-M${Math.abs(mateFromWhite)}`;
    } else if (rawCp !== null) {
      const cpFromWhite = isWhiteTurn ? rawCp : -rawCp;
      scoreCp = cpFromWhite;
      const pawnVal = (cpFromWhite / 100).toFixed(2);
      formattedScore = cpFromWhite > 0 ? `+${pawnVal}` : pawnVal;
    }

    const rawMoves = line
      .substring(pvIndex + 4)
      .trim()
      .split(/\s+/);
    const pvUci = rawMoves.slice(0, 10); // top 10 continuation moves

    // Convert UCI to SAN using chess.js
    const pvSan: string[] = [];
    let from: string | undefined;
    let to: string | undefined;

    try {
      const c = new Chess(this.currentFen);
      for (let i = 0; i < pvUci.length; i++) {
        const uci = pvUci[i];
        const uFrom = uci.slice(0, 2);
        const uTo = uci.slice(2, 4);
        const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;

        if (i === 0) {
          from = uFrom;
          to = uTo;
        }

        const moveRes = c.move({ from: uFrom, to: uTo, promotion });
        if (moveRes) {
          pvSan.push(moveRes.san);
        } else {
          break;
        }
      }
    } catch {
      // Fallback
    }

    const engineLine: EngineLine = {
      multipv,
      depth,
      scoreCp,
      scoreMate,
      formattedScore,
      pvUci,
      pvSan,
      from,
      to,
      fen: this.currentFen,
    };

    this.linesMap.set(multipv, engineLine);
    this.notify();
  }

  private notify() {
    const sorted = Array.from(this.linesMap.values()).sort((a, b) => a.multipv - b.multipv);
    this.listeners.forEach(listener => listener(sorted));
  }

  public evaluate(fen: string) {
    this.currentFen = fen;
    this.linesMap.clear();

    if (!this.worker) {
      this.init().then(() => this.evaluate(fen));
      return;
    }

    this.worker.postMessage('stop');
    this.worker.postMessage(`position fen ${fen}`);
    this.worker.postMessage(`go depth ${this.settings.maxDepth}`);
  }

  public stop() {
    if (this.worker) {
      this.worker.postMessage('stop');
    }
  }

  public onUpdate(callback: UpdateListener): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  public destroy() {
    this.stop();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.listeners.clear();
    this.linesMap.clear();
  }
}
