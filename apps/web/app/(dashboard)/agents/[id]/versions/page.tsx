import {VersionsScreen} from './_components/VersionsScreen';
import {agentStaticParams} from '../../static-params';

/** The GitHub Pages build writes one page per known agent (static-params.ts). */
export const generateStaticParams = agentStaticParams;

// Version history, compare and rollback for one agent (U-13).
export default async function AgentVersionsPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  return <VersionsScreen agentId={id} />;
}
