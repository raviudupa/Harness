/**
 * Test Deployer Service
 * Deploys test classes to the Salesforce org via the Tooling API
 * and runs tests via runTestsAsynchronous.
 */
const { SF_API_VERSION } = require('../config/salesforce');

/**
 * Deploy an Apex test class to the org via Tooling API.
 * Uses direct Tooling SObject create/update or MetadataContainer.
 *
 * @param {jsforce.Connection} conn
 * @param {string} testClassName - Name of the test class
 * @param {string} testClassBody - Full Apex source code
 * @param {string|null} existingClassId - If updating, the existing ApexClass Id
 * @returns {Promise<{success: boolean, classId: string|null, error: string|null}>}
 */
async function deployTestClass(conn, testClassName, testClassBody, existingClassId = null) {
  console.log(`[TestDeployer] Deploying test class: ${testClassName}...`);

  try {
    // 1. Check if the class already exists in the org
    let classId = existingClassId;
    if (!classId) {
      const existing = await conn.tooling.query(
        `SELECT Id FROM ApexClass WHERE Name = '${testClassName}' AND NamespacePrefix = null`
      );
      if (existing.records && existing.records.length > 0) {
        classId = existing.records[0].Id;
      }
    }

    if (!classId) {
      // ── Create New Class via Tooling SObject Create ──────────
      console.log(`[TestDeployer] Creating new ApexClass '${testClassName}'...`);
      const createRes = await conn.tooling.sobject('ApexClass').create({
        Name: testClassName,
        Body: testClassBody,
        ApiVersion: parseFloat(SF_API_VERSION),
        Status: 'Active',
      });

      if (createRes.success) {
        console.log(`[TestDeployer] Created ApexClass: ${createRes.id}`);
        return { success: true, classId: createRes.id, error: null };
      } else {
        const errorMsg = (createRes.errors || []).map((e) => e.message).join('\n') || 'Failed to create ApexClass';
        console.error(`[TestDeployer] ApexClass creation failed: ${errorMsg}`);
        return { success: false, classId: null, error: errorMsg };
      }
    } else {
      // ── Update Existing Class via MetadataContainer ──────────
      console.log(`[TestDeployer] Updating existing ApexClass ${classId} via MetadataContainer...`);
      return await deployViaContainer(conn, classId, testClassName, testClassBody, false);
    }

  } catch (err) {
    console.error(`[TestDeployer] Deployment exception: ${err.message}`);
    return {
      success: false,
      classId: existingClassId,
      error: err.message,
    };
  }
}

/**
 * Deploy update via MetadataContainer + ContainerAsyncRequest
 * @param {boolean} checkOnly - When true, compile only and never save changes
 */
async function deployViaContainer(conn, classId, testClassName, testClassBody, checkOnly = false) {
  const containerName = `Container_${Date.now()}`;
  const container = await conn.tooling.sobject('MetadataContainer').create({
    Name: containerName,
  });

  if (!container.success) {
    throw new Error(`Failed to create MetadataContainer: ${JSON.stringify(container.errors)}`);
  }
  const containerId = container.id;

  // Create ApexClassMember
  const member = await conn.tooling.sobject('ApexClassMember').create({
    MetadataContainerId: containerId,
    ContentEntityId: classId,
    Body: testClassBody,
  });

  if (!member.success) {
    throw new Error(`Failed to create ApexClassMember: ${JSON.stringify(member.errors)}`);
  }

  // Submit request
  const asyncReq = await conn.tooling.sobject('ContainerAsyncRequest').create({
    MetadataContainerId: containerId,
    IsCheckOnly: checkOnly,
  });

  if (!asyncReq.success) {
    throw new Error(`Failed to submit deployment: ${JSON.stringify(asyncReq.errors)}`);
  }

  return await pollContainerAsyncRequest(conn, asyncReq.id, classId);
}

/**
 * Poll the ContainerAsyncRequest until complete or failed.
 */
