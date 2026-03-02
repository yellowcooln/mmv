import { useEffect, useRef, useState, useMemo } from 'react';
import type { DebugLogEntry } from '../types';

interface DebugPanelProps {
  logs: DebugLogEntry[];
  onClose: () => void;
}

type LevelFilter = 'all' | 'warn' | 'error';

const LEVEL_COLOR: Record<string, string> = {
  info:  'text-gray-400',
  warn:  'text-yellow-400',
  error: 'text-red-400',
};

// Highlight key substrings inside a log message for quick scanning
function highlight(msg: string): React.ReactNode {
  // Colour packet type names, hash prefixes, and counter lines differently
  const parts = msg.split(/(\[pkt\]|\[stats\]|\[decode\]|\[mqtt\]|hash=[0-9a-f]+|nodes=\d+|path=[^\s]+|rx=\d+|ok=\d+|hexFail=\d+|decodeFail=\d+)/g);
  return parts.map((part, i) => {
    if (part.startsWith('[pkt]'))    return <span key={i} className="text-emerald-400">{part}</span>;
    if (part.startsWith('[stats]'))  return <span key={i} className="text-cyan-400">{part}</span>;
    if (part.startsWith('[decode]')) return <span key={i} className="text-yellow-300">{part}</span>;
    if (part.startsWith('[mqtt]'))   return <span key={i} className="text-blue-400">{part}</span>;
    if (part.startsWith('hash='))    return <span key={i} className="text-purple-400">{part}</span>;
    if (part.startsWith('nodes='))   return <span key={i} className="text-teal-400">{part}</span>;
    if (part.startsWith('path='))    return <span key={i} className="text-orange-300">{part}</span>;
    if (/^(rx|ok|hexFail|decodeFail)=/.test(part))
                                     return <span key={i} className="text-sky-300">{part}</span>;
    return part;
  });
}

function fmt(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-AU', { hour12: false });
}

export function DebugPanel({ logs, onClose }: DebugPanelProps) {
  const bottomRef  = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<LevelFilter>('all');
  const [pinToBottom, setPinToBottom] = useState(true);

  const filtered = useMemo(() => {
    if (filter === 'all')   return logs;
    if (filter === 'warn')  return logs.filter(l => l.level === 'warn' || l.level === 'error');
    return logs.filter(l => l.level === 'error');
  }, [logs, filter]);

  // Count per level for the badge
  const warnCount  = useMemo(() => logs.filter(l => l.level === 'warn').length,  [logs]);
  const errorCount = useMemo(() => logs.filter(l => l.level === 'error').length, [logs]);

  useEffect(() => {
    if (pinToBottom) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [filtered, pinToBottom]);

  return (
    <div className="fixed bottom-0 right-0 w-full md:w-2/3 lg:w-1/2 h-72 bg-gray-900 border-t border-l border-gray-700 flex flex-col z-50 shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1 bg-gray-800 border-b border-gray-700 flex-shrink-0 gap-2">
        <span className="text-xs font-mono font-semibold text-gray-300 uppercase tracking-wider">
          Debug Log
        </span>

        {/* Level filter pills */}
        <div className="flex gap-1 flex-1">
          {(['all', 'warn', 'error'] as LevelFilter[]).map(lvl => (
            <button
              key={lvl}
              onClick={() => setFilter(lvl)}
              className={`px-2 py-0.5 rounded text-xs font-mono transition-colors ${
                filter === lvl
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              {lvl}
              {lvl === 'warn'  && warnCount  > 0 && <span className="ml-1 text-yellow-400">{warnCount}</span>}
              {lvl === 'error' && errorCount > 0 && <span className="ml-1 text-red-400">{errorCount}</span>}
            </button>
          ))}
        </div>

        {/* Pin toggle */}
        <button
          onClick={() => setPinToBottom(v => !v)}
          title={pinToBottom ? 'Unpin scroll' : 'Pin to bottom'}
          className={`text-xs px-2 py-0.5 rounded font-mono transition-colors ${
            pinToBottom ? 'bg-gray-600 text-gray-200' : 'bg-gray-800 text-gray-500 border border-gray-600'
          }`}
        >
          ↓pin
        </button>

        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-100 text-lg leading-none px-1"
          aria-label="Close debug panel"
        >
          ×
        </button>
      </div>

      {/* Log output — oldest at top, newest at bottom */}
      <div className="flex-1 overflow-y-auto font-mono text-xs p-2 space-y-0.5">
        {filtered.length === 0 ? (
          <div className="text-gray-600 italic">No entries{filter !== 'all' ? ` at level "${filter}"` : ' yet'}…</div>
        ) : (
          [...filtered].reverse().map((entry, i) => (
            <div
              key={i}
              className={`flex gap-2 leading-snug rounded px-1 ${
                entry.level === 'error' ? 'bg-red-950/40' :
                entry.level === 'warn'  ? 'bg-yellow-950/30' : ''
              }`}
            >
              <span className="text-gray-600 shrink-0 w-20">{fmt(entry.ts)}</span>
              <span className={`shrink-0 w-12 uppercase ${LEVEL_COLOR[entry.level]}`}>
                [{entry.level}]
              </span>
              <span className="text-gray-200 break-all">{highlight(entry.message)}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
