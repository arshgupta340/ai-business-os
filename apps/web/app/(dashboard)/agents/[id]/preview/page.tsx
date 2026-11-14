import {AgentPreviewScreen} from './_components/AgentPreviewScreen';

export default async function AgentPreviewPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  return <AgentPreviewScreen agentId={decodeURIComponent(id)} />;
}
