import React, { useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { Textarea } from './Input';
import { importGame } from '../lib/api';
import { classifyTimeControl, formatTC } from '../lib/timeControl';
import type { ImportResult } from '../types';

interface ImportModalProps {
  open: boolean;
  onClose: () => void;
  onImportDone: (pgn: string, side: string, platform: string, pendingId?: number) => void;
}

export function ImportModal({ open, onClose, onImportDone }: ImportModalProps) {
  const [tab, setTab] = useState<'paste' | 'file'>('paste');
  const [pgnText, setPgnText] = useState('');
  const [side, setSide] = useState<'auto' | 'white' | 'black'>('auto');
  const [detected, setDetected] = useState<ImportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePgnChange = async (val: string) => {
    setPgnText(val);
    setError(null);
    if (!val.trim()) {
      setDetected(null);
      return;
    }
    // Try to auto-parse after a short debounce or on blur
    try {
      const res = await importGame(val, side);
      setDetected(res);
    } catch {
      setDetected(null);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      handlePgnChange(text);
    };
    reader.readAsText(file);
  };

  const handleSubmit = async () => {
    if (!pgnText.trim()) {
      setError('Please paste or upload a PGN');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await importGame(pgnText, side);
      const platform =
        res.meta.id.startsWith('chesscom') || (res.meta.pgn && res.meta.pgn.includes('Chess.com'))
          ? 'chesscom'
          : res.meta.pgn && res.meta.pgn.includes('lichess.org')
            ? 'lichess'
            : 'manual';
      onImportDone(pgnText, res.resolved_side, platform, res.pending_id);
      onClose();
      setPgnText('');
      setDetected(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Import Game" width="max-w-xl">
      <div className="flex flex-col gap-4">
        {/* Method Toggle */}
        <div className="flex rounded-md border border-slate-200 overflow-hidden text-xs font-medium">
          <button
            onClick={() => setTab('paste')}
            className={`flex-1 py-1.5 px-3 transition-colors ${tab === 'paste' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
          >
            Paste PGN
          </button>
          <button
            onClick={() => setTab('file')}
            className={`flex-1 py-1.5 px-3 transition-colors ${tab === 'file' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
          >
            Upload File
          </button>
        </div>

        {tab === 'paste' ? (
          <Textarea
            rows={7}
            placeholder={`[Event "Live Chess"]\n[White "PlayerA"]\n[Black "PlayerB"]\n1. e4 e5 ...`}
            value={pgnText}
            onChange={e => handlePgnChange(e.target.value)}
            error={error ?? undefined}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <label className="border-2 border-dashed border-slate-200 rounded-lg p-6 text-center cursor-pointer hover:border-slate-400 transition-colors">
              <span className="text-sm text-slate-600">Choose .pgn file or drop here</span>
              <input
                type="file"
                accept=".pgn,.txt"
                className="hidden"
                onChange={handleFileUpload}
              />
            </label>
            {pgnText && (
              <p className="text-xs text-slate-500 font-mono line-clamp-3 bg-slate-50 p-2 rounded">
                {pgnText.slice(0, 150)}…
              </p>
            )}
          </div>
        )}

        {/* Live Detection Pill */}
        {detected && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-md p-2.5 text-xs text-emerald-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span>✓</span>
              <span>
                <strong>{detected.meta.white}</strong> vs <strong>{detected.meta.black}</strong>
                {detected.meta.date && ` · ${detected.meta.date}`}
              </span>
            </div>
            {detected.meta.time_control && (
              <span className="font-mono">
                {(() => {
                  const tc = classifyTimeControl(detected.meta.time_control, 'manual');
                  return `${tc.icon} ${tc.label} (${formatTC(detected.meta.time_control)})`;
                })()}
              </span>
            )}
          </div>
        )}

        {/* Playing Side Toggle */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
            Playing Side
          </span>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ['auto', 'Auto-detect'],
                ['white', 'Force White ⚪'],
                ['black', 'Force Black ⚫'],
              ] as const
            ).map(([val, lbl]) => (
              <button
                key={val}
                type="button"
                onClick={() => setSide(val)}
                className={`py-1.5 px-2 rounded border text-xs font-medium text-center transition-colors
                  ${
                    side === val
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                  }`}
              >
                {lbl}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-400">
            Auto-detect matches your connected Chess.com or Lichess username against the PGN
            headers.
          </p>
        </div>

        {/* Footer Actions */}
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={loading} onClick={handleSubmit}>
            Import Game →
          </Button>
        </div>
      </div>
    </Modal>
  );
}
