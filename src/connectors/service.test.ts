import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getLegacyTokenConnectionIds,
  getOAuthTokenRef,
  storeOAuthTokenRef,
  updateConnectionStatus,
} from '../db.js';
import {
  applyLegacyTokenCutover,
  beginAuth,
  disconnect,
  getConnectionStatus,
  handleCallback,
  listForGroup,
  resolve,
  setAccess,
  syncConnectorRegistry,
} from './service.js';
import { _clearProviderRegistry, getProvider, registerProvider } from './providers/index.js';
import { OAuthProvider, ProviderUserInfo } from './providers/base.js';
import { OAuthTokens } from '../types.js';

// --- Mock secret-store to avoid filesystem side effects in tests ---
vi.mock('./secret-store.js', () => ({
  tokenVaultRefForConnection: vi.fn((connectionId: string) => `connector/token/${connectionId}`),
  putConnectionTokenBundle: vi.fn(async (connectionId: string, _tokens: OAuthTokens) => `connector/token/${connectionId}`),
  getConnectionTokenBundle: vi.fn(async (_vaultRef: string): Promise<OAuthTokens | null> => ({
    access_token: 'at_gmail_token',
    refresh_token: 'rt_gmail_token',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'all',
  })),
  deleteConnectionTokenBundle: vi.fn(async (_vaultRef: string): Promise<void> => {}),
  getProviderClientCredentials: vi.fn(),
  cacheProviderClientCredentials: vi.fn(),
  _clearClientCredCache: vi.fn(),
}));

const CALLBACK_BASE = 'http://localhost:3456';

// Minimal mock OAuth provider
function makeMockProvider(integration: string): OAuthProvider & {
  _fail?: { exchange?: boolean; userInfo?: boolean };
} {
  const mock = {
    integration,
    displayName: integration.charAt(0).toUpperCase() + integration.slice(1),
    _fail: {} as { exchange?: boolean; userInfo?: boolean },
    getAuthUrl: vi.fn(
      (state: string, redirectUri: string, _challenge: string) =>
        `https://example.com/oauth?state=${state}&redirect_uri=${redirectUri}`,
    ),
    exchangeCode: vi.fn(
      async (_code: string, _redirect: string, _verifier: string): Promise<OAuthTokens> => {
        if (mock._fail.exchange) throw new Error('exchange failed');
        return {
          access_token: `at_${integration}_token`,
          refresh_token: `rt_${integration}_token`,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'all',
        };
      },
    ),
    refreshAccessToken: vi.fn(async (_rt: string): Promise<OAuthTokens> => ({
      access_token: `at_${integration}_refreshed`,
      refresh_token: `rt_${integration}_token`,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'all',
    })),
    getUserInfo: vi.fn(async (_at: string): Promise<ProviderUserInfo> => {
      if (mock._fail.userInfo) throw new Error('userInfo failed');
      return { id: `user_${integration}_id`, label: `user@${integration}.example.com` };
    }),
    revokeToken: vi.fn(async (_at: string): Promise<void> => {}),
  };
  return mock;
}

beforeEach(() => {
  _initTestDatabase();
  registerProvider(makeMockProvider('gmail'));
  registerProvider(makeMockProvider('github'));
  syncConnectorRegistry();
});

afterEach(() => {
  _closeDatabase();
  _clearProviderRegistry();
  vi.clearAllMocks();
});

// --- beginAuth ---

describe('beginAuth', () => {
  it('creates a pending connection and returns an auth URL', () => {
    const result = beginAuth('gmail', 'email-group', CALLBACK_BASE);

    expect(result.connectionId).toMatch(/^conn_/);
    expect(result.authUrl).toContain('example.com/oauth');
    expect(result.message).toContain(result.authUrl);

    const status = getConnectionStatus(result.connectionId);
    expect(status?.status).toBe('pending');
    expect(status?.integration).toBe('gmail');
  });

  it('auto-grants access to requesting group', () => {
    const { connectionId } = beginAuth('gmail', 'email-group', CALLBACK_BASE);
    expect(getConnectionStatus(connectionId)).toBeDefined();
  });

  it('throws on unknown integration', () => {
    expect(() => beginAuth('unknown-svc', 'main', CALLBACK_BASE)).toThrow(
      'not available',
    );
  });
});

