// ============================================================================
// Init Command - Configure hermes for a project
// ============================================================================

import { createCliRenderer, type SelectOption } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { Command } from 'commander';
import { useEffect, useMemo, useState } from 'react';
import { DockerSetup } from '../components/DockerSetup';
import { FilterableSelector } from '../components/FilterableSelector';
import { GhAuth } from '../components/GhAuth';
import { Loading } from '../components/Loading';
import { Selector } from '../components/Selector';
import { AGENT_SELECT_OPTIONS, useAgentModels } from '../services/agents';
import {
  type GhAuthProcess,
  startContainerGhAuth,
  tryHostGhAuth,
} from '../services/auth';
import {
  type AgentType,
  type HermesConfig,
  readConfig,
  writeConfig,
} from '../services/config';
import { ensureDockerImage, getDockerImageTag } from '../services/docker';
import { listServices, type TigerService } from '../services/tiger';
import { ensureGitignore, restoreConsole } from '../utils';

// ============================================================================
// Types
// ============================================================================

export type ConfigWizardResult =
  | { type: 'completed'; config: HermesConfig }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

// ============================================================================
// App Component
// ============================================================================

export interface ConfigWizardProps {
  onComplete: (result: ConfigWizardResult) => void;
}

export function ConfigWizard({ onComplete }: ConfigWizardProps) {
  // Create all promises immediately (only once via useMemo)
  const configPromise = useMemo(() => readConfig(), []);
  const servicesPromise = useMemo(() => listServices(), []);

  const [step, setStep] = useState<
    'docker' | 'service' | 'agent' | 'model' | 'gh-auth-check' | 'gh-auth'
  >('docker');
  const [config, setConfig] = useState<HermesConfig | null>(null);

  // Async data - null means still loading
  const [services, setServices] = useState<TigerService[] | null>(null);
  const modelsMap = useAgentModels();

  // GitHub auth state
  const [ghAuthProcess, setGhAuthProcess] = useState<GhAuthProcess | null>(
    null,
  );

  // Load data from promises
  useEffect(() => {
    configPromise
      .then((config) => setConfig(config ?? {}))
      .catch((err) =>
        onComplete({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        }),
      );
  }, [configPromise, onComplete]);

  useEffect(() => {
    servicesPromise.then(setServices).catch(() => setServices([]));
  }, [servicesPromise]);

  // Handle GitHub auth check step - start the auth process
  useEffect(() => {
    if (step !== 'gh-auth-check') return;

    let cancelled = false;

    const checkAuth = async () => {
      // First, ensure Docker image is built (needed for container auth)
      try {
        await ensureDockerImage();
      } catch (err) {
        if (!cancelled) {
          onComplete({
            type: 'error',
            message: `Failed to build Docker image: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        return;
      }

      // Try host auth first
      const hostResult = await tryHostGhAuth();
      if (cancelled) return;

      if (hostResult) {
        // Already have auth, complete the wizard
        onComplete({ type: 'completed', config: config ?? {} });
        return;
      }

      // Need to do container-based auth
      const dockerImage = getDockerImageTag();
      const authProcess = await startContainerGhAuth(dockerImage);

      if (cancelled) {
        authProcess?.cancel();
        return;
      }

      if (!authProcess) {
        onComplete({
          type: 'error',
          message: 'Failed to start GitHub authentication',
        });
        return;
      }

      setGhAuthProcess(authProcess);
      setStep('gh-auth');
    };

    checkAuth();

    return () => {
      cancelled = true;
    };
  }, [step, config, onComplete]);

  // Handle GitHub auth completion - separate effect to avoid cancellation issue
  useEffect(() => {
    if (step !== 'gh-auth' || !ghAuthProcess) return;

    let cancelled = false;

    ghAuthProcess.waitForCompletion().then((success) => {
      if (cancelled) return;
      if (success) {
        onComplete({ type: 'completed', config: config ?? {} });
      } else {
        onComplete({
          type: 'error',
          message: 'GitHub authentication failed or was cancelled',
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [step, ghAuthProcess, config, onComplete]);

  const handleCancel = () => {
    ghAuthProcess?.cancel();
    onComplete({ type: 'cancelled' });
  };

  // ---- Step 1: Docker Setup ----
  if (step === 'docker') {
    return (
      <DockerSetup
        title="Step 1/5: Docker Setup"
        onComplete={(result) => {
          if (result.type === 'cancelled') {
            onComplete({ type: 'cancelled' });
          } else if (result.type === 'error') {
            onComplete({
              type: 'error',
              message: result.error ?? 'Docker setup failed',
            });
          } else {
            setStep('service');
          }
        }}
        showBack={false}
      />
    );
  }

  // ---- Step 2: Service Selection ----
  if (step === 'service') {
    // Need config and services
    if (config === null || services === null) {
      return <Loading title="Loading services" onCancel={handleCancel} />;
    }

    const serviceOptions: SelectOption[] = [
      {
        name: '(None)',
        description: "This project doesn't need database forks",
        value: '__null__',
      },
      ...services.map((svc: TigerService) => ({
        name: svc.name,
        description: `${svc.service_id} - ${svc.metadata.environment}, ${svc.region_code}, ${svc.status}${svc.paused ? ' (PAUSED)' : ''}`,
        value: svc.service_id,
      })),
    ];

    const initialIndex =
      config.tigerServiceId === null
        ? 0
        : config.tigerServiceId
          ? serviceOptions.findIndex(
              (opt) => opt.value === config.tigerServiceId,
            )
          : 0;

    return (
      <Selector
        title="Step 2/5: Database Service"
        description="Select a Tiger service to use as the default parent for database forks."
        options={serviceOptions}
        initialIndex={initialIndex >= 0 ? initialIndex : 0}
        showBack
        onSelect={(value) => {
          setConfig((c) => (c ? { ...c, tigerServiceId: value } : c));
          setStep('agent');
        }}
        onCancel={handleCancel}
        onBack={() => setStep('docker')}
      />
    );
  }

  // ---- Step 3: Agent Selection ----
  if (step === 'agent') {
    const initialIndex = config?.agent
      ? AGENT_SELECT_OPTIONS.findIndex((opt) => opt.value === config.agent)
      : 0;

    return (
      <Selector
        title="Step 3/5: Default Agent"
        description="Select the default coding agent to use."
        options={AGENT_SELECT_OPTIONS}
        initialIndex={initialIndex >= 0 ? initialIndex : 0}
        showBack
        onSelect={(value) => {
          const newAgent = value as AgentType;

          // Get models for the selected agent
          const models = modelsMap[newAgent];

          // If no models, complete wizard
          if (models && models.length === 0) {
            onComplete({
              type: 'completed',
              config: { ...config, agent: newAgent, model: undefined },
            });
            return;
          }

          setConfig((c) => ({
            ...c,
            agent: newAgent,
            model: c?.agent !== newAgent ? undefined : c?.model,
          }));
          setStep('model');
        }}
        onCancel={handleCancel}
        onBack={() => setStep('service')}
      />
    );
  }

  // ---- Step 4: Model Selection ----
  if (step === 'model') {
    const currentModels = config?.agent ? modelsMap[config.agent] : null;

    // Need models for the selected agent
    if (currentModels === null) {
      return <Loading title="Loading models" onCancel={handleCancel} />;
    }

    const modelOptions: SelectOption[] = currentModels.map((model) => ({
      name: model.name,
      description: model.description || '',
      value: model.id,
    }));

    const initialIndex = config?.model
      ? modelOptions.findIndex((opt) => opt.value === config.model)
      : modelOptions.findIndex((opt) =>
          config?.agent === 'claude'
            ? opt.value === 'sonnet'
            : opt.value === 'anthropic/claude-sonnet-4-5',
        );

    const handleModelSelect = (value: string | null) => {
      setConfig((c) => ({ ...c, model: value || undefined }));
      setStep('gh-auth-check');
    };

    // Use filterable selector for opencode (has many more models)
    if (config?.agent === 'opencode') {
      return (
        <FilterableSelector
          title={`Step 4/5: Default Model (${config.agent})`}
          description={`Select the default model for ${config.agent}.`}
          options={modelOptions}
          initialIndex={initialIndex >= 0 ? initialIndex : 0}
          showBack
          onSelect={handleModelSelect}
          onCancel={handleCancel}
          onBack={() => setStep('agent')}
        />
      );
    }

    return (
      <Selector
        title={`Step 4/5: Default Model (${config?.agent})`}
        description={`Select the default model for ${config?.agent}.`}
        options={modelOptions}
        initialIndex={initialIndex >= 0 ? initialIndex : 0}
        showBack
        onSelect={handleModelSelect}
        onCancel={handleCancel}
        onBack={() => setStep('agent')}
      />
    );
  }

  // ---- Step 5: GitHub Auth Check ----
  if (step === 'gh-auth-check') {
    // Check if we already have auth or can get it from host
    // This is async, so we show loading while checking
    return (
      <Loading
        title="Step 5/5: GitHub Authentication"
        message="Checking GitHub authentication"
        onCancel={handleCancel}
      />
    );
  }

  // ---- Step 5b: GitHub Auth Device Flow ----
  if (step === 'gh-auth' && ghAuthProcess) {
    return (
      <GhAuth
        code={ghAuthProcess.deviceCode.code}
        url={ghAuthProcess.deviceCode.url}
        onComplete={(status) => {
          if (status.type === 'cancelled') {
            ghAuthProcess.cancel();
            onComplete({ type: 'cancelled' });
          }
          // Success/error handled by the waitForCompletion effect
        }}
      />
    );
  }

  return null;
}

// ============================================================================
// Main Init Action
// ============================================================================

export async function configAction(): Promise<void> {
  let resolveWizard: (result: ConfigWizardResult) => void;
  const wizardPromise = new Promise<ConfigWizardResult>((resolve) => {
    resolveWizard = resolve;
  });

  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const root = createRoot(renderer);

  root.render(<ConfigWizard onComplete={(result) => resolveWizard(result)} />);

  const result = await wizardPromise;

  await renderer.idle();
  renderer.destroy();
  restoreConsole();

  if (result.type === 'cancelled') {
    console.log('\nCancelled. No changes made.');
    return;
  }

  if (result.type === 'error') {
    console.error(`\nError: ${result.message}`);
    process.exit(1);
  }

  const config = result.config;

  // Ensure .gitignore has .hermes/ entry
  await ensureGitignore();

  await writeConfig(config);

  console.log('\nConfiguration saved to .hermes/config.yml');
  console.log('\nSummary:');

  if (config.tigerServiceId === null) {
    console.log('  Database: (None) - forks will be skipped by default');
  } else if (config.tigerServiceId) {
    console.log(`  Database: ${config.tigerServiceId}`);
  }

  console.log(`  Agent: ${config.agent}`);
  if (config.model) {
    console.log(`  Model: ${config.model}`);
  }

  console.log('  GitHub: authenticated');

  console.log('\nConfiguration complete! Run `hermes "<task>"` to start.');
}

export const configCommand = new Command('config')
  .description('Configure hermes for this project')
  .action(configAction);
