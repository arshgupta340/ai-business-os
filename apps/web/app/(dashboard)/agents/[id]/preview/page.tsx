import {AgentPreviewScreen} from './_components/AgentPreviewScreen';
import {agentStaticParams} from '../../static-params';

/** The GitHub Pages build writes one page per known agent (static-params.ts). */
export const generateStaticParams = agentStaticParams;

export default async function AgentPreviewPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  return <AgentPreviewScreen agentId={decodeURIComponent(id)} />;
}
