// ============================================================================
// SetupDb - Configure the default database provider for the current project
// ============================================================================

import type { SelectOption } from '@opentui/core';
import { useEffect, useState } from 'react';
import {
  type DbServiceProvider,
  isDbProvider,
  projectConfig,
  readConfig,
} from '../services/config.ts';
import { dbProviderOptions } from '../services/db.ts';
import {
  checkGhostCredentials,
  type GhostDatabase,
  listGhostDatabases,
} from '../services/ghost.ts';
import {
  type GhostAuthProcess,
  startContainerGhostAuth,
} from '../services/ghostAuth.ts';
import {
  isTigerAvailable,
  listServices,
  type TigerService,
} from '../services/tiger.ts';
import { GhAuth } from './GhAuth.tsx';
import { Loading } from './Loading.tsx';
import { Selector } from './Selector.tsx';

type Step = 'provider' | 'auth' | 'service';

const NONE_OPTION: SelectOption = {
  name: '(None)',
  description: "This project doesn't need database forks",
  value: '__null__',
};

export type SetupDbResult =
  | {
      type: 'completed';
      dbServiceId: string | null;
      dbServiceProvider: DbServiceProvider | null;
    }
  | { type: 'cancelled' }
  | { type: 'unavailable' };

interface SetupDbProps {
  onComplete: (result: SetupDbResult) => void;
}

export function applySetupDbProviderSelection(
  config:
    | {
        dbServiceProvider?: DbServiceProvider | null;
        dbServiceId?: string | null;
      }
    | null
    | undefined,
  provider: DbServiceProvider | null,
): {
  dbServiceProvider: DbServiceProvider | null;
  dbServiceId: string | null | undefined;
} {
  if (provider === null) {
    return {
      dbServiceProvider: null,
      dbServiceId: null,
    };
  }

  return {
    dbServiceProvider: provider,
    dbServiceId:
      config?.dbServiceProvider === provider ? config.dbServiceId : undefined,
  };
}

export function buildSetupDbServiceOptions(
  provider: DbServiceProvider,
  services: TigerService[] | null,
  ghostDatabases: GhostDatabase[] | null,
): SelectOption[] {
  if (provider === 'ghost') {
    return [
      NONE_OPTION,
      ...(ghostDatabases ?? []).map((database: GhostDatabase) => ({
        name: database.name,
        description: `${database.id} - ${database.status}${database.region ? `, ${database.region}` : ''}${database.paused ? ' (PAUSED)' : ''}`,
        value: database.id,
      })),
    ];
  }

  return [
    NONE_OPTION,
    ...(services ?? []).map((svc: TigerService) => ({
      name: svc.name,
      description: `${svc.service_id} - ${svc.metadata.environment}, ${svc.region_code}, ${svc.status}${svc.paused ? ' (PAUSED)' : ''}`,
      value: svc.service_id,
    })),
  ];
}

export function getSetupDbInitialIndex(
  currentServiceId: string | null | undefined,
  options: SelectOption[],
): number {
  if (currentServiceId === null) {
    return 0;
  }

  if (!currentServiceId) {
    return 0;
  }

  const index = options.findIndex(
    (option) => option.value === currentServiceId,
  );
  return index >= 0 ? index : 0;
}

async function persistSetupDbSelection(
  dbServiceProvider: DbServiceProvider | null,
  dbServiceId: string | null,
): Promise<void> {
  const currentProjectConfig = (await projectConfig.read()) ?? {};
  await projectConfig.write({
    ...currentProjectConfig,
    dbServiceProvider,
    dbServiceId,
  });
}

export function normalizeSetupDbConfig(
  config:
    | {
        dbServiceProvider?: DbServiceProvider | string | null;
        dbServiceId?: string | null;
      }
    | null
    | undefined,
): {
  dbServiceProvider: DbServiceProvider | null;
  dbServiceId: string | null | undefined;
} {
  const dbServiceProvider = isDbProvider(config?.dbServiceProvider)
    ? config.dbServiceProvider
    : null;

  return {
    dbServiceProvider,
    dbServiceId:
      dbServiceProvider !== null
        ? (config?.dbServiceId ?? undefined)
        : undefined,
  };
}

