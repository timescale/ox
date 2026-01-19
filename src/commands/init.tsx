// ============================================================================
// Init Command - Configure conductor for a project
// ============================================================================

import { createCliRenderer, type SelectOption } from '@opentui/core';
import { createRoot, useKeyboard } from '@opentui/react';
import { Command } from 'commander';
import { useEffect, useState } from 'react';
import { AGENTS, getModelsForAgent } from '../services/agents';
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

type Step = 'loading' | 'service' | 'agent' | 'model';

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
}

// ============================================================================
// Loading Component
// ============================================================================

function Loading({ onCancel }: { onCancel: () => void }) {
  const [dots, setDots] = useState('');

  useKeyboard((key) => {
    if (key.name === 'escape') {
      onCancel();
    }
  });

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((d) => (d.length >= 3 ? '' : `${d}.`));
    }, 300);
    return () => clearInterval(interval);
  }, []);

  return (
    <box style={{ flexDirection: 'column', padding: 1, flexGrow: 1 }}>
      <box
        title="Configure Conductor"
        style={{
          border: true,
          borderStyle: 'single',
          padding: 1,
          flexDirection: 'column',
          flexGrow: 1,
        }}
      >
        <text>Loading{dots}</text>
        <text style={{ fg: '#888888', marginTop: 1 }}>
          Fetching services and models
        </text>
        <text style={{ fg: '#555555', marginTop: 1 }}>Press Esc to cancel</text>
      </box>
    </box>
  );
}

// ============================================================================
// Selector Component
// ============================================================================

interface SelectorProps {
  title: string;
  description: string;
  options: SelectOption[];
  initialIndex: number;
  showBack?: boolean;
  onSelect: (value: string | null) => void;
  onCancel: () => void;
  onBack?: () => void;
}

function Selector({
  title,
  description,
  options,
  initialIndex,
  showBack = false,
  onSelect,
  onCancel,
  onBack,
}: SelectorProps) {
  const [_selectedIndex, setSelectedIndex] = useState(
    initialIndex >= 0 ? initialIndex : 0,
  );

  useKeyboard((key) => {
    if (key.name === 'escape') {
      onCancel();
    }
    if (showBack && onBack && (key.name === 'backspace' || key.name === 'b')) {
      onBack();
    }
  });

  const handleChange = (index: number, _option: SelectOption | null) => {
    setSelectedIndex(index);
  };

  const handleSelect = (_index: number, option: SelectOption | null) => {
    if (option) {
      onSelect(option.value === '__null__' ? null : (option.value as string));
    }
  };

  return (
    <box style={{ flexDirection: 'column', padding: 1, flexGrow: 1 }}>
      <box
        title={title}
        style={{
          border: true,
          borderStyle: 'single',
          padding: 1,
          flexDirection: 'column',
          flexGrow: 1,
        }}
      >
        <text>{description}</text>
        <text style={{ fg: '#888888' }}>
          {showBack
            ? 'Arrow keys to navigate, Enter to select, b/Backspace to go back, Esc to cancel'
            : 'Arrow keys to navigate, Enter to select, Esc to cancel'}
        </text>

        <select
          options={options}
          focused
          selectedIndex={initialIndex >= 0 ? initialIndex : 0}
          onChange={handleChange}
          onSelect={handleSelect}
          showScrollIndicator
          style={{
            marginTop: 1,
            flexShrink: 1,
            flexGrow: 1,
            maxHeight: options.length * 2,
          }}
        />
      </box>
    </box>
  );
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
  const [step, setStep] = useState<'service' | 'agent' | 'model'>('service');
  const [config, setConfig] = useState<ConductorConfig>({ ...initialConfig });

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

  // Get model options for current agent from prefetched data
  const currentModelOptions = config.agent
    ? prefetchedModels[config.agent]
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
          const models = prefetchedModels[newAgent];

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

  if (step === 'model') {
    return (
      <Selector
        title={`Step 3/3: Default Model (${config.agent})`}
        description={`Select the default model for ${config.agent}.`}
        options={modelSelectOptions}
        initialIndex={modelInitialIndex >= 0 ? modelInitialIndex : 0}
        showBack
        onSelect={(value) => {
          const finalConfig = { ...config, model: value || undefined };
          onComplete({ type: 'completed', config: finalConfig });
        }}
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
          opencodeModels,
        ] = await Promise.all([
          readLocalConfig(),
          readHomeConfig(),
          listServices(),
          getModelsForAgent('claude'),
          getModelsForAgent('opencode'),
        ]);

        if (cancelled) return;

        const initialConfig = mergeConfig(localConfig, homeConfig);

        setLoadedData({
          services,
          models: {
            claude: [...claudeModels],
            opencode: [...opencodeModels],
          },
          initialConfig,
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
