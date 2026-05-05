'use client';

import { useState, useEffect, useCallback } from 'react';
import { Delete, RotateCcw } from 'lucide-react';
import { clsx } from 'clsx';

type BtnDef = {
  label: string | React.ReactNode;
  value: string;
  style: 'num' | 'op' | 'eq' | 'fn' | 'zero';
};

const BUTTONS: BtnDef[] = [
  { label: 'AC',  value: 'AC',  style: 'fn'  },
  { label: '+/-', value: 'NEG', style: 'fn'  },
  { label: '%',   value: '%',   style: 'fn'  },
  { label: '÷',   value: '/',   style: 'op'  },

  { label: '7',   value: '7',   style: 'num' },
  { label: '8',   value: '8',   style: 'num' },
  { label: '9',   value: '9',   style: 'num' },
  { label: '×',   value: '*',   style: 'op'  },

  { label: '4',   value: '4',   style: 'num' },
  { label: '5',   value: '5',   style: 'num' },
  { label: '6',   value: '6',   style: 'num' },
  { label: '−',   value: '-',   style: 'op'  },

  { label: '1',   value: '1',   style: 'num' },
  { label: '2',   value: '2',   style: 'num' },
  { label: '3',   value: '3',   style: 'num' },
  { label: '+',   value: '+',   style: 'op'  },

  { label: '0',   value: '0',   style: 'zero' },
  { label: '.',   value: '.',   style: 'num'  },
  { label: '=',   value: '=',   style: 'eq'   },
];

const BTN_STYLES: Record<BtnDef['style'], string> = {
  num:  'bg-gray-700 hover:bg-gray-600 text-white',
  op:   'bg-amber-500 hover:bg-amber-400 text-white',
  eq:   'bg-emerald-600 hover:bg-emerald-500 text-white',
  fn:   'bg-gray-600 hover:bg-gray-500 text-white',
  zero: 'bg-gray-700 hover:bg-gray-600 text-white col-span-2 justify-start pl-6',
};

function formatDisplay(val: string): string {
  if (val === 'Error') return 'Error';
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  // Use exponential for very large/small numbers
  if (Math.abs(num) >= 1e15 || (Math.abs(num) < 1e-9 && num !== 0)) {
    return num.toExponential(6);
  }
  // Remove trailing zeros after decimal
  return val.includes('.') ? val : String(num);
}

