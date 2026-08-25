/**
 * Authentication Routes
 * Handles Salesforce OAuth 2.0 login/callback/logout flow.
 */
const express = require('express');
const router = express.Router();
const salesforceAuth = require('../services/salesforceAuth');

/**
 * GET /api/auth/login
 * Redirect user to Salesforce OAuth login page.
 */
router.get('/login', (req, res) => {
  try {
    const { codeVerifier, codeChallenge } = salesforceAuth.generatePKCE();
    if (req.session) {
      req.session.codeVerifier = codeVerifier;
    }
    const authUrl = salesforceAuth.getAuthorizationUrl(codeChallenge);
    res.json({ authUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate auth URL', details: err.message });
  }
});

/**
 * GET /api/auth/callback
 * Handle Salesforce OAuth callback — exchange code for tokens.
 */
router.get('/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  try {
    const codeVerifier = req.session ? req.session.codeVerifier : null;
    const tokenInfo = await salesforceAuth.handleCallback(code, codeVerifier);
    salesforceAuth.storeTokensInSession(req.session, tokenInfo);

    // Clean up codeVerifier
    if (req.session) {
      delete req.session.codeVerifier;
    }

    // Redirect back to the UI
    res.redirect('/?auth=success');
  } catch (err) {
    console.error('[Auth] Callback error:', err.message);
    res.redirect('/?auth=error&message=' + encodeURIComponent(err.message));
  }
});

/**
 * GET /api/auth/status
 * Check if the user is currently authenticated with Salesforce.
 */
router.get('/status', (req, res) => {
  const authenticated = salesforceAuth.isAuthenticated(req.session);
  const orgInfo = authenticated ? {
    instanceUrl: req.session.sf.instanceUrl,
    userId: req.session.sf.userId,
    orgId: req.session.sf.orgId,
  } : null;

  res.json({ authenticated, orgInfo });
});

const sfCliService = require('../services/sfCliService');

/**
 * GET /api/auth/cli/orgs
 * List all authenticated Salesforce CLI orgs.
 */
router.get('/cli/orgs', async (req, res) => {
  try {
    const orgs = await sfCliService.listCliOrgs();
    res.json({ orgs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list CLI orgs', details: err.message });
  }
});

/**
 * POST /api/auth/cli/connect
 * Connect directly using an org alias or username from Salesforce CLI.
 * Body: { targetOrg: "MyOrg" }
 */
router.post('/cli/connect', async (req, res) => {
  const { targetOrg } = req.body;
  try {
    const authData = await sfCliService.getCliOrgAuth(targetOrg);
    salesforceAuth.storeTokensInSession(req.session, {
      accessToken: authData.accessToken,
      refreshToken: null,
      instanceUrl: authData.instanceUrl,
      userId: authData.username,
      orgId: authData.orgId,
    });
    res.json({ success: true, orgInfo: authData });
  } catch (err) {
    console.error('[Auth] CLI connect error:', err.message);
    res.status(500).json({ error: 'Failed to connect via CLI', details: err.message });
  }
});

/**
 * POST /api/auth/logout
 * Clear Salesforce session and log out.
 */
router.post('/logout', (req, res) => {
  salesforceAuth.clearSession(req.session);
  res.json({ success: true });
});

module.exports = router;
