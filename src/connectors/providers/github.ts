import { OAuthTokens } from '../../types.js';
import { OAuthProvider, ProviderUserInfo } from './base.js';

const AUTH_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USERINFO_URL = 'https://api.github.com/user';

// GitHub does not support PKCE natively in its OAuth flow, but we accept
// the verifier parameter for API consistency and simply ignore it.
const SCOPES = 'repo read:user';

export class GitHubProvider implements OAuthProvider {
  readonly integration = 'github';
  readonly displayName = 'GitHub';

  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(clientId: string, clientSecret: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  getAuthUrl(
    state: string,
    redirectUri: string,
    _pkceChallenge: string,
  ): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: SCOPES,
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
    _pkceVerifier: string,
  ): Promise<OAuthTokens> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub token exchange failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    if (data.error) {
      throw new Error(
        `GitHub token exchange error: ${data.error_description ?? data.error}`,
      );
    }
    return {
      access_token: data.access_token as string,
      refresh_token: null, // GitHub OAuth Apps don't issue refresh tokens
      token_type: (data.token_type as string | undefined) ?? 'Bearer',
      expires_in: null,
      scope: (data.scope as string | undefined) ?? null,
    };
  }

  async refreshAccessToken(_refreshToken: string): Promise<OAuthTokens> {
    // GitHub OAuth Apps issue non-expiring tokens; GitHub Apps (with fine-grained tokens)
    // do support refresh, but for simplicity we treat GitHub tokens as long-lived.
    throw new Error(
      'GitHub OAuth App tokens do not expire and cannot be refreshed',
    );
  }

  async getUserInfo(accessToken: string): Promise<ProviderUserInfo> {
    const res = await fetch(USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub user info failed (${res.status})`);
    }
    const data = (await res.json()) as { id: number; login: string };
    return { id: String(data.id), label: data.login };
  }

  async revokeToken(_accessToken: string): Promise<void> {
    // GitHub token revocation requires the client secret and a separate API call.
    // For MVP we simply mark the connection revoked in DB without hitting the API.
  }
}
