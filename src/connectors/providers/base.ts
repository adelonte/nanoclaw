import { OAuthTokens } from '../../types.js';

export interface ProviderUserInfo {
  id: string;
  label: string;
}

export interface OAuthProvider {
  readonly integration: string;
  readonly displayName: string;

  getAuthUrl(
    state: string,
    redirectUri: string,
    pkceChallenge: string,
  ): string;

  exchangeCode(
    code: string,
    redirectUri: string,
    pkceVerifier: string,
  ): Promise<OAuthTokens>;

  refreshAccessToken(refreshToken: string): Promise<OAuthTokens>;

  getUserInfo(accessToken: string): Promise<ProviderUserInfo>;

  revokeToken(accessToken: string): Promise<void>;
}
