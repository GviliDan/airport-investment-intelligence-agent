'use client';

import { useEffect, useState } from 'react';
import { fetchMeta } from '@/services/api';
import type { Meta } from '@/types';

/** Server metadata (data periods, methodology, known limitations). `loaded` distinguishes "not yet" from "server unreachable". */
export function useMeta() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    void fetchMeta().then((m) => {
      if (!alive) return;
      setMeta(m);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  return { meta, loaded, serverDown: loaded && meta === null, chatDisabled: loaded && meta !== null && !meta.config.chatConfigured };
}
