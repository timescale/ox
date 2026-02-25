// ============================================================================
// Init Command - Configure hermes for a project
// ============================================================================

import type { SelectOption } from '@opentui/core';
import { Command } from 'commander';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CloudSetup } from '../components/CloudSetup';
import { CopyOnSelect } from '../components/CopyOnSelect';
import { DockerSetup } from '../components/DockerSetup';
import { FilterableSelector } from '../components/FilterableSelector';
import { GhAppInstall, GhAuth } from '../components/GhAuth';
import { Loading } from '../components/Loading';
import { Selector } from '../components/Selector';
import { AGENT_SELECT_OPTIONS, useAgentModels } from '../services/agents';
import { checkClaudeCredentials, ensureClaudeAuth } from '../services/claude';
import {
  type AgentType,
  type HermesConfig,
  projectConfig,
} from '../services/config';
import { applyHostGhCreds, checkGhCredentials } from '../services/gh';
import { readCredentialsUnchecked } from '../services/githubApp';
import {
  type GithubAppAuthProcess,
  startGithubAppAuth,
} from '../services/githubAppAuth';
import {
  checkOpencodeCredentials,
  ensureOpencodeAuth,
  runOpencodeInDocker,
} from '../services/opencode';
import {
  isTigerAvailable,
  listServices,
  type TigerService,
} from '../services/tiger';
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

type Step =
  | 'docker'
  | 'sandbox-provider'
  | 'cloud-region'
  | 'cloud-setup'
  | 'service'
  | 'agent'
  | 'model'
  | 'agent-auth-check'
  | 'gh-auth-check'
  | 'gh-auth'
  | 'gh-install';

export interface ConfigWizardProps {
  onComplete: (result: ConfigWizardResult) => void;
  initialConfig?: HermesConfig;
  skipToStep?: Step;
}

