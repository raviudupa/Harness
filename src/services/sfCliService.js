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
 * Uses `sf org display` for org metadata and `sf org auth show-access-token`
 * for the actual token (since newer CLI versions redact tokens in `sf org display`).
 * @param {string} [targetOrg] - Org alias or username (defaults to default org)
 * @returns {Promise<{accessToken: string, instanceUrl: string, username: string, orgId: string}>}
 */
async function getCliOrgAuth(targetOrg) {
  const targetFlag = targetOrg ? `--target-org "${targetOrg}"` : '';

  // 1. Try `sf org display --verbose --json` which includes accessToken
  const displayCmd = `sf org display --verbose ${targetFlag} --json`;
  let displayOutput = '';
  try {
    displayOutput = await execCommand(displayCmd);
  } catch (e) {
    // Fallback without --verbose
    displayOutput = await execCommand(`sf org display ${targetFlag} --json`);
  }

  const displayMatch = displayOutput.match(/\{[\s\S]*\}/);
  if (!displayMatch) {
    throw new Error('Could not parse sf org display output: ' + displayOutput.slice(0, 200));
  }

  const displayData = JSON.parse(displayMatch[0]);
  if (displayData.status !== 0 || !displayData.result) {
    throw new Error(displayData.message || 'Failed to display org details from sf CLI');
  }

  const orgInfo = displayData.result;

  // If accessToken is already provided by display command
  if (orgInfo.accessToken) {
    return {
      accessToken: orgInfo.accessToken,
      instanceUrl: orgInfo.instanceUrl,
      username: orgInfo.username,
      orgId: orgInfo.id || orgInfo.orgId,
    };
  }

  // 2. Fallback: try `sf org auth show-access-token` if display didn't include it
  try {
    const tokenCmd = `sf org auth show-access-token ${targetFlag} --json`;
    const tokenOutput = await execCommand(tokenCmd);
    const tokenMatch = tokenOutput.match(/\{[\s\S]*\}/);
    if (tokenMatch) {
      const tokenData = JSON.parse(tokenMatch[0]);
      if (tokenData.result?.accessToken) {
        return {
          accessToken: tokenData.result.accessToken,
          instanceUrl: orgInfo.instanceUrl,
          username: orgInfo.username,
          orgId: orgInfo.id || orgInfo.orgId,
        };
      }
    }
  } catch (err) {
    // Continue to next fallback
  }

  // 3. Fallback: Read local auth file (~/.sfdx/ or ~/.sf/)
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const username = orgInfo.username;

  const candidatePaths = [
    path.join(os.homedir(), '.sfdx', `${username}.json`),
    path.join(os.homedir(), '.sf', `${username}.json`),
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        const fileContent = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (fileContent.accessToken) {
          return {
            accessToken: fileContent.accessToken,
            instanceUrl: fileContent.instanceUrl || orgInfo.instanceUrl,
            username: fileContent.username || username,
            orgId: fileContent.orgId || orgInfo.id,
          };
        }
      } catch (e) {
        // Continue
      }
    }
  }

  throw new Error(`Could not find access token for org "${targetOrg || orgInfo.username}". Please try re-authenticating with: sf org login web`);
}

module.exports = {
  listCliOrgs,
  getCliOrgAuth,
};