export default function Calculator() {
  const [display, setDisplay]     = useState('0');
  const [operand, setOperand]     = useState<number | null>(null);
  const [operator, setOperator]   = useState<string | null>(null);
  const [waitNext, setWaitNext]   = useState(false);
  const [history, setHistory]     = useState<string[]>([]);
  const [expression, setExpr]     = useState('');

  const compute = (a: number, op: string, b: number): number => {
    switch (op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b === 0 ? NaN : a / b;
      default:  return b;
    }
  };

  const press = useCallback((value: string) => {
    if (value === 'AC') {
      setDisplay('0'); setOperand(null); setOperator(null); setWaitNext(false); setExpr('');
      return;
    }

    if (value === 'NEG') {
      setDisplay(d => d === '0' || d === 'Error' ? d : String(parseFloat(d) * -1));
      return;
    }

    if (value === '%') {
      setDisplay(d => String(parseFloat(d) / 100));
      return;
    }

    if (['+', '-', '*', '/'].includes(value)) {
      const current = parseFloat(display);
      if (operand !== null && operator && !waitNext) {
        const result = compute(operand, operator, current);
        const resultStr = isNaN(result) ? 'Error' : String(parseFloat(result.toPrecision(12)));
        setDisplay(resultStr);
        setOperand(isNaN(result) ? null : result);
        setExpr(`${resultStr} ${opSymbol(value)}`);
      } else {
        setOperand(current);
        setExpr(`${display} ${opSymbol(value)}`);
      }
      setOperator(value);
      setWaitNext(true);
      return;
    }

    if (value === '=') {
      if (operand === null || operator === null) return;
      const current = parseFloat(display);
      const result  = compute(operand, operator, current);
      const resultStr = isNaN(result) ? 'Error' : String(parseFloat(result.toPrecision(12)));
      const entry = `${expression || operand} ${opSymbol(operator)} ${display} = ${resultStr}`;
      setHistory(h => [entry, ...h].slice(0, 20));
      setDisplay(resultStr);
      setExpr('');
      setOperand(null);
      setOperator(null);
      setWaitNext(true);
      return;
    }

    if (value === '.') {
      if (waitNext) {
        setDisplay('0.');
        setWaitNext(false);
        return;
      }
      if (display.includes('.')) return;
      setDisplay(d => d + '.');
      return;
    }

    // Digit
    if (waitNext) {
      setDisplay(value);
      setWaitNext(false);
    } else {
      setDisplay(d => d === '0' || d === 'Error' ? value : d.length >= 16 ? d : d + value);
    }
  }, [display, operand, operator, waitNext, expression]);

  const backspace = useCallback(() => {
    if (waitNext || display === 'Error') return;
    setDisplay(d => d.length <= 1 ? '0' : d.slice(0, -1));
  }, [display, waitNext]);

  // Keyboard support
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if ('0123456789'.includes(e.key)) press(e.key);
      else if (e.key === '+') press('+');
      else if (e.key === '-') press('-');
      else if (e.key === '*') press('*');
      else if (e.key === '/') { e.preventDefault(); press('/'); }
      else if (e.key === '.') press('.');
      else if (e.key === '%') press('%');
      else if (e.key === 'Enter' || e.key === '=') press('=');
      else if (e.key === 'Escape') press('AC');
      else if (e.key === 'Backspace') backspace();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [press, backspace]);

  function opSymbol(op: string) {
    return op === '*' ? '×' : op === '/' ? '÷' : op === '-' ? '−' : op;
  }

  const displayLen = display.length;
  const displaySize = displayLen > 14 ? 'text-2xl' : displayLen > 10 ? 'text-3xl' : displayLen > 7 ? 'text-4xl' : 'text-5xl';

  return (
    <div className="flex flex-col lg:flex-row gap-6 items-start">
      {/* Calculator */}
      <div className="w-full max-w-xs bg-gray-900 rounded-3xl overflow-hidden shadow-2xl border border-gray-800 flex-shrink-0">
        {/* Display */}
        <div className="px-6 pt-6 pb-4 text-right min-h-[120px] flex flex-col justify-end">
          <div className="text-xs text-gray-500 h-5 mb-1 truncate">{expression}</div>
          <div className={clsx('font-light text-white transition-all duration-100 break-all leading-none', displaySize)}>
            {formatDisplay(display)}
          </div>
        </div>

        {/* Backspace */}
        <div className="flex justify-end px-5 pb-2">
          <button
            onClick={backspace}
            className="p-2 text-gray-400 hover:text-white transition-colors"
            aria-label="Backspace"
          >
            <Delete className="h-4 w-4" />
          </button>
        </div>

        {/* Buttons */}
        <div className="grid grid-cols-4 gap-1 px-3 pb-5">
          {BUTTONS.map((btn) => (
            <button
              key={btn.value}
              onClick={() => press(btn.value)}
              className={clsx(
                'flex items-center justify-center h-16 rounded-2xl text-xl font-medium transition-all duration-75 active:scale-95 select-none',
                BTN_STYLES[btn.style]
              )}
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>

      {/* History */}
      <div className="flex-1 w-full">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-300">History</h2>
            {history.length > 0 && (
              <button
                onClick={() => setHistory([])}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                <RotateCcw className="h-3 w-3" /> Clear
              </button>
            )}
          </div>
          {history.length === 0 ? (
            <p className="text-xs text-gray-600 py-4 text-center">Calculations will appear here</p>
          ) : (
            <ul className="space-y-1.5">
              {history.map((entry, i) => (
                <li
                  key={i}
                  className="text-sm font-mono text-gray-400 bg-gray-800/50 rounded-lg px-3 py-2 cursor-pointer hover:bg-gray-800 hover:text-white transition-colors"
                  onClick={() => {
                    const result = entry.split('= ')[1];
                    if (result) { setDisplay(result); setWaitNext(true); }
                  }}
                >
                  {entry}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Keyboard hint */}
        <p className="text-xs text-gray-700 mt-3 text-center">Supports keyboard input · click a history entry to reuse the result</p>
      </div>
    </div>
  );
}
