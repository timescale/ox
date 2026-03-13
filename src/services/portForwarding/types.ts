/** A single port mapping from the project config */
export interface AppPortEntry {
  port: number;
  subdomain?: string;
}

/** Resolved URL info for a port, stored in session metadata */
export interface PortUrl {
  port: number;
  subdomain?: string;
  /** Local proxy URL (e.g., https://abc123.ox.local) */
  url: string;
  /** External URL from cloud provider (e.g., Deno exposeHttp result) */
  externalUrl?: string;
}

/** Resolved port forwarding config ready for use */
export interface ResolvedPortConfig {
  ports: AppPortEntry[];
  /** The default port (entry without subdomain) */
  defaultPort: AppPortEntry;
}

/** State of a route registered with Caddy, persisted in the Caddyfile */
export interface CaddyRoute {
  sessionId: string;
  containerName: string;
  ports: AppPortEntry[];
  isCloud: boolean;
  /** Map from port number to external URL (cloud only) */
  externalUrls?: Record<number, string>;
}
