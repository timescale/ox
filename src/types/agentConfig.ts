export interface ClaudeOAuthAccount {
  accountUuid?: string;
  emailAddress?: string;
  organizationUuid?: string;
  hasExtraUsageEnabled?: boolean;
  billingType?: string;
  accountCreatedAt?: string;
  subscriptionCreatedAt?: string;
  displayName?: string;
  organizationRole?: string;
  workspaceRole?: string | null;
  organizationName?: string;
}

export interface ClaudeCredentialsJson {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
  /** Paired from the host's .claude.json oauthAccount field */
  oauthAccount?: ClaudeOAuthAccount | null;
}

interface ApiKeyAuth {
  type: 'api';
  key: string;
}

interface OAuthAuth {
  type: 'oauth';
  access: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
}

export type AuthEntry = ApiKeyAuth | OAuthAuth;
export type OpencodeAuthJson = Partial<Record<string, AuthEntry>>;

export interface CodexAuthTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
}

export interface CodexAuthJson {
  auth_mode?: 'apikey' | 'chatgpt';
  OPENAI_API_KEY?: string | null;
  // OAuth/device-auth tokens (nested under `tokens` by `codex login`)
  tokens?: CodexAuthTokens;
  last_refresh?: string;
  // Legacy flat fields (older codex versions or manual config)
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}
