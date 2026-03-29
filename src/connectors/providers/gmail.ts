import { OAuthTokens } from '../../types.js';
import { OAuthProvider, ProviderUserInfo } from './base.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

export class GmailProvider implements OAuthProvider {
  readonly integration = 'gmail';
  readonly displayName = 'Gmail';

  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(clientId: string, clientSecret: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  getAuthUrl(state: string, redirectUri: string, pkceChallenge: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      state,
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: pkceChallenge,
      code_challenge_method: 'S256',
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
    pkceVerifier: string,
  ): Promise<OAuthTokens> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code_verifier: pkceVerifier,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gmail token exchange failed (${res.status}): ${body}`);
    }
    return this.parseTokenResponse(await res.json() as Record<string, unknown>);
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gmail token refresh failed (${res.status}): ${body}`);
    }
    const data = await res.json() as Record<string, unknown>;
    return this.parseTokenResponse({ refresh_token: refreshToken, ...data });
  }

  async getUserInfo(accessToken: string): Promise<ProviderUserInfo> {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Gmail userinfo failed (${res.status})`);
    }
    const data = await res.json() as { id: string; email: string };
    return { id: data.id, label: data.email };
  }

  async revokeToken(accessToken: string): Promise<void> {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
    });
  }

  private parseTokenResponse(data: Record<string, unknown>): OAuthTokens {
    return {
      access_token: data.access_token as string,
      refresh_token: (data.refresh_token as string | undefined) ?? null,
      token_type: (data.token_type as string | undefined) ?? 'Bearer',
      expires_in: (data.expires_in as number | undefined) ?? null,
      scope: (data.scope as string | undefined) ?? null,
    };
  }
}
