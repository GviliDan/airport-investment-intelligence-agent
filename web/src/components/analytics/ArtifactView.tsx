import type { ReactNode } from 'react';
import { Card, CardHeader } from '@/components/ui/card';
import type { Artifact, ToolSuccess } from '@/types';
import { toolTitle } from '@/utils/format';
import { InsightCardsMap } from './registry';

/**
 * Renders one tool result. Every number shown comes from the backend result; nothing is recalculated here. A failed call is
 * a short notice, and an unknown tool falls back to the raw result under a disclosure.
 */
export function ArtifactView({ artifact }: { artifact: Artifact }) {
  const out = artifact.output;
  if (!out.ok) return <p className="text-[13.5px] text-warning" role="status">{toolTitle(artifact.tool)} did not run: {out.error.message}</p>;
  const Renderer: ((p: { o: ToolSuccess }) => ReactNode) | undefined = InsightCardsMap[artifact.tool];
  if (Renderer) return <Renderer o={out} />;
  return (
    <Card>
      <CardHeader title={toolTitle(artifact.tool)} />
      <details className="text-[13px]"><summary className="cursor-pointer text-primary">Show result</summary><pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted p-2 text-xs">{JSON.stringify(out.data, null, 2)}</pre></details>
    </Card>
  );
}
