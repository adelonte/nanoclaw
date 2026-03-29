/**
 * Connector Gateway Service
 *
 * In-process service managing OAuth connection lifecycle, app-wide credential
 * storage (host-only), and per-group access toggles.
 *
 * Security model:
 * - All OAuth tokens are stored/read/deleted via OneCLI secret APIs.
 * - SQLite stores metadata-only vault refs (`connector/token/{connectionId}`).
 * - Raw tokens never appear in SQLite.
 * - Provider OAuth client credentials are loaded from OneCLI at startup.
 */

import crypto from 'crypto';
import {
  cleanupExpiredOAuthSessions,
  createConnection,
  createOAuthSession,
  deleteConnection,
  deleteLegacyTokenRecord,
  deleteOAuthTokenRef,
  getAllConnectorRegistryEntries,
  getConnectionById,
  getConnectionsForGroup,
  getConnectionsByIntegration,
  getConnectorRegistryEntry,
  getGroupsWithAccess,
  getLegacyLocalVaultRefConnectionIds,
  getLegacyTokenConnectionIds,
  getOAuthSessionByState,
  getOAuthTokenRef,
  setConnectionGroupAccess,
  storeOAuthTokenRef,
  touchConnectionLastUsed,
  updateConnectionStatus,
  updateOAuthSessionStatus,
  upsertConnectorRegistryEntry,
} from '../db.js';
import {
  deleteConnectionTokenBundle,
  getConnectionTokenBundle,
  putConnectionTokenBundle,
} from './secret-store.js';
import { logger } from '../logger.js';
import {
  Connection,
  ConnectorRegistryEntry,
  ConnectorResolutionResult,
  OAuthTokens,
} from '../types.js';
import { getProvider, getRegisteredProviders } from './providers/index.js';

// Redirect path handled by the callback server
const CALLBACK_PATH = '/connector/callback';

// --- PKCE helpers ---

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');
  return { verifier, challenge };
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

export interface BeginAuthResult {
  connectionId: string;
  authUrl: string;
  message: string;
}

// --- Connector registry sync ---

/**
 * Sync built-in provider metadata into connector_registry so agents can
 * discover available integrations via connector_list even before connecting.
 */
export function syncConnectorRegistry(): void {
  for (const provider of getRegisteredProviders()) {
    upsertConnectorRegistryEntry({
      integration: provider.integration,
      display_name: provider.displayName,
      auth_type: 'oauth2',
      oauth_config: null,
      icon: null,
      description: null,
      supports_multi_account: true,
    });
  }
}

export function listAvailableIntegrations(): ConnectorRegistryEntry[] {
  return getAllConnectorRegistryEntries();
}

// --- Auth flow ---

/**
 * Begin an OAuth connection.
 * Creates a pending Connection and OAuthSession, returns the auth URL.
 * The connection is app-wide; access is toggled on for requestedByGroup only.
 */