async function pollContainerAsyncRequest(conn, requestId, classId) {
  const maxPolls = 30;
  const pollIntervalMs = 2000;

  for (let i = 0; i < maxPolls; i++) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    const result = await conn.tooling.query(
      `SELECT Id, State, ErrorMsg, DeployDetails
       FROM ContainerAsyncRequest
       WHERE Id = '${requestId}'`
    );

    const record = result.records?.[0];
    if (!record) throw new Error('ContainerAsyncRequest record not found');

    if (record.State === 'Completed') {
      return { success: true, classId, error: null };
    }

    if (record.State === 'Failed') {
      let errorMsg = record.ErrorMsg || 'Compilation failed';
      if (record.DeployDetails) {
        try {
          const details = typeof record.DeployDetails === 'string'
            ? JSON.parse(record.DeployDetails)
            : record.DeployDetails;
          if (details.componentFailures) {
            const failures = Array.isArray(details.componentFailures)
              ? details.componentFailures
              : [details.componentFailures];
            errorMsg = failures.map((f) =>
              `Line ${f.lineNumber || '?'}: ${f.problem || f.message || 'Error'}`
            ).join('\n');
          }
        } catch (e) {}
      }
      return { success: false, classId, error: errorMsg };
    }

    if (record.State === 'Error') {
      return { success: false, classId, error: record.ErrorMsg || 'Async deploy error' };
    }
  }

  return { success: false, classId, error: 'Deployment timed out' };
}

/**
 * Pre-flight check: verify the class under test actually compiles in the org.
 *
 * Performs a check-only compile of the class's own, unmodified body. Nothing is
 * saved. If this fails, the class is already broken in the org and no generated
 * test class can ever deploy against it — so the harness should stop before
 * spending any money on the LLM.
 *
 * @param {jsforce.Connection} conn
 * @param {string} className
 * @param {string} classId - ApexClass Id of the class under test
 * @param {string} classBody - Current source body of the class
 * @returns {Promise<{compiles: boolean, error: string|null}>}
 */
async function verifySourceClassCompiles(conn, className, classId, classBody) {
  console.log(`[TestDeployer] Pre-flight compile check for ${className}...`);

  if (!classId || !classBody) {
    return { compiles: true, error: null };
  }

  try {
    const result = await deployViaContainer(conn, classId, className, classBody, true);
    if (result.success) {
      console.log(`[TestDeployer] Pre-flight OK: ${className} compiles cleanly.`);
      return { compiles: true, error: null };
    }
    console.error(`[TestDeployer] Pre-flight FAILED for ${className}: ${result.error}`);
    return { compiles: false, error: result.error };
  } catch (err) {
    // Never block the pipeline because the check itself could not run
    console.warn(`[TestDeployer] Pre-flight check could not run for ${className}: ${err.message}`);
    return { compiles: true, error: null };
  }
}

// Minimum API version required for specific fields/features that commonly
// break compilation on classes left on old API versions.
const API_VERSION_REQUIREMENTS = [
  { pattern: /No such column '?DeveloperName'? on entity '?RecordType'?/i, field: 'RecordType.DeveloperName', minVersion: 43.0 },
  { pattern: /No such column '?SObjectType'?/i, field: 'SObjectType on RecordType', minVersion: 43.0 },
];

/**
 * Turn a raw Apex compile error into concrete, actionable fix suggestions.
 *
 * @param {string} errorMsg - Raw compile error from Salesforce
 * @param {number|null} apiVersion - ApiVersion of the offending class
 * @returns {{hints: string[], likelyCause: string|null}}
 */
