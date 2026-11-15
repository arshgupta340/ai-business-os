import {AgentDetailScreen} from './_components/AgentDetailScreen';
import {agentStaticParams} from '../static-params';

function decode(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

/** The GitHub Pages build writes one page per known agent (static-params.ts). */
export const generateStaticParams = agentStaticParams;

export default async function AgentDetailPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  return <AgentDetailScreen agentId={decode(id)} />;
}
