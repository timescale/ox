// ============================================================================
// Init Command - Configure conductor for a project
// ============================================================================

import { createCliRenderer, type SelectOption } from '@opentui/core';
import { createRoot, useKeyboard } from '@opentui/react';
import { Command } from 'commander';
import { useState } from 'react';
import { readConfig, writeConfig } from '../services/config';
import { listServices, type TigerService } from '../services/tiger';

interface ServiceSelectorProps {
  services: TigerService[];
  currentServiceId?: string | null;
  onSelect: (serviceId: string | null) => void;
  onCancel: () => void;
}

function ServiceSelector({
  services,
  currentServiceId,
  onSelect,
  onCancel,
}: ServiceSelectorProps) {
  // Build options list with "None" at the top
  const options: SelectOption[] = [
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

  // Find initial index based on current config
  const initialIndex =
    currentServiceId === null
      ? 0 // "None" selected
      : currentServiceId
        ? options.findIndex((opt) => opt.value === currentServiceId)
        : 0;

  const [_selectedIndex, setSelectedIndex] = useState(
    initialIndex >= 0 ? initialIndex : 0,
  );

  useKeyboard((key) => {
    if (key.name === 'q' || key.name === 'escape') {
      onCancel();
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
        title="Configure Conductor"
        style={{
          border: true,
          borderStyle: 'single',
          padding: 1,
          flexDirection: 'column',
          flexGrow: 1,
        }}
      >
        <text>
          Select a Tiger service to use as the default parent for database
          forks.
        </text>
        <text style={{ fg: '#888888' }}>
          Use arrow keys to navigate, Enter to select, Esc to cancel.
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

async function initAction(): Promise<void> {
  // Check for existing config
  const existingConfig = await readConfig();
  const currentServiceId = existingConfig?.tigerServiceId;

  if (currentServiceId !== undefined) {
    console.log(
      `Current configuration: ${currentServiceId === null ? '(None)' : currentServiceId}`,
    );
  }

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
    console.log('\nNo Tiger services found.');
    console.log(
      'Create a service at https://console.cloud.timescale.com or use the tiger CLI.',
    );
    console.log('\nYou can still configure conductor to skip database forks:');
  }

  // Create a promise that resolves when user makes a selection
  let resolveSelection: (value: string | null | 'cancelled') => void;
  const selectionPromise = new Promise<string | null | 'cancelled'>(
    (resolve) => {
      resolveSelection = resolve;
    },
  );

  // Render the TUI
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  });

  function App() {
    return (
      <ServiceSelector
        services={services}
        currentServiceId={currentServiceId}
        onSelect={(serviceId) => {
          resolveSelection(serviceId);
        }}
        onCancel={() => {
          resolveSelection('cancelled');
        }}
      />
    );
  }

  const root = createRoot(renderer);
  root.render(<App />);

  // Wait for selection
  const result = await selectionPromise;

  // Clean up the TUI
  renderer.destroy();

  if (result === 'cancelled') {
    console.log('\nCancelled. No changes made.');
    return;
  }

  // Write the config
  await writeConfig({
    ...existingConfig,
    tigerServiceId: result,
  });

  // Print confirmation
  if (result === null) {
    console.log('\nConfigured conductor to skip database forks by default.');
    console.log(
      'You can still create forks with: conductor branch --service-id <id>',
    );
  } else {
    const selectedService = services.find((s) => s.service_id === result);
    console.log(
      `\nConfigured conductor to use "${selectedService?.name ?? result}" as the default parent service.`,
    );
  }
  console.log('\nConfiguration saved to .conductor/config.yml');
}

export const initCommand = new Command('init')
  .description(
    'Configure conductor for this project (select default Tiger service)',
  )
  .action(initAction);
