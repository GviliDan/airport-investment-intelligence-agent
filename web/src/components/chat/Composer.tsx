'use client';

import { Mic, SendHorizontal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { useSpeechInput } from '@/hooks/useSpeechInput';

/** Message box with optional voice input. A voice transcript fills the box; the user still presses Send. */
export function Composer({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const onTranscript = useCallback((t: string) => setText((prev) => `${prev}${prev ? ' ' : ''}${t}`.slice(0, 2000)), []);
  const voice = useSpeechInput(onTranscript);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const submit = (e?: FormEvent): void => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) submit(e);
  };

  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <label htmlFor="msg" className="sr-only">Ask about US airports</label>
      <textarea
        id="msg" ref={ref} rows={1} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
        placeholder="Ask about US airports: rankings, comparisons, routes, operations…"
        className="max-h-40 min-h-11 flex-1 resize-none rounded-xl border border-border bg-card px-3.5 py-2.5 text-[15px] shadow-sm placeholder:text-muted-foreground"
      />
      {voice.supported ? (
        <Button type="button" variant={voice.listening ? 'default' : 'outline'} size="icon" className="h-11 w-11 rounded-xl" onClick={voice.toggle} aria-pressed={voice.listening} aria-label={voice.listening ? 'Stop voice input' : 'Start voice input'} title="Voice input (your browser's speech recognition)">
          <Mic className="h-4 w-4" />
        </Button>
      ) : null}
      <Button type="submit" className="h-11 rounded-xl px-4" disabled={disabled || text.trim() === ''}>
        <SendHorizontal className="h-4 w-4" /> Send
      </Button>
    </form>
  );
}
