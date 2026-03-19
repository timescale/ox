import { useReadinessStore } from '../stores/readinessStore.ts';
import { Loading } from './Loading.tsx';
import { PullProgress } from './PullProgress.tsx';

export interface StartingScreenProps {
  step: string;
  /** Non-build step detail (e.g. latest output line) */
  subDetail?: string;
  hint?: string;
}

export const StartingScreen = ({
  step,
  subDetail,
  hint,
}: StartingScreenProps) => {
  const sandboxBaseImage = useReadinessStore((s) => s.sandboxBaseImage);
  const basePullLayers = useReadinessStore((s) => s.basePullLayers);
  const sandboxAgentImage = useReadinessStore((s) => s.sandboxAgentImage);
  const agentBuildMessage = useReadinessStore((s) => s.agentBuildMessage);
  const agentBuildDetail = useReadinessStore((s) => s.agentBuildDetail);
  const agentBuildLayers = useReadinessStore((s) => s.agentBuildLayers);
  const agentImageAgent = useReadinessStore((s) => s.agentImageAgent);

  // Base image pulling
  if (sandboxBaseImage === 'pulling') {
    if (basePullLayers.length > 0) {
      return (
        <PullProgress message="Pulling sandbox image" layers={basePullLayers} />
      );
    }
    return (
      <Loading message="Loading" detail="Pulling sandbox image" hint={hint} />
    );
  }

  // Base image checking
  if (sandboxBaseImage === 'checking') {
    return (
      <Loading message="Loading" detail="Checking sandbox image" hint={hint} />
    );
  }

  // Agent image checking
  if (sandboxAgentImage === 'checking') {
    return (
      <Loading message="Loading" detail="Checking agent image" hint={hint} />
    );
  }

  // Agent image building
  if (sandboxAgentImage === 'building') {
    const agentName = agentImageAgent ?? 'agent';
    if (agentBuildLayers.length > 0) {
      return (
        <PullProgress
          message={agentBuildMessage ?? `Building ${agentName} agent image`}
          layers={agentBuildLayers}
        />
      );
    }
    return (
      <Loading
        message="Loading"
        detail={agentBuildMessage ?? `Building ${agentName} agent image`}
        subDetail={agentBuildDetail ?? undefined}
        hint={hint}
      />
    );
  }

  // Default: fall through to router step/detail props
  return (
    <Loading
      message="Loading"
      detail={step}
      subDetail={subDetail}
      hint={hint}
    />
  );
};