export function ConfigWizard({
  onComplete,
  initialConfig,
  skipToStep,
}: ConfigWizardProps) {
  // Create all promises immediately (only once via useMemo)
  const configPromise = useMemo(() => projectConfig.read(), []);
  const tigerAvailablePromise = useMemo(() => isTigerAvailable(), []);

  const [step, setStep] = useState<Step>(skipToStep ?? 'docker');
  const [config, setConfig] = useState<HermesConfig | null>(
    initialConfig ?? null,
  );

  // Async data - null means still loading
  const [tigerAvailable, setTigerAvailable] = useState<boolean | null>(null);
  const [services, setServices] = useState<TigerService[] | null>(null);
  const [modelRefreshKey, setModelRefreshKey] = useState(0);
  const modelsMap = useAgentModels(modelRefreshKey);

  // GitHub auth state
  const [ghAuthProcess, setGhAuthProcess] =
    useState<GithubAppAuthProcess | null>(null);

  const steps = useMemo((): Step[] => {
    const list: Step[] = [
      'docker',
      'sandbox-provider',
      ...(config?.sandboxProvider === 'cloud'
        ? (['cloud-region', 'cloud-setup'] as const)
        : []),
      'agent',
      'model',
      ...(tigerAvailable ? (['service'] as const) : []),
      'agent-auth-check',
      'gh-auth-check',
    ];
    return list;
  }, [config?.sandboxProvider, tigerAvailable]);

  const nextStep = useCallback(
    (dir = 1) => {
      setStep((s) => {
        const i = steps.indexOf(s);
        return steps[i + dir] || 'docker';
      });
    },
    [steps],
  );

  // Step number helper - when tiger is unavailable, service step is skipped
  const stepNumber = (logicalStep: Step): number => {
    return steps.indexOf(logicalStep) + 1;
  };

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

  // Check tiger availability, then load services only if available
  useEffect(() => {
    tigerAvailablePromise
      .then(async (available) => {
        setTigerAvailable(available);
        if (!available) return;
        setServices(await listServices());
      })
      .catch(() => {
        setTigerAvailable(false);
      });
  }, [tigerAvailablePromise]);

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
        nextStep();
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
  }, [step, config, onComplete, nextStep]);

  // Handle GitHub auth check step - start the auth process
  useEffect(() => {
    if (step !== 'gh-auth-check') return;

    let cancelled = false;

    const checkAuth = async () => {
      const existingAuth = await checkGhCredentials();
      if (cancelled) return;
      if (existingAuth) {
        onComplete({ type: 'completed', config: config ?? {} });
        return;
      }

      // Try host auth first
      const hostResult = await applyHostGhCreds();
      if (cancelled) return;
      if (hostResult) {
        // Already have auth, complete the wizard
        onComplete({ type: 'completed', config: config ?? {} });
        return;
      }

      // Run the GitHub App device flow (no Docker needed)
      const authProcess = await startGithubAppAuth();

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

    ghAuthProcess.waitForCompletion().then((result) => {
      if (cancelled) return;
      if (result.success) {
        if (result.needsInstallation) {
          // Auth succeeded but app isn't installed — show install prompt
          setStep('gh-install');
        } else {
          onComplete({ type: 'completed', config: config ?? {} });
        }
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
        title={`Step 1/${steps.length}: Docker Setup`}
        onComplete={(result) => {
          if (result.type === 'cancelled') {
            onComplete({ type: 'cancelled' });
          } else if (result.type === 'error') {
            onComplete({
              type: 'error',
              message: result.error ?? 'Docker setup failed',
            });
          } else {
            nextStep();
          }
        }}
        showBack={false}
      />
    );
  }

  // ---- Step: Sandbox Provider Selection ----
  if (step === 'sandbox-provider') {
    const providerOptions: SelectOption[] = [
      {
        name: 'Docker (local)',
        description: 'Run sandbox containers locally via Docker',
        value: 'docker',
      },
      {
        name: 'Cloud',
        description: 'Run sandboxes in the cloud (Deno Deploy)',
        value: 'cloud',
      },
    ];

    const initialProviderIndex = config?.sandboxProvider === 'cloud' ? 1 : 0;

    return (
      <Selector
        title={`Step ${stepNumber('sandbox-provider')}/${steps.length}: Sandbox Provider`}
        description="Choose where to run sandbox containers."
        options={providerOptions}
        initialIndex={initialProviderIndex}
        showBack
        onSelect={(value) => {
          setConfig((c) =>
            c
              ? {
                  ...c,
                  sandboxProvider: value as 'docker' | 'cloud',
                  cloudRegion:
                    (value as 'docker' | 'cloud') === 'cloud'
                      ? (c.cloudRegion ?? 'ord')
                      : undefined,
                }
              : c,
          );
          nextStep();
        }}
        onCancel={handleCancel}
        onBack={() => nextStep(-1)}
      />
    );
  }

  // ---- Step: Cloud Region Selection ----
  if (step === 'cloud-region') {
    const regionOptions: SelectOption[] = [
      {
        name: 'US East (ord)',
        description: 'Chicago region',
        value: 'ord',
      },
      {
        name: 'EU West (ams)',
        description: 'Amsterdam region',
        value: 'ams',
      },
    ];

    const initialRegion = config?.cloudRegion ?? 'ord';
    const initialIndex = regionOptions.findIndex(
      (opt) => opt.value === initialRegion,
    );

    return (
      <Selector
        title={`Step ${stepNumber('cloud-region')}/${steps.length}: Cloud Region`}
        description="Choose the default cloud region for sandbox sessions."
        options={regionOptions}
        initialIndex={initialIndex >= 0 ? initialIndex : 0}
        showBack
        onSelect={(value) => {
          setConfig((c) =>
            c ? { ...c, cloudRegion: value as 'ord' | 'ams' } : c,
          );
          nextStep();
        }}
        onCancel={handleCancel}
        onBack={() => nextStep(-1)}
      />
    );
  }

  // ---- Step: Cloud Setup ----
  if (step === 'cloud-setup') {
    return (
      <CloudSetup
        title={`Step ${stepNumber('cloud-setup')}/${steps.length}: Cloud Setup`}
        showBack
        onBack={() => nextStep(-1)}
        onComplete={(result) => {
          if (result.type === 'ready') {
            nextStep();
            return;
          }
          if (result.type === 'cancelled') {
            onComplete({ type: 'cancelled' });
            return;
          }
          onComplete({
            type: 'error',
            message: result.error ?? 'Cloud setup failed',
          });
        }}
      />
    );
  }

  // ---- Step: Service Selection ----
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
        title={`Step ${stepNumber('service')}/${steps.length}: Database Service`}
        description="Select a Tiger service to use as the default parent for database forks."
        options={serviceOptions}
        initialIndex={initialIndex >= 0 ? initialIndex : 0}
        showBack
        onSelect={(value) => {
          setConfig((c) => (c ? { ...c, tigerServiceId: value } : c));
          nextStep();
        }}
        onCancel={handleCancel}
        onBack={() => nextStep(-1)}
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
        title={`Step ${stepNumber('agent')}/${steps.length}: Default Agent`}
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
          nextStep();
        }}
        onCancel={handleCancel}
        onBack={() => nextStep(-1)}
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
          title={`Step ${stepNumber('model')}/${steps.length}: Default Model (${config?.agent})`}
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
          onSelect={() => nextStep()}
          onCancel={handleCancel}
          onBack={() => nextStep(-1)}
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
      nextStep();
    };

    // Use filterable selector for opencode (has many more models)
    if (config?.agent === 'opencode') {
      return (
        <FilterableSelector
          title={`Step ${stepNumber('model')}/${steps.length}: Default Model (${config.agent})`}
          description={`Select the default model for ${config.agent}.`}
          options={modelOptions}
          initialIndex={initialIndex >= 0 ? initialIndex : 0}
          showBack
          onSelect={handleModelSelect}
          onCancel={handleCancel}
          onBack={() => nextStep(-1)}
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
        title={`Step ${stepNumber('model')}/${steps.length}: Default Model (${config?.agent})`}
        description={`Select the default model for ${config?.agent}.`}
        options={modelOptions}
        initialIndex={initialIndex >= 0 ? initialIndex : 0}
        showBack
        onSelect={handleModelSelect}
        onCancel={handleCancel}
        onBack={() => nextStep(-1)}
      />
    );
  }

  // ---- Step 5: Agent Auth Check ----
  if (step === 'agent-auth-check') {
    const agentName = config?.agent === 'claude' ? 'Claude' : 'Opencode';
    return (
      <Loading
        title={`Step ${stepNumber('agent-auth-check')}/${steps.length}: ${agentName} Authentication`}
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
        title={`Step ${stepNumber('gh-auth-check')}/${steps.length}: GitHub Authentication`}
        message="Checking GitHub authentication"
        onCancel={handleCancel}
      />
    );
  }

  // ---- Step 6b: GitHub Auth Device Flow ----
  if (step === 'gh-auth' && ghAuthProcess) {
    return (
      <GhAuth
        code={ghAuthProcess.userCode}
        url={ghAuthProcess.verificationUri}
        onCancel={() => {
          ghAuthProcess.cancel();
          onComplete({ type: 'cancelled' });
        }}
      />
    );
  }

  // ---- Step 6c: GitHub App Installation Prompt ----
  if (step === 'gh-install') {
    return (
      <GhAppInstall
        onDone={async () => {
          // Verify installation was completed
          const creds = await readCredentialsUnchecked();
          if (creds) {
            // Don't block completion even if install check fails —
            // the session-start check will catch it later
            onComplete({ type: 'completed', config: config ?? {} });
          } else {
            onComplete({ type: 'completed', config: config ?? {} });
          }
        }}
        onSkip={() => {
          // Allow skipping — the session-start repo access check will
          // catch the missing installation later with a clear error
          onComplete({ type: 'completed', config: config ?? {} });
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
      const authResult =
        result.agent === 'claude'
          ? await ensureClaudeAuth()
          : await ensureOpencodeAuth();
      if (!authResult) {
        console.error(`\nError: ${result.agent} login failed`);
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

    console.log(
      `  Sandbox: ${config.sandboxProvider === 'cloud' ? 'Cloud' : 'Docker (local)'}`,
    );

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
