'use client';

import { BookOpen, Plane, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useChat } from '@/hooks/useChat';
import { useMeta } from '@/hooks/useMeta';
import { AboutSheet } from './AboutSheet';
import { AssistantMessage } from './AssistantMessage';
import { Composer } from './Composer';
import { ErrorNotice } from './ErrorNotice';
import { ProgressSteps } from './ProgressSteps';
import { ThemeToggle } from './ThemeToggle';
import { Welcome } from './Welcome';

export function ChatApp() {
  const { turns, busy, send, reset, lastId } = useChat();
  const { meta, serverDown, chatDisabled } = useMeta();
  const [about, setAbout] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);
  const blocked = busy || serverDown || chatDisabled;

  return (
    <div className="flex h-dvh flex-col">
      <header className="border-b border-border bg-card/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Plane className="h-4 w-4" /></span>
          <h1 className="flex-1 truncate text-[15px] font-semibold tracking-tight">Airport Investment Intelligence</h1>
          <Button variant="ghost" size="sm" onClick={() => setAbout(true)}><BookOpen className="h-4 w-4" /><span className="hidden sm:inline">Data &amp; method</span></Button>
          <Button variant="ghost" size="sm" onClick={reset} disabled={turns.length === 0}><RotateCcw className="h-4 w-4" /><span className="hidden sm:inline">New chat</span></Button>
          <ThemeToggle />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full max-w-5xl flex-col gap-5 px-4 py-6">
          {serverDown ? <p className="rounded-lg border border-destructive/50 bg-destructive-bg p-3 text-sm text-destructive" role="alert">The analysis server is not reachable. Start it and reload this page.</p> : null}
          {chatDisabled ? <p className="rounded-lg border border-warning/50 bg-warning-bg p-3 text-sm text-warning" role="alert">Chat is disabled because no Gemini API key is configured on the server.</p> : null}
          {turns.length === 0 ? <Welcome onAsk={(q) => void send(q)} disabled={blocked} /> : null}
          {turns.map((t) => (
            <div key={t.id} className="space-y-3">
              <div className="flex justify-end"><p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-primary px-4 py-2.5 text-[15px] text-primary-foreground">{t.user}</p></div>
              {t.pending ? <ProgressSteps steps={t.steps} startedAt={t.startedAt} /> : null}
              {t.error ? <ErrorNotice error={t.error} onRetry={t.id === lastId ? () => void send(t.user, t.id) : undefined} /> : null}
              {t.response ? <AssistantMessage r={t.response} isLatest={t.id === lastId && !busy} onAsk={(x) => void send(x)} /> : null}
            </div>
          ))}
          <div ref={end} />
        </div>
      </main>

      <footer className="border-t border-border bg-card/80 backdrop-blur">
        <div className="mx-auto max-w-5xl px-4 py-3">
          <Composer disabled={blocked} onSend={(t) => void send(t)} />
          <p className="mt-1.5 text-center text-[11.5px] text-muted-foreground">Screening aid built on public data. Scores are relative, not investment advice or forecasts.</p>
        </div>
      </footer>
      <AboutSheet meta={meta} open={about} onOpenChange={setAbout} />
    </div>
  );
}