export function beginAuth(
  integration: string,
  requestedByGroup: string,
  callbackBaseUrl: string,
  accountLabel?: string,
): BeginAuthResult {
  const provider = getProvider(integration);
  if (!provider) {
    throw new Error(
      `Integration "${integration}" is not available. Run connector_list to see available integrations.`,
    );
  }

  const connectionId = generateId('conn');
  const sessionId = generateId('sess');
  const { verifier, challenge } = generatePkce();
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${callbackBaseUrl}${CALLBACK_PATH}`;

  const now = new Date().toISOString();

  createConnection({
    id: connectionId,
    integration,
    account_label: accountLabel ?? `${provider.displayName} account`,
    provider_account_id: null,
    status: 'pending',
    requested_by_group: requestedByGroup,
    created_at: now,
    expires_at: null,
  });

  // Auto-grant access to requesting group
  setConnectionGroupAccess(
    connectionId,
    requestedByGroup,
    true,
    requestedByGroup,
  );

  createOAuthSession({
    id: sessionId,
    connection_id: connectionId,
    provider: integration,
    state,
    pkce_verifier: verifier,
    redirect_uri: redirectUri,
    status: 'pending',
    created_at: now,
    completed_at: null,
  });

  const authUrl = provider.getAuthUrl(state, redirectUri, challenge);

  logger.info(
    { connectionId, integration, requestedByGroup },
    'OAuth flow started',
  );

  return {
    connectionId,
    authUrl,
    message: `Click to connect ${provider.displayName}: ${authUrl}`,
  };
}

/**
 * Handle the OAuth callback (state + code from provider redirect).
 * Exchanges code for tokens, fetches user info, marks connection as connected.
 * Returns the connection ID on success.
 */
export async function handleCallback(
  state: string,
  code: string,
): Promise<{ connectionId: string; accountLabel: string }> {
  cleanupExpiredOAuthSessions();

  const session = getOAuthSessionByState(state);
  if (!session) {
    throw new Error(
      'Invalid or expired OAuth state. Please start the connection again.',
    );
  }
  if (session.status !== 'pending') {
    throw new Error(`OAuth session already ${session.status}.`);
  }

  const provider = getProvider(session.provider);
  if (!provider) {
    updateOAuthSessionStatus(session.id, 'failed');
    updateConnectionStatus(session.connection_id, 'failed');
    throw new Error(`Provider "${session.provider}" is no longer registered.`);
  }

  let tokens: OAuthTokens;
  try {
    tokens = await provider.exchangeCode(
      code,
      session.redirect_uri,
      session.pkce_verifier ?? '',
    );
  } catch (err) {
    updateOAuthSessionStatus(session.id, 'failed');
    updateConnectionStatus(session.connection_id, 'failed');
    throw err;
  }

  let userInfo: { id: string; label: string };
  try {
    userInfo = await provider.getUserInfo(tokens.access_token);
  } catch (err) {
    updateOAuthSessionStatus(session.id, 'failed');
    updateConnectionStatus(session.connection_id, 'failed');
    throw err;
  }

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  let vaultRef: string;
  try {
    vaultRef = await putConnectionTokenBundle(session.connection_id, tokens);
  } catch (err) {
    updateOAuthSessionStatus(session.id, 'failed');
    updateConnectionStatus(session.connection_id, 'failed');
    throw err;
  }
  storeOAuthTokenRef(session.connection_id, vaultRef, expiresAt);
  updateConnectionStatus(session.connection_id, 'connected', {
    provider_account_id: userInfo.id,
    account_label: userInfo.label,
    expires_at: expiresAt,
  });
  updateOAuthSessionStatus(session.id, 'completed');

  logger.info(
    {
      connectionId: session.connection_id,
      provider: session.provider,
      account: userInfo.label,
    },
    'OAuth connection established',
  );

  return { connectionId: session.connection_id, accountLabel: userInfo.label };
}

// --- Status + info ---

export function getConnectionStatus(
  connectionId: string,
):
  | { status: Connection['status']; account_label: string; integration: string }
  | undefined {
  const conn = getConnectionById(connectionId);
  if (!conn) return undefined;
  return {
    status: conn.status,
    account_label: conn.account_label,
    integration: conn.integration,
  };
}

// --- Listing ---

export function listForGroup(
  groupFolder: string,
  integration?: string,
): Connection[] {
  return getConnectionsForGroup(groupFolder, integration);
}

// --- Access management ---

/**
 * Enable or disable a connection for a group.
 * Only the main group is allowed to grant access to groups other than the requesting group.
 */
export function setAccess(
  connectionId: string,
  targetGroupFolder: string,
  enabled: boolean,
  requestedByGroup: string,
  isMain: boolean,
): void {
  const conn = getConnectionById(connectionId);
  if (!conn) {
    throw new Error(`Connection "${connectionId}" not found.`);
  }

  // Non-main groups can only toggle access for their own group folder.
  // Granting access to other groups is a main-only operation.
  if (!isMain && targetGroupFolder !== requestedByGroup) {
    throw new Error(
      'Only the main group can grant connector access to other groups.',
    );
  }

  setConnectionGroupAccess(
    connectionId,
    targetGroupFolder,
    enabled,
    requestedByGroup,
  );

  logger.info(
    { connectionId, targetGroupFolder, enabled, requestedByGroup },
    'Connector access updated',
  );
}

export function getAccessList(
  connectionId: string,
): Array<{ group_folder: string; enabled: boolean }> {
  return getGroupsWithAccess(connectionId).map((a) => ({
    group_folder: a.group_folder,
    enabled: a.enabled,
  }));
}

// --- Disconnect ---

export async function disconnect(
  connectionId: string,
  requestedByGroup: string,
  isMain: boolean,
): Promise<void> {
  const conn = getConnectionById(connectionId);
  if (!conn) {
    throw new Error(`Connection "${connectionId}" not found.`);
  }

  // Non-main groups can only disconnect connections they requested
  if (!isMain && conn.requested_by_group !== requestedByGroup) {
    throw new Error(
      'Only the main group can disconnect connections created by other groups.',
    );
  }

  const tokenRef = getOAuthTokenRef(connectionId);
  if (tokenRef) {
    const provider = getProvider(conn.integration);
    if (provider) {
      try {
        const tokens = await getConnectionTokenBundle(tokenRef.vault_ref);
        if (tokens?.access_token) {
          await provider.revokeToken(tokens.access_token);
        }
      } catch (err) {
        logger.warn(
          { connectionId, integration: conn.integration, err },
          'Token revocation failed (continuing with local cleanup)',
        );
      }
    }
    try {
      await deleteConnectionTokenBundle(tokenRef.vault_ref);
    } catch (err) {
      logger.warn(
        { connectionId, vaultRef: tokenRef.vault_ref, err },
        'Vault token delete failed (continuing with DB cleanup)',
      );
    }
  }

  deleteOAuthTokenRef(connectionId);
  updateConnectionStatus(connectionId, 'revoked');
  deleteConnection(connectionId);

  logger.info({ connectionId, requestedByGroup }, 'Connection disconnected');
}

// --- Resolution (core routing logic) ---

/**
 * Resolve which connection to use for an integration + group.
 *
 * Resolution order:
 * 1. Load app-wide connections for the integration
 * 2. Filter by group access toggle (enabled_for current group)
 * 3. If one account → resolved
 * 4. If multiple → ACCOUNT_SELECTION_REQUIRED
 * 5. If none → INTEGRATION_NOT_CONNECTED
 */
export async function resolve(
  integration: string,
  groupFolder: string,
  preferredConnectionId?: string,
): Promise<ConnectorResolutionResult> {
  const connections = getConnectionsForGroup(groupFolder, integration).filter(
    (c) => c.status === 'connected' || c.status === 'expired',
  );

  if (connections.length === 0) {
    return {
      type: 'INTEGRATION_NOT_CONNECTED',
      integration,
      group_folder: groupFolder,
    };
  }

  // If caller specifies a preferred connection ID
  if (preferredConnectionId) {
    const preferred = connections.find((c) => c.id === preferredConnectionId);
    if (preferred) {
      return resolveConnection(preferred);
    }
  }

  if (connections.length === 1) {
    return resolveConnection(connections[0]);
  }

  return {
    type: 'ACCOUNT_SELECTION_REQUIRED',
    integration,
    accounts: connections.map((c) => ({
      connection_id: c.id,
      account_label: c.account_label,
    })),
  };
}

async function resolveConnection(
  conn: Connection,
): Promise<ConnectorResolutionResult> {
  if (conn.status === 'expired') {
    return {
      type: 'CONNECTION_EXPIRED',
      connection_id: conn.id,
      integration: conn.integration,
    };
  }

  const tokenRef = getOAuthTokenRef(conn.id);
  if (!tokenRef) {
    return {
      type: 'CONNECTOR_PROVIDER_ERROR',
      connection_id: conn.id,
      error: 'Token vault reference not found. Please reconnect.',
    };
  }

  let tokens: OAuthTokens | null;
  try {
    tokens = await getConnectionTokenBundle(tokenRef.vault_ref);
  } catch (err) {
    logger.error(
      { connectionId: conn.id, err },
      'Failed to read token bundle from OneCLI',
    );
    return {
      type: 'CONNECTOR_PROVIDER_ERROR',
      connection_id: conn.id,
      error: 'Token vault read failed. Please reconnect.',
    };
  }
  if (!tokens) {
    return {
      type: 'CONNECTOR_PROVIDER_ERROR',
      connection_id: conn.id,
      error: 'Token vault reference not found. Please reconnect.',
    };
  }

  touchConnectionLastUsed(conn.id);

  return {
    type: 'resolved',
    connection: conn,
    access_token: tokens.access_token,
  };
}

// --- Token refresh ---

/**
 * Refresh expired tokens for all connected connections.
 * Meant to be called from a background job hooked into the host scheduler.
 */
export async function refreshExpiredTokens(): Promise<void> {
  const integrations = listAvailableIntegrations().map((e) => e.integration);

  for (const integration of integrations) {
    const connections = getConnectionsByIntegration(integration).filter(
      (c) => c.status === 'connected' || c.status === 'expired',
    );

    for (const conn of connections) {
      try {
        await refreshConnection(conn);
      } catch (err) {
        logger.warn(
          { connectionId: conn.id, integration, err },
          'Token refresh failed',
        );
      }
    }
  }
}

export async function refreshConnection(conn: Connection): Promise<void> {
  const tokenRef = getOAuthTokenRef(conn.id);
  if (!tokenRef) return;

  // Skip if not expiring soon (within 5 minutes)
  if (conn.expires_at) {
    const expiresAt = new Date(conn.expires_at).getTime();
    const fiveMin = 5 * 60 * 1000;
    if (expiresAt - Date.now() > fiveMin) return;
  } else {
    // No expiry known (e.g., GitHub tokens) — skip refresh
    return;
  }

  let currentTokens: OAuthTokens | null;
  try {
    currentTokens = await getConnectionTokenBundle(tokenRef.vault_ref);
  } catch (err) {
    logger.error(
      { connectionId: conn.id, err },
      'Vault token read failed during refresh; marking expired',
    );
    updateConnectionStatus(conn.id, 'expired');
    return;
  }
  if (!currentTokens) {
    updateConnectionStatus(conn.id, 'expired');
    return;
  }

  if (!currentTokens.refresh_token) {
    updateConnectionStatus(conn.id, 'expired');
    return;
  }

  const provider = getProvider(conn.integration);
  if (!provider) return;

  let newTokens: OAuthTokens;
  try {
    newTokens = await provider.refreshAccessToken(currentTokens.refresh_token);
  } catch {
    updateConnectionStatus(conn.id, 'expired');
    return;
  }

  const expiresAt = newTokens.expires_in
    ? new Date(Date.now() + newTokens.expires_in * 1000).toISOString()
    : null;

  const vaultRef = await putConnectionTokenBundle(conn.id, newTokens);
  storeOAuthTokenRef(conn.id, vaultRef, expiresAt);
  updateConnectionStatus(conn.id, 'connected', { expires_at: expiresAt });

  logger.info(
    { connectionId: conn.id, integration: conn.integration },
    'Token refreshed',
  );
}

// --- Strict cutover: legacy DB token detection ---

/**
 * Detects connections that still have raw tokens in the legacy `oauth_tokens` table
 * (written by a pre-cutover version of NanoClaw) and marks them as expired.
 *
 * Users will need to reconnect those integrations once. This is the intended
 * behaviour under the strict-cutover policy — no silent migration or fallback.
 */
export function applyLegacyTokenCutover(): void {
  const legacyIds = getLegacyTokenConnectionIds();
  const legacyLocalRefIds = getLegacyLocalVaultRefConnectionIds();
  if (legacyIds.length === 0 && legacyLocalRefIds.length === 0) return;

  logger.warn(
    {
      rawTokenCount: legacyIds.length,
      localRefCount: legacyLocalRefIds.length,
    },
    '[CUTOVER] Legacy connector token storage detected. ' +
      'These connections have been marked expired. ' +
      'Users must reconnect each integration once.',
  );

  for (const id of legacyIds) {
    updateConnectionStatus(id, 'expired');
    deleteLegacyTokenRecord(id);
    logger.info(
      { connectionId: id },
      '[CUTOVER] Connection marked expired; legacy token removed',
    );
  }

  for (const id of legacyLocalRefIds) {
    updateConnectionStatus(id, 'expired');
    deleteOAuthTokenRef(id);
    logger.info(
      { connectionId: id },
      '[CUTOVER] Connection marked expired; legacy local token ref removed',
    );
  }
}

// --- Registry helpers (for agents) ---

export function getAvailableIntegrations(): string[] {
  return getRegisteredProviders().map((p) => p.integration);
}

export function getRegistryEntry(
  integration: string,
): ConnectorRegistryEntry | undefined {
  return getConnectorRegistryEntry(integration);
}

// Re-export db-level accessor used by IPC handler
export { getConnectionById } from '../db.js';
