import { logger } from '../../logger.js';
import { getProviderClientCredentials } from '../secret-store.js';
import { OAuthProvider } from './base.js';
import { GitHubProvider } from './github.js';
import { GmailProvider } from './gmail.js';

export { OAuthProvider } from './base.js';
export { GmailProvider } from './gmail.js';
export { GitHubProvider } from './github.js';

const registry = new Map<string, OAuthProvider>();

export function registerProvider(provider: OAuthProvider): void {
  registry.set(provider.integration, provider);
}

export function getProvider(integration: string): OAuthProvider | undefined {
  return registry.get(integration);
}

export function getRegisteredProviders(): OAuthProvider[] {
  return Array.from(registry.values());
}

/**
 * Loads OAuth client credentials for each built-in provider from OneCLI and
 * registers providers that have secrets available.
 *
 * Credentials must be stored in OneCLI before starting NanoClaw:
 *   onecli secrets create \
 *     --name connector/client/gmail \
 *     --type api_key \
 *     --value '{"clientId":"...","clientSecret":"..."}'
 *
 * Providers whose credentials are not found in OneCLI are skipped with a
 * warning. This allows running without Gmail if only GitHub is configured, etc.
 * If NO providers load, a prominent warning is emitted but startup continues —
 * connector features will simply be unavailable.
 */
export async function initDefaultProviders(): Promise<void> {
  const candidates: Array<{
    integration: string;
    factory: (clientId: string, clientSecret: string) => OAuthProvider;
  }> = [
    { integration: 'gmail', factory: (id, secret) => new GmailProvider(id, secret) },
    { integration: 'github', factory: (id, secret) => new GitHubProvider(id, secret) },
  ];

  let loaded = 0;

  for (const { integration, factory } of candidates) {
    try {
      const { clientId, clientSecret } = await getProviderClientCredentials(integration);
      registerProvider(factory(clientId, clientSecret));
      logger.info({ integration }, 'Connector provider registered');
      loaded++;
    } catch (err) {
      // Credentials absent or OneCLI unreachable — provider unavailable
      logger.warn(
        { integration, hint: (err as Error).message },
        'Connector provider not loaded (credentials not found in OneCLI)',
      );
    }
  }

  if (loaded === 0) {
    logger.info(
      'No connector providers loaded. This is OK during initial setup. ' +
        'Add provider credentials later in OneCLI to enable connectors:\n' +
        '  onecli secrets create --name connector/client/<integration> ' +
        '--type api_key --value \'{"clientId":"...","clientSecret":"..."}\'',
    );
  }
}

/** @internal - for tests: directly register a provider without OneCLI. */
export function _registerProviderDirect(provider: OAuthProvider): void {
  registry.set(provider.integration, provider);
}

/** @internal - for tests. */
export function _clearProviderRegistry(): void {
  registry.clear();
}
