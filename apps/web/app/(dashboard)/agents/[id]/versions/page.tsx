import {VersionsScreen} from './_components/VersionsScreen';

// Version history, compare and rollback for one agent (U-13).
export default async function AgentVersionsPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  return <VersionsScreen agentId={id} />;
}
