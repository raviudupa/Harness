/**
 * Salesforce Connection Configuration
 * Manages jsforce OAuth2 settings for connecting to Salesforce orgs.
 */
const jsforce = require('jsforce');

const SF_LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET;
const SF_REDIRECT_URI = process.env.SF_REDIRECT_URI || 'http://localhost:3000/api/auth/callback';
const SF_API_VERSION = '61.0';

/**
 * Create a new jsforce OAuth2 instance for authorization flows.
 */
function createOAuth2() {
  return new jsforce.OAuth2({
    loginUrl: SF_LOGIN_URL,
    clientId: SF_CLIENT_ID,
    clientSecret: SF_CLIENT_SECRET,
    redirectUri: SF_REDIRECT_URI,
  });
}

/**
 * Create an authenticated jsforce connection from stored tokens.
 * @param {string} accessToken - Salesforce access token
 * @param {string} refreshToken - Salesforce refresh token
 * @param {string} instanceUrl - Salesforce instance URL
 * @returns {jsforce.Connection}
 */
function createConnection(accessToken, refreshToken, instanceUrl, session = null) {
  const options = {
    instanceUrl,
    accessToken,
    version: SF_API_VERSION,
  };

  if (refreshToken) {
    options.oauth2 = createOAuth2();
    options.refreshToken = refreshToken;
  }

  const conn = new jsforce.Connection(options);

  if (refreshToken) {
    conn.on('refresh', (newAccessToken) => {
      console.log('[SF] Access token refreshed');
      // Propagate new token back to session so subsequent requests use it
      if (session && session.sf) {
        session.sf.accessToken = newAccessToken;
      }
    });
  }

  return conn;
}

module.exports = {
  SF_LOGIN_URL,
  SF_CLIENT_ID,
  SF_CLIENT_SECRET,
  SF_REDIRECT_URI,
  SF_API_VERSION,
  createOAuth2,
  createConnection,
};
