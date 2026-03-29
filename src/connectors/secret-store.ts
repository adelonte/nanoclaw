/**
 * Connector Secret Store
 *
 * OneCLI-only connector secret model:
 * - OAuth client credentials: connector/client/{integration}
 * - OAuth user token bundles: connector/token/{connectionId}
 *
 * SQLite stores only vault refs and metadata. Raw token payloads are read/write/delete
 * through OneCLI gateway APIs.
 */

import { ONECLI_URL } from '../config.js';
import { logger } from '../logger.js';
import { OAuthTokens } from '../types.js';

export interface ProviderClientCredentials {
  clientId: string;
  clientSecret: string;
}

const CLIENT_CRED_CACHE = new Map<string, ProviderClientCredentials>();

type OneCliSecretItem = {
  id?: string;
  name?: string;
  value?: string;
};

async function onecliFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ONECLI_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: init?.signal ?? AbortSignal.timeout(5000),
  });
}

function parseSecretsPayload(payload: unknown): OneCliSecretItem[] {
  if (Array.isArray(payload)) return payload as OneCliSecretItem[];
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;
  for (const key of ['secrets', 'items', 'data']) {
    if (Array.isArray(obj[key])) return obj[key] as OneCliSecretItem[];
  }
  return [];
}

async function listOneCliSecrets(): Promise<OneCliSecretItem[]> {
  const res = await onecliFetch('/api/secrets', { method: 'GET' });
  if (!res.ok) {
    throw new Error(`OneCLI secrets list failed (${res.status})`);
  }
  const payload = (await res.json()) as unknown;
  return parseSecretsPayload(payload);
}

async function readSecretValue(name: string): Promise<string | null> {
  const secrets = await listOneCliSecrets();
  const item = secrets.find((s) => s.name === name);
  return item?.value ?? null;
}

async function upsertSecretValue(name: string, value: string): Promise<void> {
  const createBody = JSON.stringify({
    name,
    type: 'api_key',
    value,
  });

  // Try create/upsert endpoint first.
  const postRes = await onecliFetch('/api/secrets', {
    method: 'POST',
    body: createBody,
  });
  if (postRes.ok) return;

  // Fallback to direct update endpoint by name.
  const putRes = await onecliFetch(`/api/secrets/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
  if (putRes.ok) return;

  throw new Error(
    `Failed to upsert OneCLI secret "${name}" (POST=${postRes.status}, PUT=${putRes.status})`,
  );
}

async function deleteSecretValue(name: string): Promise<void> {
  // Try delete-by-name endpoint.
  const delByName = await onecliFetch(`/api/secrets/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (delByName.ok || delByName.status === 404) return;

  // Fallback: list secrets and delete by id if available.
  const secrets = await listOneCliSecrets();
  const item = secrets.find((s) => s.name === name);
  if (!item?.id) return;
  const delById = await onecliFetch(`/api/secrets/${encodeURIComponent(item.id)}`, {
    method: 'DELETE',
  });
  if (!delById.ok && delById.status !== 404) {
    throw new Error(`Failed to delete OneCLI secret "${name}" (${delById.status})`);
  }
}

export function tokenVaultRefForConnection(connectionId: string): string {
  return `connector/token/${connectionId}`;
}

export async function putConnectionTokenBundle(
  connectionId: string,
  tokens: OAuthTokens,
): Promise<string> {
  const vaultRef = tokenVaultRefForConnection(connectionId);
  await upsertSecretValue(vaultRef, JSON.stringify(tokens));
  return vaultRef;
}

export async function getConnectionTokenBundle(vaultRef: string): Promise<OAuthTokens | null> {
  const raw = await readSecretValue(vaultRef);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OAuthTokens;
  } catch {
    logger.warn({ vaultRef }, 'Invalid token bundle JSON in OneCLI vault');
    return null;
  }
}

export async function deleteConnectionTokenBundle(vaultRef: string): Promise<void> {
  await deleteSecretValue(vaultRef);
}

export async function getProviderClientCredentials(
  integration: string,
): Promise<ProviderClientCredentials> {
  if (CLIENT_CRED_CACHE.has(integration)) {
    return CLIENT_CRED_CACHE.get(integration)!;
  }

  const secretName = `connector/client/${integration}`;

  let value: string | null = null;
  try {
    value = await readSecretValue(secretName);
  } catch (err) {
    logger.debug(
      { integration, err },
      'OneCLI gateway unreachable for client credential lookup',
    );
  }

  if (value) {
    try {
      const creds = JSON.parse(value) as ProviderClientCredentials;
      if (creds.clientId && creds.clientSecret) {
        CLIENT_CRED_CACHE.set(integration, creds);
        logger.debug({ integration }, 'Loaded provider client credentials from OneCLI');
        return creds;
      }
    } catch {
      // malformed value — fall through
    }
  }

  throw new Error(
    `No client credentials found in OneCLI for integration "${integration}".\n` +
      `Register them with:\n` +
      `  onecli secrets create \\\n` +
      `    --name ${secretName} \\\n` +
      `    --type api_key \\\n` +
      `    --value '{"clientId":"YOUR_CLIENT_ID","clientSecret":"YOUR_CLIENT_SECRET"}'`,
  );
}

export function cacheProviderClientCredentials(
  integration: string,
  creds: ProviderClientCredentials,
): void {
  CLIENT_CRED_CACHE.set(integration, creds);
}

export function _clearClientCredCache(): void {
  CLIENT_CRED_CACHE.clear();
}