function diagnoseCompileError(errorMsg, apiVersion = null) {
  const msg = errorMsg || '';
  const hints = [];
  let likelyCause = null;

  // 1. Old API version blocking a newer field/feature
  for (const req of API_VERSION_REQUIREMENTS) {
    if (req.pattern.test(msg)) {
      if (apiVersion != null && apiVersion < req.minVersion) {
        likelyCause = `The class is on API version ${apiVersion}, but '${req.field}' requires ${req.minVersion}+.`;
        hints.push(`Raise the class ApiVersion to ${req.minVersion} or higher (Setup → Apex Classes → Edit, or update the .cls-meta.xml <apiVersion>).`);
      } else {
        hints.push(`'${req.field}' requires API version ${req.minVersion}+. Verify the class ApiVersion.`);
      }
      hints.push(`Alternatively, remove '${req.field}' from the query and resolve it via Schema describe calls instead.`);
    }
  }

  // 2. Missing field / no access
  const columnMatch = /No such column '?([A-Za-z0-9_]+)'? on (?:entity|table) '?([A-Za-z0-9_]+)'?/i.exec(msg);
  if (columnMatch && hints.length === 0) {
    const [, field, entity] = columnMatch;
    likelyCause = `Field '${field}' is not visible on '${entity}' for this class or user.`;
    hints.push(`Confirm '${field}' exists on '${entity}' and is spelled correctly (custom fields need the '__c' suffix).`);
    hints.push(`Check field-level security — the integration user may lack read access to '${entity}.${field}'.`);
  }

  // 3. Missing type
  const typeMatch = /Invalid type:\s*([A-Za-z0-9_.]+)/i.exec(msg);
  if (typeMatch) {
    const type = typeMatch[1];
    likelyCause = likelyCause || `Type '${type}' does not exist in this org.`;
    hints.push(`'${type}' is not available in this org — check for a missing managed package, a deleted object, or a required namespace prefix.`);
  }

  // 4. Signature drift
  const methodMatch = /Method does not exist or incorrect signature:\s*(?:void\s+)?([A-Za-z0-9_]+)/i.exec(msg);
  if (methodMatch) {
    likelyCause = likelyCause || `Method '${methodMatch[1]}' does not match any existing signature.`;
    hints.push(`Verify the signature of '${methodMatch[1]}' (name, parameter types and order, static vs instance, and its access modifier).`);
  }

  // 5. Broken dependency chain
  const dependentMatch = /Dependent class is invalid and needs recompilation:\s*Class\s+([A-Za-z0-9_]+)/i.exec(msg);
  if (dependentMatch) {
    hints.push(`Fix '${dependentMatch[1]}' first — compile errors cascade, so start with the innermost broken class.`);
  }

  if (hints.length === 0) {
    hints.push('Open the class in Setup → Apex Classes and save it; the inline compiler will pinpoint the failing line.');
  }

  return { hints, likelyCause };
}

/**
 * Classify a deployment error to determine whether it originates from the
 * generated test class or from a pre-existing compile problem in another class.
 *
 * Deploying a test class forces Salesforce to recompile every class it touches.
 * If the class under test is already broken in the org, the deploy fails with an
 * error that has nothing to do with the generated test — retrying with a new
 * test class can never fix it.
 *
 * @param {string} errorMsg - Error text returned by deployTestClass
 * @param {string} testClassName - Name of the generated test class
 * @returns {{fatal: boolean, offendingClass: string|null, reason: string|null}}
 */
function classifyDeployError(errorMsg, testClassName) {
  const msg = errorMsg || '';

  const dependentMatch = /Dependent class is invalid and needs recompilation:\s*Class\s+([A-Za-z0-9_]+)/i.exec(msg);
  if (dependentMatch && dependentMatch[1] !== testClassName) {
    const offendingClass = dependentMatch[1];
    return {
      fatal: true,
      offendingClass,
      reason: `The class '${offendingClass}' does not compile in this org. `
        + 'This is a pre-existing org/metadata problem, not a defect in the generated test class, '
        + 'so regenerating the test cannot resolve it. Fix the compile error in '
        + `'${offendingClass}' (or its API version) and re-run the harness.`,
    };
  }

  return { fatal: false, offendingClass: null, reason: null };
}

/**
 * Run Apex tests for a given test class and return results.
 * @param {jsforce.Connection} conn
 * @param {string} testClassName - Name of the test class (for logging)
 * @param {string} classId - The Salesforce ApexClass Id (18-char)
 */
