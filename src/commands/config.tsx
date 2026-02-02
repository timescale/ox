// ============================================================================
// Init Command - Configure hermes for a project
// ============================================================================

import type { SelectOption } from '@opentui/core';
import { Command } from 'commander';
import { useEffect, useMemo, useState } from 'react';
import { CopyOnSelect } from '../components/CopyOnSelect';
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
import { checkClaudeCredentials, runClaudeInDocker } from '../services/claude';
import {
  type AgentType,
  type HermesConfig,
  projectConfig,
} from '../services/config';
import {
  checkOpencodeCredentials,
  runOpencodeInDocker,
} from '../services/opencode';
import { listServices, type TigerService } from '../services/tiger';
import { createTui } from '../services/tui';
import { ensureGitignore } from '../utils';

// ============================================================================
// Types
// ============================================================================

export type ConfigWizardResult =
  | { type: 'completed'; config: HermesConfig }
  | { type: 'needs-agent-auth'; config: HermesConfig; agent: AgentType }
  | { type: 'needs-opencode-provider'; config: HermesConfig }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

// ============================================================================
// App Component
// ============================================================================

export interface ConfigWizardProps {
  onComplete: (result: ConfigWizardResult) => void;
  initialConfig?: HermesConfig;
  skipToStep?: 'model' | 'agent-auth-check' | 'gh-auth-check';
}

