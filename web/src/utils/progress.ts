import type { ProgressEvent } from '@/types';
import { toolLabel } from './format';

export interface Step {
  key: string;
  label: string;
  state: 'running' | 'done';
}

/** Folds the stream of progress events into a short list of steps for display. */
export function applyProgress(steps: Step[], e: ProgressEvent): Step[] {
  const done = (list: Step[]): Step[] => list.map((s) => (s.state === 'running' && s.key.startsWith('thinking') ? { ...s, state: 'done' } : s));
  switch (e.type) {
    case 'thinking': {
      const existing = steps.find((s) => s.key.startsWith('thinking') && s.state === 'running');
      return existing ? steps : [...steps, { key: `thinking:${steps.length}`, label: steps.length === 0 ? 'Understanding your question' : 'Reading the results', state: 'running' }];
    }
    case 'model_retry':
      return [...steps.filter((s) => s.key !== 'retry'), { key: 'retry', label: 'The AI model is busy; retrying automatically', state: 'running' }];
    case 'tool_start':
      return [...done(steps).filter((s) => s.key !== 'retry'), { key: `tool:${e.tool}:${steps.length}`, label: toolLabel(e.tool), state: 'running' }];
    case 'tool_done':
      return steps.map((s) => (s.key.startsWith(`tool:${e.tool}:`) && s.state === 'running' ? { ...s, state: 'done' } : s));
    case 'checking':
      return [...done(steps).map((s) => (s.key === 'retry' ? { ...s, state: 'done' as const } : s)), { key: 'checking', label: 'Checking every figure against the data', state: 'running' }];
    case 'rewriting':
      return [...steps.map((s) => (s.key === 'checking' ? { ...s, state: 'done' as const } : s)), { key: 'rewriting', label: 'Correcting figures that were not in the data', state: 'running' }];
  }
}
