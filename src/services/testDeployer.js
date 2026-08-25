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
      return await deployViaContainer(conn, classId, testClassName, testClassBody);
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
 */
async function deployViaContainer(conn, classId, testClassName, testClassBody) {
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
    IsCheckOnly: false,
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
 * Run Apex tests for a given test class and return results.
 */
async function runTests(conn, testClassName) {
  console.log(`[TestDeployer] Running tests for: ${testClassName}...`);

  try {
    const runResult = await conn.request({
      method: 'POST',
      url: `/services/data/v${SF_API_VERSION}/tooling/runTestsAsynchronous`,
      body: JSON.stringify({
        testLevel: 'RunSpecifiedTests',
        classNames: testClassName,
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
      summary: { error: err.message },
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
  runTests,
  getCodeCoverage,
};
