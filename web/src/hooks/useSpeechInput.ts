'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

/**
 * Voice input (bonus) through the browser's own speech recognition. Audio never reaches this app's server; the browser or
 * its speech service may process it. The transcript fills the message box and the user still presses Send.
 * Unsupported browsers get `supported: false` and the button is hidden.
 */
export function useSpeechInput(onTranscript: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = 'en-US';
    r.interimResults = false;
    r.continuous = false;
    r.onresult = (e) => onTranscript(Array.from(e.results, (res) => res[0]?.transcript ?? '').join(' ').trim());
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r;
    setSupported(true);
    return () => r.stop();
  }, [onTranscript]);

  const toggle = useCallback(() => {
    const r = rec.current;
    if (!r) return;
    if (listening) r.stop();
    else {
      setListening(true);
      try {
        r.start();
      } catch {
        setListening(false);
      }
    }
  }, [listening]);

  return { supported, listening, toggle };
}
