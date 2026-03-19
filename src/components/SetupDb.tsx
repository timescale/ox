// ============================================================================
// SetupDb - Configure Tiger database service for the current project
// ============================================================================

import type { SelectOption } from '@opentui/core';
import { useEffect, useMemo, useState } from 'react';
import { projectConfig, readConfig } from '../services/config.ts';
import {
  isTigerAvailable,
  listServices,
  type TigerService,
} from '../services/tiger.ts';

import { Loading } from './Loading.tsx';
import { Selector } from './Selector.tsx';

export type SetupDbResult =
  | { type: 'completed'; tigerServiceId: string | null }
  | { type: 'cancelled' }
  | { type: 'unavailable' };

interface SetupDbProps {
  onComplete: (result: SetupDbResult) => void;
}

export function SetupDb({ onComplete }: SetupDbProps) {
  const [tigerAvailable, setTigerAvailable] = useState<boolean | null>(null);
  const [services, setServices] = useState<TigerService[] | null>(null);
  const [currentServiceId, setCurrentServiceId] = useState<
    string | null | undefined
  >(undefined);

  // Check tiger availability and load services + current config in parallel
  useEffect(() => {
    (async () => {
      const [available, config] = await Promise.all([
        isTigerAvailable(),
        readConfig(),
      ]);
      setTigerAvailable(available);
      setCurrentServiceId(config.tigerServiceId ?? undefined);

      if (available) {
        try {
          const svcList = await listServices();
          setServices(svcList);
        } catch {
          setServices([]);
        }
      }
    })();
  }, []);

  // Tiger CLI not available — notify and return
  useEffect(() => {
    if (tigerAvailable === false) {
      onComplete({ type: 'unavailable' });
    }
  }, [tigerAvailable, onComplete]);

  const handleCancel = () => {
    onComplete({ type: 'cancelled' });
  };

  const handleSelect = async (value: string | null) => {
    const tigerServiceId = value === '__null__' ? null : value;

    // Persist to project config (creates .ox/config.yml if needed)
    await projectConfig.writeValue('tigerServiceId', tigerServiceId);

    onComplete({ type: 'completed', tigerServiceId });
  };

  const serviceOptions: SelectOption[] = useMemo(
    () => [
      {
        name: '(None)',
        description: "This project doesn't need database forks",
        value: '__null__',
      },
      ...(services ?? []).map((svc: TigerService) => ({
        name: svc.name,
        description: `${svc.service_id} - ${svc.metadata.environment}, ${svc.region_code}, ${svc.status}${svc.paused ? ' (PAUSED)' : ''}`,
        value: svc.service_id,
      })),
    ],
    [services],
  );

  // Still loading
  if (tigerAvailable === null || (tigerAvailable && services === null)) {
    return <Loading title="Loading services" onCancel={handleCancel} />;
  }

  const initialIndex =
    currentServiceId === null
      ? 0
      : currentServiceId
        ? serviceOptions.findIndex((opt) => opt.value === currentServiceId)
        : 0;

  return (
    <Selector
      key="setup-db"
      title="Database Service"
      description="Select a Tiger service to use as the default parent for database forks."
      options={serviceOptions}
      initialIndex={initialIndex >= 0 ? initialIndex : 0}
      onSelect={handleSelect}
      onCancel={handleCancel}
    />
  );
}
