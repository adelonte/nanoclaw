export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// --- Connector types ---

export type ConnectorStatus =
  | 'pending'
  | 'connected'
  | 'expired'
  | 'failed'
  | 'revoked';

export type OAuthSessionStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'expired';

export type ConnectorAuthType = 'oauth2' | 'api_key';

export interface Connection {
  id: string;
  integration: string;
  account_label: string;
  provider_account_id: string | null;
  status: ConnectorStatus;
  requested_by_group: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

export interface ConnectionGroupAccess {
  connection_id: string;
  group_folder: string;
  enabled: boolean;
  granted_at: string;
  granted_by: string | null;
}

export interface OAuthSession {
  id: string;
  connection_id: string;
  provider: string;
  state: string;
  pkce_verifier: string | null;
  redirect_uri: string;
  status: OAuthSessionStatus;
  created_at: string;
  completed_at: string | null;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  expires_in: number | null;
  scope: string | null;
}

export interface ConnectorRegistryEntry {
  integration: string;
  display_name: string;
  auth_type: ConnectorAuthType;
  oauth_config: string | null;
  icon: string | null;
  description: string | null;
  supports_multi_account: boolean;
}

export type ConnectorResolutionResult =
  | { type: 'resolved'; connection: Connection; access_token: string }
  | {
      type: 'INTEGRATION_NOT_CONNECTED';
      integration: string;
      group_folder: string;
    }
  | {
      type: 'ACCOUNT_SELECTION_REQUIRED';
      integration: string;
      accounts: Array<{ connection_id: string; account_label: string }>;
    }
  | { type: 'CONNECTION_EXPIRED'; connection_id: string; integration: string }
  | { type: 'CONNECTOR_PROVIDER_ERROR'; connection_id: string; error: string };

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