// --- handleCallback ---

describe('handleCallback', () => {
  it('completes connection and stores vault ref metadata (no raw tokens)', async () => {
    // We need to peek at the oauth_sessions state to get the state token.
    // Do this by spying on createOAuthSession or pulling state from the
    // getAuthUrl mock (state is embedded in the URL).
    const result = beginAuth('gmail', 'email-group', CALLBACK_BASE);
    const url = new URL(result.authUrl);
    const state = url.searchParams.get('state')!;

    await handleCallback(state, 'auth-code-123');

    // Connection should be 'connected'
    const status = getConnectionStatus(result.connectionId);
    expect(status?.status).toBe('connected');

    // A vault reference should exist in oauth_token_refs
    const ref = getOAuthTokenRef(result.connectionId);
    expect(ref).toBeDefined();
    expect(ref!.vault_ref).toBe(`connector/token/${result.connectionId}`);
  });

  it('throws on invalid state', async () => {
    await expect(handleCallback('invalid-state', 'code')).rejects.toThrow(
      'Invalid or expired',
    );
  });

  it('marks connection failed and throws on exchange error', async () => {
    const provider = makeMockProvider('gmail');
    provider._fail!.exchange = true;
    _clearProviderRegistry();
    registerProvider(provider);
    syncConnectorRegistry();

    const result = beginAuth('gmail', 'email-group', CALLBACK_BASE);
    const url = new URL(result.authUrl);
    const state = url.searchParams.get('state')!;

    await expect(handleCallback(state, 'bad-code')).rejects.toThrow('exchange failed');

    const status = getConnectionStatus(result.connectionId);
    expect(status?.status).toBe('failed');
  });
});

// --- resolve ---

describe('resolve', () => {
  it('returns INTEGRATION_NOT_CONNECTED when no connections', async () => {
    const result = await resolve('gmail', 'email-group');
    expect(result.type).toBe('INTEGRATION_NOT_CONNECTED');
    if (result.type === 'INTEGRATION_NOT_CONNECTED') {
      expect(result.integration).toBe('gmail');
      expect(result.group_folder).toBe('email-group');
    }
  });

  it('returns INTEGRATION_NOT_CONNECTED when connection exists but group has no access', async () => {
    beginAuth('gmail', 'group-a', CALLBACK_BASE);
    const result = await resolve('gmail', 'group-b');
    expect(result.type).toBe('INTEGRATION_NOT_CONNECTED');
  });

  it('returns resolved access_token after full OAuth callback', async () => {
    const result = beginAuth('gmail', 'email-group', CALLBACK_BASE);
    const url = new URL(result.authUrl);
    const state = url.searchParams.get('state')!;
    await handleCallback(state, 'auth-code-123');

    const resolved = await resolve('gmail', 'email-group');
    expect(resolved.type).toBe('resolved');
    if (resolved.type === 'resolved') {
      expect(resolved.access_token).toBe('at_gmail_token');
    }
  });

  it('returns CONNECTOR_PROVIDER_ERROR when token ref missing', async () => {
    // Manually create a 'connected' connection without a token ref
    const { connectionId } = beginAuth('gmail', 'email-group', CALLBACK_BASE);
    // Force status to 'connected' without a callback (simulating corrupt state)
    updateConnectionStatus(connectionId, 'connected');

    const result = await resolve('gmail', 'email-group');
    // Token ref is absent → provider error
    expect(result.type).toBe('CONNECTOR_PROVIDER_ERROR');
  });
});

// --- setAccess ---