export function SetupDb({ onComplete }: SetupDbProps) {
  const [step, setStep] = useState<Step>('provider');
  const [ready, setReady] = useState(false);
  const [currentProvider, setCurrentProvider] = useState<
    DbServiceProvider | null | undefined
  >(undefined);
  const [currentServiceId, setCurrentServiceId] = useState<
    string | null | undefined
  >(undefined);
  const [services, setServices] = useState<TigerService[] | null>(null);
  const [ghostDatabases, setGhostDatabases] = useState<GhostDatabase[] | null>(
    null,
  );
  const [ghostAuthProcess, setGhostAuthProcess] =
    useState<GhostAuthProcess | null>(null);

  useEffect(() => {
    let cancelled = false;

    readConfig()
      .then((config) => {
        if (cancelled) {
          return;
        }

        const normalized = normalizeSetupDbConfig(config);
        setCurrentProvider(normalized.dbServiceProvider);
        setCurrentServiceId(normalized.dbServiceId);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          onComplete({ type: 'unavailable' });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [onComplete]);

  useEffect(() => {
    if (step !== 'auth' || !currentProvider || ghostAuthProcess) {
      return;
    }

    let cancelled = false;

    const loadTigerServices = async () => {
      setServices(null);
      const available = await isTigerAvailable();
      if (cancelled) {
        return;
      }

      if (!available) {
        onComplete({ type: 'unavailable' });
        return;
      }

      try {
        const availableServices = await listServices();
        if (cancelled) {
          return;
        }
        setServices(availableServices);
      } catch {
        if (cancelled) {
          return;
        }
        setServices([]);
      }

      setStep('service');
    };

    const loadGhostDatabases = async () => {
      setGhostDatabases(null);
      const hasCredentials = await checkGhostCredentials();
      if (cancelled) {
        return;
      }

      if (hasCredentials) {
        try {
          const databases = await listGhostDatabases();
          if (cancelled) {
            return;
          }
          setGhostDatabases(databases);
        } catch {
          if (cancelled) {
            return;
          }
          setGhostDatabases([]);
        }
        setStep('service');
        return;
      }

      const authProcess = await startContainerGhostAuth();
      if (cancelled) {
        authProcess?.cancel();
        return;
      }

      if (!authProcess) {
        onComplete({ type: 'cancelled' });
        return;
      }

      setGhostAuthProcess(authProcess);
    };

    if (currentProvider === 'tiger') {
      loadTigerServices().catch(() => {
        if (!cancelled) {
          onComplete({ type: 'unavailable' });
        }
      });
      return () => {
        cancelled = true;
      };
    }

    loadGhostDatabases().catch(() => {
      if (!cancelled) {
        onComplete({ type: 'cancelled' });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [step, currentProvider, ghostAuthProcess, onComplete]);

  useEffect(() => {
    if (step !== 'auth' || currentProvider !== 'ghost' || !ghostAuthProcess) {
      return;
    }

    let cancelled = false;

    ghostAuthProcess.waitForCompletion().then(async (success) => {
      if (cancelled) {
        return;
      }

      setGhostAuthProcess(null);

      if (!success) {
        onComplete({ type: 'cancelled' });
        return;
      }

      try {
        const databases = await listGhostDatabases();
        if (cancelled) {
          return;
        }
        setGhostDatabases(databases);
      } catch {
        if (cancelled) {
          return;
        }
        setGhostDatabases([]);
      }
      setStep('service');
    });

    return () => {
      cancelled = true;
    };
  }, [step, currentProvider, ghostAuthProcess, onComplete]);

  const handleCancel = () => {
    ghostAuthProcess?.cancel();
    onComplete({ type: 'cancelled' });
  };

  const handleProviderSelect = async (value: string | null) => {
    const provider = value === '__null__' ? null : (value as DbServiceProvider);

    if (provider === null) {
      await persistSetupDbSelection(null, null);
      onComplete({
        type: 'completed',
        dbServiceProvider: null,
        dbServiceId: null,
      });
      return;
    }

    const nextSelection = applySetupDbProviderSelection(
      {
        dbServiceProvider: currentProvider,
        dbServiceId: currentServiceId,
      },
      provider,
    );

    ghostAuthProcess?.cancel();
    setGhostAuthProcess(null);
    setServices(null);
    setGhostDatabases(null);
    setCurrentProvider(nextSelection.dbServiceProvider);
    setCurrentServiceId(nextSelection.dbServiceId);
    setStep('auth');
  };

  const handleServiceSelect = async (value: string | null) => {
    if (!currentProvider) {
      return;
    }

    const dbServiceId = value === '__null__' ? null : value;

    await persistSetupDbSelection(currentProvider, dbServiceId);

    onComplete({
      type: 'completed',
      dbServiceProvider: currentProvider,
      dbServiceId,
    });
  };

  const providerInitialIndex =
    currentProvider === 'tiger' ? 0 : currentProvider === 'ghost' ? 1 : 2;

  const serviceOptions = currentProvider
    ? buildSetupDbServiceOptions(currentProvider, services, ghostDatabases)
    : [NONE_OPTION];

  if (!ready) {
    return <Loading title="Loading database setup" onCancel={handleCancel} />;
  }

  if (step === 'provider') {
    return (
      <Selector
        key="setup-db-provider"
        title="Database Provider"
        description="Choose the default database provider for forks."
        options={dbProviderOptions}
        initialIndex={providerInitialIndex}
        onSelect={handleProviderSelect}
        onCancel={handleCancel}
      />
    );
  }

  if (step === 'auth') {
    if (ghostAuthProcess) {
      return (
        <GhAuth
          code={ghostAuthProcess.code}
          url={ghostAuthProcess.url}
          onCancel={() => {
            ghostAuthProcess.cancel();
            setGhostAuthProcess(null);
            onComplete({ type: 'cancelled' });
          }}
        />
      );
    }

    return (
      <Loading
        title={currentProvider === 'ghost' ? 'Ghost Setup' : 'Tiger Setup'}
        message={
          currentProvider === 'ghost'
            ? 'Checking Ghost authentication'
            : 'Checking Tiger availability'
        }
        onCancel={handleCancel}
      />
    );
  }

  if (!currentProvider) {
    return <Loading title="Loading database setup" onCancel={handleCancel} />;
  }

  if (
    (currentProvider === 'tiger' && services === null) ||
    (currentProvider === 'ghost' && ghostDatabases === null)
  ) {
    return <Loading title="Loading services" onCancel={handleCancel} />;
  }

  return (
    <Selector
      key="setup-db-service"
      title={
        currentProvider === 'ghost' ? 'Ghost Database' : 'Database Service'
      }
      description={
        currentProvider === 'ghost'
          ? 'Select a Ghost database to use as the default parent for database forks.'
          : 'Select a Tiger service to use as the default parent for database forks.'
      }
      options={serviceOptions}
      initialIndex={getSetupDbInitialIndex(currentServiceId, serviceOptions)}
      showBack
      onSelect={handleServiceSelect}
      onCancel={handleCancel}
      onBack={() => {
        ghostAuthProcess?.cancel();
        setGhostAuthProcess(null);
        setServices(null);
        setGhostDatabases(null);
        setStep('provider');
      }}
    />
  );
}
