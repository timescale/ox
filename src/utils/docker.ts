const expandArgs = (argType: string, args: string[]): string[] =>
  args.flatMap((arg) => [argType, arg]);

export const toVolumeArgs = (volumes: string[]): string[] =>
  expandArgs('-v', volumes);

export const toEnvArgs = (env: string[]): string[] => expandArgs('-e', env);