describe('setAccess', () => {
  it('main group can grant access to any group', () => {
    const { connectionId } = beginAuth('gmail', 'group-a', CALLBACK_BASE);
    expect(() =>
      setAccess(connectionId, 'group-b', true, 'main', true),
    ).not.toThrow();
  });

  it('non-main group cannot grant access to other groups', () => {
    const { connectionId } = beginAuth('gmail', 'group-a', CALLBACK_BASE);
    expect(() =>
      setAccess(connectionId, 'group-b', true, 'group-a', false),
    ).toThrow('Only the main group');
  });

  it('non-main group can toggle its own access', () => {
    const { connectionId } = beginAuth('gmail', 'group-a', CALLBACK_BASE);
    expect(() =>
      setAccess(connectionId, 'group-a', false, 'group-a', false),
    ).not.toThrow();
  });

  it('throws on unknown connection ID', () => {
    expect(() =>
      setAccess('nonexistent', 'group-a', true, 'main', true),
    ).toThrow('not found');
  });
});

// --- disconnect ---

describe('disconnect', () => {
  it('non-main group cannot disconnect another group connection', async () => {
    const { connectionId } = beginAuth('gmail', 'group-a', CALLBACK_BASE);
    await expect(disconnect(connectionId, 'group-b', false)).rejects.toThrow(
      'Only the main group',
    );
  });

  it('requesting group can disconnect its own connection', async () => {
    const { connectionId } = beginAuth('gmail', 'group-a', CALLBACK_BASE);
    await expect(disconnect(connectionId, 'group-a', false)).resolves.not.toThrow();
    expect(getConnectionStatus(connectionId)).toBeUndefined();
  });

  it('main group can disconnect any connection', async () => {
    const { connectionId } = beginAuth('gmail', 'group-a', CALLBACK_BASE);
    await expect(disconnect(connectionId, 'main', true)).resolves.not.toThrow();
    expect(getConnectionStatus(connectionId)).toBeUndefined();
  });

  it('throws on unknown connection ID', async () => {
    await expect(disconnect('nonexistent', 'main', true)).rejects.toThrow('not found');
  });

  it('disconnects and calls revokeToken on provider when token ref exists', async () => {
    const result = beginAuth('gmail', 'email-group', CALLBACK_BASE);
    const url = new URL(result.authUrl);
    const state = url.searchParams.get('state')!;
    await handleCallback(state, 'code');

    const gmailProvider = getProvider('gmail');
    await disconnect(result.connectionId, 'email-group', false);

    expect(gmailProvider?.revokeToken).toHaveBeenCalled();
    expect(getOAuthTokenRef(result.connectionId)).toBeUndefined();
  });
});

// --- applyLegacyTokenCutover ---

describe('applyLegacyTokenCutover', () => {
  it('expires connections that have legacy local vault refs', () => {
    const { connectionId } = beginAuth('gmail', 'group-a', CALLBACK_BASE);
    updateConnectionStatus(connectionId, 'connected');
    storeOAuthTokenRef(connectionId, `legacy/local/${connectionId}`);

    applyLegacyTokenCutover();
    expect(getConnectionStatus(connectionId)?.status).toBe('expired');
    expect(getOAuthTokenRef(connectionId)).toBeUndefined();
  });

  it('is idempotent when there are no legacy token records', () => {
    beginAuth('gmail', 'group-a', CALLBACK_BASE);
    expect(() => applyLegacyTokenCutover()).not.toThrow();
    expect(() => applyLegacyTokenCutover()).not.toThrow();
  });

  it('getLegacyTokenConnectionIds returns empty when no legacy records exist', () => {
    beginAuth('gmail', 'group-a', CALLBACK_BASE);
    expect(getLegacyTokenConnectionIds()).toHaveLength(0);
  });
});

// --- syncConnectorRegistry ---

describe('syncConnectorRegistry', () => {
  it('populates connector_registry for all registered providers', async () => {
    const { listAvailableIntegrations } = await import('./service.js');
    const entries = listAvailableIntegrations();
    const integrations = entries.map((e) => e.integration);
    expect(integrations).toContain('gmail');
    expect(integrations).toContain('github');
  });
});
