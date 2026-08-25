/**
 * Salesforce CLI (sf / sfdx) Integration Service
 * Automatically detects and connects to orgs authenticated via Salesforce CLI.
 */
const { exec } = require('child_process');

function execCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const output = stdout || stderr || '';
      if (output) {
        resolve(output);
      } else if (error) {
        reject(error);
      } else {
        resolve('');
      }
    });
  });
}

/**
 * List all authenticated orgs from Salesforce CLI.
 * @returns {Promise<Array<{alias: string, username: string, orgId: string, instanceUrl: string, isDefault: boolean}>>}
 */
async function listCliOrgs() {
  try {
    const rawOutput = await execCommand('sf org list --skip-connection-status --json');
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not parse sf org list output');
    }

    const data = JSON.parse(jsonMatch[0]);
    const result = data.result || {};
    const orgs = [];
    const all = [];

    for (const key of Object.keys(result)) {
      if (Array.isArray(result[key])) {
        all.push(...result[key]);
      }
    }

    const seen = new Set();

    for (const org of all) {
      if (org.username && !seen.has(org.username)) {
        seen.add(org.username);
        orgs.push({
          alias: org.alias || org.username,
          username: org.username,
          orgId: org.orgId || org.id,
          instanceUrl: org.instanceUrl,
          isDefault: org.isDefaultUsername || false,
          isDevHub: org.isDevHub || false,
          isSandbox: org.isSandbox || false,
        });
      }
    }

    return orgs;
  } catch (err) {
    console.error('[SFCliService] Error listing CLI orgs:', err.message);
    return [];
  }
}

/**
 * Get access token and instance URL for a specific org alias or username via CLI.
 * @param {string} [targetOrg] - Org alias or username (defaults to default org)
 * @returns {Promise<{accessToken: string, instanceUrl: string, username: string, orgId: string}>}
 */
async function getCliOrgAuth(targetOrg) {
  const targetFlag = targetOrg ? `--target-org "${targetOrg}"` : '';
  const cmd = `sf org display ${targetFlag} --json`;

  const rawOutput = await execCommand(cmd);
  const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Could not parse sf org display output');
  }

  const data = JSON.parse(jsonMatch[0]);
  if (data.status !== 0 || !data.result) {
    throw new Error(data.message || 'Failed to display org details from sf CLI');
  }

  const res = data.result;
  return {
    accessToken: res.accessToken,
    instanceUrl: res.instanceUrl,
    username: res.username,
    orgId: res.id,
  };
}

module.exports = {
  listCliOrgs,
  getCliOrgAuth,
};