async function runTests(conn, testClassName, classId) {
  console.log(`[TestDeployer] Running tests for: ${testClassName} (${classId})...`);

  try {
    const runResult = await conn.request({
      method: 'POST',
      url: `/services/data/v${SF_API_VERSION}/tooling/runTestsAsynchronous`,
      body: JSON.stringify({
        testLevel: 'RunSpecifiedTests',
        classids: classId,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const testRunId = typeof runResult === 'string' ? runResult : runResult.toString();
    console.log(`[TestDeployer] Test run job ID: ${testRunId}`);

    return await pollTestResults(conn, testRunId);
  } catch (err) {
    console.error(`[TestDeployer] Test run error: ${err.message}`);
    return {
      success: false,
      results: [],
      summary: { total: 0, passed: 0, failed: 0, errors: 0, error: err.message },
    };
  }
}

/**
 * Poll ApexTestQueueItem and retrieve ApexTestResult.
 */
async function pollTestResults(conn, testRunId) {
  const maxPolls = 60;
  const pollIntervalMs = 2500;

  for (let i = 0; i < maxPolls; i++) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    const queueResult = await conn.tooling.query(
      `SELECT Id, Status, ApexClassId
       FROM ApexTestQueueItem
       WHERE ParentJobId = '${testRunId}'`
    );

    const items = queueResult.records || [];
    const allDone = items.length > 0 && items.every((item) =>
      ['Completed', 'Failed', 'Aborted'].includes(item.Status)
    );

    if (allDone) {
      const resultQuery = await conn.tooling.query(
        `SELECT Id, ApexClassId, MethodName, Outcome, Message, StackTrace, RunTime
         FROM ApexTestResult
         WHERE AsyncApexJobId = '${testRunId}'`
      );

      const results = (resultQuery.records || []).map((r) => ({
        methodName: r.MethodName,
        outcome: r.Outcome,
        message: r.Message || null,
        stackTrace: r.StackTrace || null,
        runTime: r.RunTime,
      }));

      const passed = results.filter((r) => r.outcome === 'Pass').length;
      const failed = results.filter((r) => r.outcome === 'Fail').length;
      const errors = results.filter((r) => r.outcome === 'CompileFail').length;

      return {
        success: failed === 0 && errors === 0 && results.length > 0,
        results,
        summary: {
          total: results.length,
          passed,
          failed,
          errors,
        },
      };
    }
  }

  return {
    success: false,
    results: [],
    summary: { error: 'Test execution timed out' },
  };
}

/**
 * Get code coverage for a specific Apex class after tests have been run.
 * @param {jsforce.Connection} conn
 * @param {string} className - Name of the class under test (not the test class)
 * @returns {Promise<{coveragePercent: number, linesCovered: number, linesUncovered: number, totalLines: number}>}
 */
async function getCodeCoverage(conn, className) {
  try {
    const result = await conn.tooling.query(
      `SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered, Coverage
       FROM ApexCodeCoverageAggregate
       WHERE ApexClassOrTrigger.Name = '${className}'`
    );

    if (result.records && result.records.length > 0) {
      const rec = result.records[0];
      const covered = rec.NumLinesCovered || 0;
      const uncovered = rec.NumLinesUncovered || 0;
      const total = covered + uncovered;
      const percent = total > 0 ? Math.round((covered / total) * 100) : 0;
      const coverageData = rec.Coverage || {};

      return {
        coveragePercent: percent,
        linesCovered: covered,
        linesUncovered: uncovered,
        totalLines: total,
        uncoveredLines: coverageData.uncoveredLines || [],
        coveredLines: coverageData.coveredLines || [],
      };
    }

    return {
      coveragePercent: 0,
      linesCovered: 0,
      linesUncovered: 0,
      totalLines: 0,
      uncoveredLines: [],
      coveredLines: [],
    };
  } catch (err) {
    console.warn(`[TestDeployer] Could not fetch coverage for ${className}:`, err.message);
    return {
      coveragePercent: -1,
      linesCovered: 0,
      linesUncovered: 0,
      totalLines: 0,
      uncoveredLines: [],
      coveredLines: [],
    };
  }
}

module.exports = {
  deployTestClass,
  verifySourceClassCompiles,
  diagnoseCompileError,
  classifyDeployError,
  runTests,
  getCodeCoverage,
};
