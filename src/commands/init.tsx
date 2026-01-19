// ============================================================================
// Init Command - Configure conductor for a project
// ============================================================================

import { createCliRenderer, type SelectOption } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { Command } from 'commander';
import { useEffect, useState } from 'react';
import { FilterableSelector } from '../components/FilterableSelector';
import { Loading } from '../components/Loading';
import { Selector } from '../components/Selector';
import {
  AGENTS,
  getModelsForAgent,
  installOpencode,
  isOpencodeInstalled,
} from '../services/agents';
import {
  type AgentType,
  type ConductorConfig,
  mergeConfig,
  readHomeConfig,
  readLocalConfig,
  writeConfig,
} from '../services/config';
import { listServices, type TigerService } from '../services/tiger';

// ============================================================================
// Types
// ============================================================================

type Step = 'loading' | 'service' | 'agent' | 'install-opencode' | 'model';

type WizardResult =
  | { type: 'completed'; config: ConductorConfig }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

interface ModelOption {
  id: string;
  name: string;
  description: string;
}

interface PrefetchedModels {
  claude: ModelOption[];
  opencode: ModelOption[];
}

interface LoadedData {
  services: TigerService[];
  models: PrefetchedModels;
  initialConfig: ConductorConfig;
  opencodeInstalled: boolean;
}

// ============================================================================
// Wizard Steps Component
// ============================================================================

interface WizardStepsProps {
  data: LoadedData;
  onComplete: (result: WizardResult) => void;
}

function WizardSteps({ data, onComplete }: WizardStepsProps) {
  const { services, models: prefetchedModels, initialConfig } = data;
  const [step, setStep] = useState<
    'service' | 'agent' | 'install-opencode' | 'model'
  >('service');
  const [config, setConfig] = useState<ConductorConfig>({ ...initialConfig });
  const [opencodeInstalled, setOpencodeInstalled] = useState(
    data.opencodeInstalled,
  );
  const [opencodeModels, setOpencodeModels] = useState(
    prefetchedModels.opencode,
  );
  const [isInstalling, setIsInstalling] = useState(false);

  // Build service options
  const serviceOptions: SelectOption[] = [
    {
      name: '(None)',
      description: "This project doesn't need database forks",
      value: '__null__',
    },
    ...services.map((svc) => ({
      name: svc.name,
      description: `${svc.service_id} - ${svc.metadata.environment}, ${svc.region_code}, ${svc.status}${svc.paused ? ' (PAUSED)' : ''}`,
      value: svc.service_id,
    })),
  ];

  const serviceInitialIndex =
    config.tigerServiceId === null
      ? 0
      : config.tigerServiceId
        ? serviceOptions.findIndex((opt) => opt.value === config.tigerServiceId)
        : 0;

  // Build agent options
  const agentOptions: SelectOption[] = AGENTS.map((agent) => ({
    name: agent.name,
    description: agent.description,
    value: agent.id,
  }));

  const agentInitialIndex = config.agent
    ? agentOptions.findIndex((opt) => opt.value === config.agent)
    : 0;

  // Get model options for current agent
  const currentModelOptions = config.agent
    ? config.agent === 'opencode'
      ? opencodeModels
      : prefetchedModels[config.agent]
    : [];

  const modelSelectOptions: SelectOption[] = currentModelOptions.map(
    (model) => ({
      name: model.name,
      description: model.description,
      value: model.id,
    }),
  );

  const modelInitialIndex = config.model
    ? modelSelectOptions.findIndex((opt) => opt.value === config.model)
    : modelSelectOptions.findIndex((opt) =>
        config.agent === 'claude'
          ? opt.value === 'sonnet'
          : opt.value === 'anthropic/claude-sonnet-4-5',
      );

  const handleCancel = () => {
    onComplete({ type: 'cancelled' });
  };

  if (step === 'service') {
    return (
      <Selector
        title="Step 1/3: Database Service"
        description="Select a Tiger service to use as the default parent for database forks."
        options={serviceOptions}
        initialIndex={serviceInitialIndex >= 0 ? serviceInitialIndex : 0}
        showBack={false}
        onSelect={(value) => {
          setConfig((c) => ({ ...c, tigerServiceId: value }));
          setStep('agent');
        }}
        onCancel={handleCancel}
      />
    );
  }

  if (step === 'agent') {
    return (
      <Selector
        title="Step 2/3: Default Agent"
        description="Select the default coding agent to use."
        options={agentOptions}
        initialIndex={agentInitialIndex >= 0 ? agentInitialIndex : 0}
        showBack
        onSelect={(value) => {
          const newAgent = value as AgentType;

          // If opencode is selected but not installed, show install prompt
          if (newAgent === 'opencode' && !opencodeInstalled) {
            setConfig((c) => ({ ...c, agent: newAgent }));
            setStep('install-opencode');
            return;
          }

          const models =
            newAgent === 'opencode'
              ? opencodeModels
              : prefetchedModels[newAgent];

          // If no models for this agent, complete wizard immediately
          if (models.length === 0) {
            onComplete({
              type: 'completed',
              config: { ...config, agent: newAgent, model: undefined },
            });
            return;
          }

          setConfig((c) => ({
            ...c,
            agent: newAgent,
            // Clear model if agent changed
            model: c.agent !== newAgent ? undefined : c.model,
          }));
          setStep('model');
        }}
        onCancel={handleCancel}
        onBack={() => setStep('service')}
      />
    );
  }

  if (step === 'install-opencode') {
    const installOptions: SelectOption[] = [
      {
        name: 'Install OpenCode',
        description: 'Install opencode globally using bun',
        value: 'install',
      },
      {
        name: 'Choose Different Agent',
        description: 'Go back and select a different agent',
        value: 'back',
      },
    ];

    if (isInstalling) {
      return <Loading title="Installing opencode" onCancel={handleCancel} />;
    }

    return (
      <Selector
        title="OpenCode Not Found"
        description="OpenCode is not installed. Would you like to install it?"
        options={installOptions}
        initialIndex={0}
        showBack
        onSelect={async (value) => {
          if (value === 'back') {
            setStep('agent');
            return;
          }

          // Install opencode and fetch models before hiding loading screen
          setIsInstalling(true);
          const result = await installOpencode();

          if (!result.success) {
            setIsInstalling(false);
            onComplete({
              type: 'error',
              message: `Failed to install opencode: ${result.error}`,
            });
            return;
          }

          // Refresh opencode models after installation (still showing loading)
          const models = await getModelsForAgent('opencode');
          setOpencodeModels([...models]);
          setOpencodeInstalled(true);
          setIsInstalling(false);

          if (models.length === 0) {
            onComplete({
              type: 'completed',
              config: { ...config, model: undefined },
            });
            return;
          }

          setStep('model');
        }}
        onCancel={handleCancel}
        onBack={() => setStep('agent')}
      />
    );
  }

  if (step === 'model') {
    const handleModelSelect = (value: string | null) => {
      const finalConfig = { ...config, model: value || undefined };
      onComplete({ type: 'completed', config: finalConfig });
    };

    // Use filterable selector for opencode (has many more models)
    if (config.agent === 'opencode') {
      return (
        <FilterableSelector
          title={`Step 3/3: Default Model (${config.agent})`}
          description={`Select the default model for ${config.agent}.`}
          options={modelSelectOptions}
          initialIndex={modelInitialIndex >= 0 ? modelInitialIndex : 0}
          showBack
          onSelect={handleModelSelect}
          onCancel={handleCancel}
          onBack={() => setStep('agent')}
        />
      );
    }

    return (
      <Selector
        title={`Step 3/3: Default Model (${config.agent})`}
        description={`Select the default model for ${config.agent}.`}
        options={modelSelectOptions}
        initialIndex={modelInitialIndex >= 0 ? modelInitialIndex : 0}
        showBack
        onSelect={handleModelSelect}
        onCancel={handleCancel}
        onBack={() => setStep('agent')}
      />
    );
  }

  return null;
}

