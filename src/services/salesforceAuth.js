const crypto = require('crypto');
const { SF_LOGIN_URL, SF_CLIENT_ID, SF_CLIENT_SECRET, SF_REDIRECT_URI, createOAuth2, createConnection } = require('../config/salesforce');

/**
 * Generate PKCE pair (code_verifier and code_challenge)
 */
function generatePKCE() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * Generate the Salesforce OAuth authorization URL with PKCE support.
 * @param {string} codeChallenge - PKCE code challenge
 * @returns {string} Authorization URL to redirect the user to
 */
function getAuthorizationUrl(codeChallenge) {
  const oauth2 = createOAuth2();
  const baseAuthUrl = oauth2.getAuthorizationUrl({
    scope: 'api refresh_token offline_access',
  });

  const url = new URL(baseAuthUrl);
  if (codeChallenge) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }

  return url.toString();
}

/**
 * Handle the OAuth callback — exchange the authorization code for tokens (with PKCE code_verifier).
 * @param {string} code - Authorization code from Salesforce redirect
 * @param {string} [codeVerifier] - PKCE code verifier stored in session
 * @returns {Promise<object>} Token info: { accessToken, refreshToken, instanceUrl, userInfo }
 */
async function handleCallback(code, codeVerifier) {
  const tokenEndpoint = `${SF_LOGIN_URL}/services/oauth2/token`;
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: SF_CLIENT_ID,
    client_secret: SF_CLIENT_SECRET,
    redirect_uri: SF_REDIRECT_URI,
  });

  if (codeVerifier) {
    params.set('code_verifier', codeVerifier);
  }

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    throw new Error(data.error_description || data.error || 'Failed to exchange token');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    instanceUrl: data.instance_url,
    userId: data.id ? data.id.split('/').pop() : null,
    orgId: data.id ? data.id.split('/')[4] : null,
  };
}

/**
 * For CLI-based connections, re-fetch a fresh access token from the Salesforce CLI.
 * This is needed because CLI connections don't store a refresh token, so jsforce
 * cannot auto-refresh expired tokens. The CLI manages its own token lifecycle.
 * @param {object} session - Express session object
 * @returns {Promise<void>}
 */
async function refreshCliToken(session) {
  if (!session || !session.sf || !session.sf.cliTargetOrg) {
    return; // Not a CLI-based connection, nothing to do
  }

  try {
    const sfCliService = require('./sfCliService');
    const authData = await sfCliService.getCliOrgAuth(session.sf.cliTargetOrg);
    session.sf.accessToken = authData.accessToken;
    session.sf.instanceUrl = authData.instanceUrl;
    console.log('[SF] CLI access token refreshed for:', session.sf.cliTargetOrg);
  } catch (err) {
    console.error('[SF] Failed to refresh CLI token:', err.message);
    throw new Error('CLI token refresh failed. Please reconnect via Salesforce CLI.');
  }
}

/**
 * Get an authenticated jsforce connection from session data.
 * For CLI-based connections, automatically re-fetches a fresh token first.
 * @param {object} session - Express session containing SF tokens
 * @returns {Promise<jsforce.Connection|null>}
 */
async function getConnection(session) {
  if (!session || !session.sf) {
    return null;
  }

  // For CLI connections, always refresh the token before creating a connection
  if (session.sf.cliTargetOrg) {
    await refreshCliToken(session);
  }

  const { accessToken, refreshToken, instanceUrl } = session.sf;
  if (!accessToken || !instanceUrl) {
    return null;
  }

  return createConnection(accessToken, refreshToken, instanceUrl, session);
}

/**
 * Store Salesforce tokens in the Express session.
 * @param {object} session - Express session object
 * @param {object} tokenInfo - Token data from handleCallback
 */
function storeTokensInSession(session, tokenInfo) {
  session.sf = {
    accessToken: tokenInfo.accessToken,
    refreshToken: tokenInfo.refreshToken,
    instanceUrl: tokenInfo.instanceUrl,
    userId: tokenInfo.userId,
    orgId: tokenInfo.orgId,
  };

  // Preserve CLI target org identifier if present
  if (tokenInfo.cliTargetOrg) {
    session.sf.cliTargetOrg = tokenInfo.cliTargetOrg;
  }
}

/**
 * Clear Salesforce tokens from the session.
 * @param {object} session - Express session object
 */
function clearSession(session) {
  if (session) {
    delete session.sf;
  }
}

/**
 * Check if the session has valid Salesforce credentials.
 * @param {object} session - Express session object
 * @returns {boolean}
 */
function isAuthenticated(session) {
  return !!(session && session.sf && session.sf.accessToken);
}

module.exports = {
  generatePKCE,
  getAuthorizationUrl,
  handleCallback,
  getConnection,
  refreshCliToken,
  storeTokensInSession,
  clearSession,
  isAuthenticated,
};
