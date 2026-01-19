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

type Step = 'service' | 'agent' | 'model' | 'loading';

type WizardResult =
  | { type: 'completed'; config: ConductorConfig }
  | { type: 'cancelled' };

interface ModelOption {
  id: string;
  name: string;
  description: string;
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
// Loading Component
// ============================================================================

function Loading({ message }: { message: string }) {
  const [dots, setDots] = useState('');

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
          justifyContent: 'center',
          alignItems: 'center',
          flexGrow: 1,
        }}
      >
        <text>
          {message}
          {dots}
        </text>
      </box>
    </box>
  );
}

// ============================================================================
// Wizard App Component
// ============================================================================

interface WizardProps {
  services: TigerService[];
  initialConfig: ConductorConfig;
  onComplete: (result: WizardResult) => void;
}

function Wizard({ services, initialConfig, onComplete }: WizardProps) {
  const [step, setStep] = useState<Step>('service');
  const [config, setConfig] = useState<ConductorConfig>({ ...initialConfig });
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);

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

  // Build model options (when available)
  const modelSelectOptions: SelectOption[] = modelOptions.map((model) => ({
    name: model.name,
    description: model.description,
    value: model.id,
  }));

  const modelInitialIndex = config.model
    ? modelSelectOptions.findIndex((opt) => opt.value === config.model)
    : modelSelectOptions.findIndex((opt) =>
        config.agent === 'claude'
          ? opt.value === 'sonnet'
          : opt.value === 'anthropic/claude-sonnet-4-5',
      );

  // Load models when entering model step
  useEffect(() => {
    if (step === 'loading' && config.agent) {
      getModelsForAgent(config.agent).then((models) => {
        if (models.length === 0) {
          // No models available, complete the wizard
          onComplete({ type: 'completed', config });
        } else {
          setModelOptions([...models]);
          setStep('model');
        }
      });
    }
  }, [step, config, onComplete]);

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
          setConfig((c) => ({
            ...c,
            agent: newAgent,
            // Clear model if agent changed
            model: c.agent !== newAgent ? undefined : c.model,
          }));
          setModelOptions([]); // Reset model options
          setStep('loading'); // Show loading while fetching models
        }}
        onCancel={handleCancel}
        onBack={() => setStep('service')}
      />
    );
  }

  if (step === 'loading') {
    return <Loading message="Loading models" />;
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
// Main Init Action
// ============================================================================

async function initAction(): Promise<void> {
  // Check for existing config (local and home)
  const [localConfig, homeConfig] = await Promise.all([
    readLocalConfig(),
    readHomeConfig(),
  ]);

  // Show current configuration with source indicators
  const hasLocalConfig = localConfig && Object.keys(localConfig).length > 0;
  const hasHomeConfig = homeConfig && Object.keys(homeConfig).length > 0;

  if (hasLocalConfig || hasHomeConfig) {
    console.log('Current configuration:');

    // Display each config key with its source
    const configKeys: Array<{
      key: keyof ConductorConfig;
      label: string;
      format?: (v: unknown) => string;
    }> = [
      {
        key: 'tigerServiceId',
        label: 'Service',
        format: (v) => (v === null ? '(None)' : String(v)),
      },
      { key: 'agent', label: 'Agent' },
      { key: 'model', label: 'Model' },
    ];

    for (const { key, label, format = String } of configKeys) {
      const localVal = localConfig?.[key];
      const homeVal = homeConfig?.[key];
      if (localVal !== undefined) {
        console.log(`  ${label}: ${format(localVal)} (local)`);
      } else if (homeVal !== undefined) {
        console.log(`  ${label}: ${format(homeVal)} (global)`);
      }
    }
    console.log('');
  }

  // Merge configs for initial values (local takes precedence)
  const existingConfig = mergeConfig(localConfig, homeConfig);

  // Fetch available services
  console.log('Fetching Tiger services...');
  let services: TigerService[];
  try {
    services = await listServices();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  if (services.length === 0) {
    console.log('No Tiger services found.');
    console.log(
      'Create a service at https://console.cloud.timescale.com or use the tiger CLI.',
    );
    console.log('You can still configure conductor to skip database forks.\n');
  }

  // Create promise for wizard completion
  let resolveWizard: (result: WizardResult) => void;
  const wizardPromise = new Promise<WizardResult>((resolve) => {
    resolveWizard = resolve;
  });

  // Render the wizard with a single renderer instance
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const root = createRoot(renderer);

  root.render(
    <Wizard
      services={services}
      initialConfig={existingConfig}
      onComplete={(result) => resolveWizard(result)}
    />,
  );

  // Wait for wizard to complete
  const result = await wizardPromise;

  // Clean up renderer
  renderer.destroy();

  if (result.type === 'cancelled') {
    console.log('\nCancelled. No changes made.');
    return;
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
    const svc = services.find((s) => s.service_id === config.tigerServiceId);
    console.log(`  Database: ${svc?.name ?? config.tigerServiceId}`);
  }

  console.log(`  Agent: ${config.agent}`);
  if (config.model) {
    console.log(`  Model: ${config.model}`);
  }
}

export const initCommand = new Command('init')
  .description('Configure conductor for this project')
  .action(initAction);