export function ConfigWizard({
  onComplete,
  initialConfig,
  skipToStep,
}: ConfigWizardProps) {
  // Create all promises immediately (only once via useMemo)
  const configPromise = useMemo(() => projectConfig.read(), []);
  const servicesPromise = useMemo(() => listServices(), []);

  const [step, setStep] = useState<
    | 'docker'
    | 'service'
    | 'agent'
    | 'model'
    | 'agent-auth-check'
    | 'gh-auth-check'
    | 'gh-auth'
  >(skipToStep ?? 'docker');
  const [config, setConfig] = useState<HermesConfig | null>(
    initialConfig ?? null,
  );

  // Async data - null means still loading
  const [services, setServices] = useState<TigerService[] | null>(null);
  const [modelRefreshKey, setModelRefreshKey] = useState(0);
  const modelsMap = useAgentModels(modelRefreshKey);

  // GitHub auth state
  const [ghAuthProcess, setGhAuthProcess] = useState<GhAuthProcess | null>(
    null,
  );

  // Load data from promises
  useEffect(() => {
    // If we have initialConfig, use it instead of loading from file
    if (initialConfig) {
      return;
    }
    configPromise
      .then((cfg) => setConfig(cfg ?? {}))
      .catch((err) =>
        onComplete({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        }),
      );
  }, [configPromise, initialConfig, onComplete]);

  useEffect(() => {
    servicesPromise.then(setServices).catch(() => setServices([]));
  }, [servicesPromise]);

  // Force refresh models when resuming at the model step (after adding a provider)
  useEffect(() => {
    if (skipToStep === 'model') {
      setModelRefreshKey((k) => k + 1);
    }
  }, [skipToStep]);

  // Handle Agent auth check step - verify credentials or trigger login
  useEffect(() => {
    if (step !== 'agent-auth-check' || !config?.agent) return;

    let cancelled = false;

    const checkAuth = async () => {
      const isValid =
        config.agent === 'claude'
          ? await checkClaudeCredentials(config.model)
          : await checkOpencodeCredentials(config.model);

      if (cancelled) return;

      if (isValid) {
        setStep('gh-auth-check');
      } else {
        // Need login - trigger callback to handle interactive auth
        // config.agent is guaranteed to be defined by the guard at the top
        onComplete({
          type: 'needs-agent-auth',
          config: config,
          // biome-ignore lint/style/noNonNullAssertion: guarded above
          agent: config.agent!,
        });
      }
    };

    checkAuth();

    return () => {
      cancelled = true;
    };
  }, [step, config, onComplete]);

  // Handle GitHub auth check step - start the auth process
  useEffect(() => {
    if (step !== 'gh-auth-check') return;

    let cancelled = false;

    const checkAuth = async () => {
      // Try host auth first
      const hostResult = await tryHostGhAuth();
      if (cancelled) return;

      if (hostResult) {
        // Already have auth, complete the wizard
        onComplete({ type: 'completed', config: config ?? {} });
        return;
      }

      // Need to do container-based auth
      // Docker image is already ensured by the DockerSetup step
      const authProcess = await startContainerGhAuth();

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
        title="Step 1/6: Docker Setup"
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
        title="Step 2/6: Database Service"
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
        title="Step 3/6: Default Agent"
        description="Select the default coding agent to use."
        options={AGENT_SELECT_OPTIONS}
        initialIndex={initialIndex >= 0 ? initialIndex : 0}
        showBack
        onSelect={(value) => {
          const newAgent = value as AgentType;

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

    // If no models available (e.g., docker or opencode CLI issues), allow skipping
    if (currentModels.length === 0) {
      return (
        <Selector
          title={`Step 4/6: Default Model (${config?.agent})`}
          description="Could not load models. You can skip and specify a model later with --model."
          options={[
            {
              name: 'Skip model selection',
              value: '__skip__',
              description: 'Continue without setting a default model',
            },
          ]}
          initialIndex={0}
          showBack
          onSelect={() => setStep('agent-auth-check')}
          onCancel={handleCancel}
          onBack={() => setStep('agent')}
        />
      );
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
      setStep('agent-auth-check');
    };

    // Use filterable selector for opencode (has many more models)
    if (config?.agent === 'opencode') {
      return (
        <FilterableSelector
          title={`Step 4/6: Default Model (${config.agent})`}
          description={`Select the default model for ${config.agent}.`}
          options={modelOptions}
          initialIndex={initialIndex >= 0 ? initialIndex : 0}
          showBack
          onSelect={handleModelSelect}
          onCancel={handleCancel}
          onBack={() => setStep('agent')}
          hotkeys={[
            {
              label: 'ctrl+a',
              description: 'add provider',
              test: (key) => key.ctrl && key.name === 'a',
              handler: () => {
                onComplete({
                  type: 'needs-opencode-provider',
                  config: config,
                });
              },
            },
          ]}
        />
      );
    }

    return (
      <Selector
        title={`Step 4/6: Default Model (${config?.agent})`}
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

  // ---- Step 5: Agent Auth Check ----
  if (step === 'agent-auth-check') {
    const agentName = config?.agent === 'claude' ? 'Claude' : 'Opencode';
    return (
      <Loading
        title={`Step 5/6: ${agentName} Authentication`}
        message={`Checking ${agentName} credentials`}
        onCancel={handleCancel}
      />
    );
  }

  // ---- Step 6: GitHub Auth Check ----
  if (step === 'gh-auth-check') {
    // Check if we already have auth or can get it from host
    // This is async, so we show loading while checking
    return (
      <Loading
        title="Step 6/6: GitHub Authentication"
        message="Checking GitHub authentication"
        onCancel={handleCancel}
      />
    );
  }

  // ---- Step 6b: GitHub Auth Device Flow ----
  if (step === 'gh-auth' && ghAuthProcess) {
    return (
      <GhAuth
        code={ghAuthProcess.code}
        url={ghAuthProcess.url}
        onCancel={() => {
          ghAuthProcess.cancel();
          onComplete({ type: 'cancelled' });
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
  let currentConfig: HermesConfig | undefined;
  let skipToStep: 'model' | 'agent-auth-check' | 'gh-auth-check' | undefined;

  // Loop to handle interactive login flows that require exiting and re-entering the wizard
  for (;;) {
    let resolveWizard: (result: ConfigWizardResult) => void;
    const wizardPromise = new Promise<ConfigWizardResult>((resolve) => {
      resolveWizard = resolve;
    });

    const { render, destroy } = await createTui();

    render(
      <CopyOnSelect>
        <ConfigWizard
          onComplete={(result) => resolveWizard(result)}
          initialConfig={currentConfig}
          skipToStep={skipToStep}
        />
      </CopyOnSelect>,
    );

    const result = await wizardPromise;

    await destroy();

    if (result.type === 'needs-agent-auth') {
      // Run interactive login
      const agentName = result.agent === 'claude' ? 'Claude' : 'Opencode';
      console.log(`\nStarting ${agentName} login...\n`);

      const proc =
        result.agent === 'claude'
          ? await runClaudeInDocker({ cmdArgs: ['/login'], interactive: true })
          : await runOpencodeInDocker({
              cmdArgs: ['auth', 'login'],
              interactive: true,
            });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        console.error(`\nError: ${agentName} login failed`);
        process.exit(1);
      }

      // Resume wizard from agent-auth-check (will re-verify credentials)
      currentConfig = result.config;
      skipToStep = 'agent-auth-check';
      continue;
    }

    if (result.type === 'needs-opencode-provider') {
      // Run interactive provider login
      console.log('\nStarting Opencode provider login...\n');

      const proc = await runOpencodeInDocker({
        cmdArgs: ['auth', 'login'],
        interactive: true,
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        console.error('\nError: Opencode provider login failed');
        process.exit(1);
      }

      // Resume wizard at model selection step (with refreshed models)
      currentConfig = result.config;
      skipToStep = 'model';
      continue;
    }

    if (result.type === 'cancelled') {
      console.log('\nCancelled. No changes made.');
      return;
    }

    if (result.type === 'error') {
      console.error(`\nError: ${result.message}`);
      process.exit(1);
    }

    // result.type === 'completed'
    const config = result.config;

    // Ensure .gitignore has .hermes/ entry
    await ensureGitignore();

    await projectConfig.write(config);

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
    break;
  }
}

export const configCommand = new Command('config')
  .description('Configure hermes for this project')
  .action(configAction);
