import {AgentDetailScreen} from './_components/AgentDetailScreen';

function decode(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

export default async function AgentDetailPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  return <AgentDetailScreen agentId={decode(id)} />;
}