// ============================================================================
// Main App Component (handles loading -> wizard transition)
// ============================================================================

interface AppProps {
  onComplete: (result: WizardResult) => void;
}

function App({ onComplete }: AppProps) {
  const [step, setStep] = useState<Step>('loading');
  const [loadedData, setLoadedData] = useState<LoadedData | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      try {
        // Load config and data in parallel
        const [
          localConfig,
          homeConfig,
          services,
          claudeModels,
          opencodeInstalled,
        ] = await Promise.all([
          readLocalConfig(),
          readHomeConfig(),
          listServices(),
          getModelsForAgent('claude'),
          isOpencodeInstalled(),
        ]);

        // Only fetch opencode models if it's installed
        const opencodeModels = opencodeInstalled
          ? await getModelsForAgent('opencode')
          : [];

        if (cancelled) return;

        const initialConfig = mergeConfig(localConfig, homeConfig);

        setLoadedData({
          services,
          models: {
            claude: [...claudeModels],
            opencode: [...opencodeModels],
          },
          initialConfig,
          opencodeInstalled,
        });
        setStep('service');
      } catch (err) {
        if (cancelled) return;
        onComplete({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    loadData();

    return () => {
      cancelled = true;
    };
  }, [onComplete]);

  if (step === 'loading') {
    return <Loading onCancel={() => onComplete({ type: 'cancelled' })} />;
  }

  if (loadedData) {
    return <WizardSteps data={loadedData} onComplete={onComplete} />;
  }

  return null;
}

// ============================================================================
// Main Init Action
// ============================================================================

async function initAction(): Promise<void> {
  // Create promise for wizard completion
  let resolveWizard: (result: WizardResult) => void;
  const wizardPromise = new Promise<WizardResult>((resolve) => {
    resolveWizard = resolve;
  });

  // Start the TUI immediately
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const root = createRoot(renderer);

  root.render(<App onComplete={(result) => resolveWizard(result)} />);

  // Wait for wizard to complete
  const result = await wizardPromise;

  // Clean up renderer
  renderer.destroy();

  if (result.type === 'cancelled') {
    console.log('\nCancelled. No changes made.');
    return;
  }

  if (result.type === 'error') {
    console.error(`\nError: ${result.message}`);
    process.exit(1);
  }

  // Write the config
  const config = result.config;
  await writeConfig(config);

  // Print confirmation
  console.log('\nConfiguration saved to .conductor/config.yml');
  console.log('');
  console.log('Summary:');

  if (config.tigerServiceId === null) {
    console.log('  Database: (None) - forks will be skipped by default');
  } else if (config.tigerServiceId) {
    console.log(`  Database: ${config.tigerServiceId}`);
  }

  console.log(`  Agent: ${config.agent}`);
  if (config.model) {
    console.log(`  Model: ${config.model}`);
  }
}

export const initCommand = new Command('init')
  .description('Configure conductor for this project')
  .action(initAction);
