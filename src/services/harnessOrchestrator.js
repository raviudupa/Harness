/**
 * Harness Orchestrator
 * The main pipeline that ties everything together:
 *   1. Fetch Apex class body + SymbolTable
 *   2. Analyze dependencies (5-layer brain)
 *   3. Generate test class via Claude
 *   4. Deploy to Salesforce
 *   5. Run tests
 *   6. Auto-fix loop if tests fail (up to MAX_FIX_RETRIES)
 *   7. Check code coverage
 *   8. Return final results
 *
 * Enhancements:
 *   - Error history accumulation (Claude sees ALL past failures, not just the last one)
 *   - Existing test class body passed to Claude for improvement
 *   - Code coverage check after tests pass
 *
 * Emits progress events via a callback for real-time UI updates.
 */
const apexClassService = require('./apexClassService');
const dependencyAnalyzer = require('./dependencyAnalyzer');
const claudeService = require('./claudeService');
const testDeployer = require('./testDeployer');

const MIN_FIX_RETRIES = 3;
const MAX_FIX_RETRIES = parseInt(process.env.MAX_FIX_RETRIES || '3', 10);
const MIN_COVERAGE_PERCENT = parseInt(process.env.MIN_COVERAGE_PERCENT || '80', 10);

/**
 * Execute the full harness pipeline for a given Apex class.
 *
 * @param {jsforce.Connection} conn - Authenticated Salesforce connection
 * @param {string} className - Name of the Apex class to generate tests for
 * @param {function} onProgress - Callback for progress updates: (step, message, data) => void
 * @returns {Promise<object>} Final result with test outcomes and generated code
 */
async function executeHarness(conn, className, onProgress = () => {}) {
  const startTime = Date.now();
  const log = [];

  function progress(step, message, data = {}) {
    const entry = { step, message, data, timestamp: Date.now() };
    log.push(entry);
    console.log(`[Harness] [${step}] ${message}`);
    onProgress(step, message, data);
  }

  try {
    // ─── Step 1: Fetch Apex Class ──────────────────────────
    progress('fetch', `Fetching Apex class: ${className}...`);
    const classDetail = await apexClassService.getApexClassDetail(conn, className);
    progress('fetch', `Fetched class (${classDetail.body.length} chars)`, {
      classId: classDetail.id,
      bodyLength: classDetail.body.length,
    });

    // ─── Step 2: Check for existing test class ─────────────
    progress('check', `Checking for existing test class...`);
    const existingTest = await apexClassService.getExistingTestClass(conn, className);
    if (existingTest.exists) {
      progress('check', `Found existing test class: ${existingTest.testClassName}`, {
        testClassName: existingTest.testClassName,
      });
    } else {
      progress('check', 'No existing test class found — will create new.');
    }

    // ─── Step 3: Analyze Dependencies ──────────────────────
    progress('analyze', 'Running 5-layer dependency analysis...');
    const dependencyReport = await dependencyAnalyzer.analyzeClassDependencies(
      conn,
      classDetail.body,
      classDetail.symbolTable,
      className
    );

    const objectCount = Object.keys(dependencyReport.objects).length;
    const totalFields = Object.values(dependencyReport.objects)
      .reduce((sum, obj) => sum + (obj.usedFields?.length || 0), 0);
    const totalVRs = Object.values(dependencyReport.objects)
      .reduce((sum, obj) => sum + (obj.validationRules?.length || 0), 0);
    const totalFlows = Object.values(dependencyReport.objects)
      .reduce((sum, obj) => sum + (obj.recordTriggeredFlows?.length || 0), 0);

    // Log new detections
    const detections = [];
    if (dependencyReport.calloutInfo?.hasCallout) {
      detections.push(`callouts(${dependencyReport.calloutInfo.patterns.join(',')})`);
    }
    if (dependencyReport.interfaceInfo?.interfaces.length > 0) {
      detections.push(`interfaces(${dependencyReport.interfaceInfo.interfaces.join(',')})`);
    }
    if (dependencyReport.annotationInfo?.annotations.length > 0) {
      detections.push(`annotations(${dependencyReport.annotationInfo.annotations.join(',')})`);
    }
    const detectionStr = detections.length > 0 ? `, patterns: ${detections.join(', ')}` : '';

    progress('analyze',
      `Analysis complete: ${objectCount} objects, ${totalFields} fields, ${totalVRs} validation rules, ${totalFlows} flows${detectionStr}`,
      { dependencyReport }
    );

    // ─── Step 4-6: Generate → Deploy → Test → Fix Loop ────
    let attempt = 0;
    let lastResult = null;
    let previousAttempt = null;
    let finalTestClassBody = null;
    let finalTestClassName = null;
    let totalTokensUsed = { input: 0, output: 0 };

    // Error history — accumulates ALL errors across ALL attempts
    const errorHistory = [];

    while (attempt <= MAX_FIX_RETRIES) {
      const isRetry = attempt > 0;
      const label = isRetry ? `Attempt ${attempt + 1}/${MAX_FIX_RETRIES + 1} (auto-fix)` : 'Initial generation';

      // ── Generate / Fix ────────────────────────────────
      progress('generate', `${label}: ${isRetry ? 'Fixing' : 'Generating'} test class via Claude...`);
      const generated = await claudeService.generateTestClass(
        classDetail.body,
        className,
        dependencyReport,
        previousAttempt,
        {
          existingTestBody: attempt === 0 ? (existingTest.testClassBody || null) : null,
          errorHistory: isRetry ? errorHistory : [],
        }
      );

      finalTestClassName = generated.testClassName;
      finalTestClassBody = generated.testClassBody;
      totalTokensUsed.input += generated.tokensUsed.input;
      totalTokensUsed.output += generated.tokensUsed.output;

      progress('generate', `${label}: Test class generated (${finalTestClassBody.length} chars)`, {
        testClassName: finalTestClassName,
        tokensUsed: generated.tokensUsed,
      });

      // ── Deploy ────────────────────────────────────────
      progress('deploy', `${label}: Deploying ${finalTestClassName} to org...`);
      const existingId = existingTest.exists ? existingTest.testClassId : null;
      const deployResult = await testDeployer.deployTestClass(
        conn,
        finalTestClassName,
        finalTestClassBody,
        attempt === 0 ? existingId : lastResult?.classId || existingId
      );

      if (!deployResult.success) {
        progress('deploy', `${label}: Compilation failed — ${deployResult.error}`, {
          error: deployResult.error,
        });

        // Record this error in history
        errorHistory.push({
          attempt: attempt + 1,
          compileError: deployResult.error,
          errors: [],
        });

        // Feed compile error back to Claude
        previousAttempt = {
          testClassBody: finalTestClassBody,
          errors: [],
          compileError: deployResult.error,
        };
        attempt++;
        continue;
      }

      progress('deploy', `${label}: Deployment successful!`, {
        classId: deployResult.classId,
      });

      // Update the existing class ID for subsequent retries
      if (deployResult.classId && !existingTest.testClassId) {
        existingTest.testClassId = deployResult.classId;
      }

      // ── Run Tests ─────────────────────────────────────
      progress('test', `${label}: Running tests...`);
      const testResult = await testDeployer.runTests(conn, finalTestClassName);
      lastResult = { ...testResult, classId: deployResult.classId };

      progress('test', `${label}: Tests complete — ${testResult.summary.passed} passed, ${testResult.summary.failed} failed`, {
        summary: testResult.summary,
        results: testResult.results,
      });

      // ── Check results ─────────────────────────────────
      if (testResult.success) {
        // ── Step 7: Code Coverage Check ─────────────────
        progress('coverage', 'Checking code coverage...');
        const coverage = await testDeployer.getCodeCoverage(conn, className);
        progress('coverage', `Code coverage for ${className}: ${coverage.coveragePercent}% (Target: ${MIN_COVERAGE_PERCENT}%)`, {
          coverage,
          targetPercent: MIN_COVERAGE_PERCENT,
        });

        // If coverage is below target and we have retry attempts left, trigger auto-coverage boost
        if (coverage.coveragePercent < MIN_COVERAGE_PERCENT && attempt < MAX_FIX_RETRIES && coverage.coveragePercent >= 0) {
          progress('coverage', `⚠️ Tests passed, but coverage is ${coverage.coveragePercent}% (below ${MIN_COVERAGE_PERCENT}% requirement). Asking Claude to generate tests for uncovered lines...`, {
            coverage,
            targetPercent: MIN_COVERAGE_PERCENT,
          });

          previousAttempt = {
            testClassBody: finalTestClassBody,
            errors: [],
            compileError: null,
            coverageIssue: {
              currentPercent: coverage.coveragePercent,
              targetPercent: MIN_COVERAGE_PERCENT,
              uncoveredLines: coverage.uncoveredLines || [],
            },
          };

          attempt++;
          continue;
        }

        const targetMet = coverage.coveragePercent >= MIN_COVERAGE_PERCENT;
        const resultMsg = targetMet
          ? `✅ All tests passed with ${coverage.coveragePercent}% coverage (meets ${MIN_COVERAGE_PERCENT}% target)!`
          : `⚠️ All tests passed with ${coverage.coveragePercent}% coverage on attempt ${attempt + 1}.`;

        progress('success', resultMsg, {
          attempts: attempt + 1,
          coverage,
          targetMet,
        });

        return {
          success: true,
          className,
          testClassName: finalTestClassName,
          testClassBody: finalTestClassBody,
          testResults: testResult.results,
          summary: testResult.summary,
          coverage,
          targetPercent: MIN_COVERAGE_PERCENT,
          targetMet,
          dependencyReport,
          attempts: attempt + 1,
          totalTokensUsed,
          duration: Date.now() - startTime,
          log,
        };
      }

      // Tests failed — record in history and set up for retry
      const failures = testResult.results.filter((r) => r.outcome !== 'Pass');

      // Add to error history
      errorHistory.push({
        attempt: attempt + 1,
        compileError: null,
        errors: failures.map((f) => ({
          methodName: f.methodName,
          message: f.message || 'Unknown error',
        })),
      });

      progress('fix', `${label}: ${failures.length} test(s) failed. ${attempt < MAX_FIX_RETRIES ? 'Sending errors to Claude for auto-fix...' : 'Max retries reached.'}`, {
        failures,
      });

      previousAttempt = {
        testClassBody: finalTestClassBody,
        errors: failures,
        compileError: null,
      };

      attempt++;
    }

    // Max retries exhausted
    progress('failed', `❌ Tests still failing after ${MAX_FIX_RETRIES + 1} attempts. Manual fix needed.`, {
      lastResults: lastResult?.results || [],
    });

    return {
      success: false,
      className,
      testClassName: finalTestClassName,
      testClassBody: finalTestClassBody,
      testResults: lastResult?.results || [],
      summary: lastResult?.summary || {},
      dependencyReport,
      attempts: MAX_FIX_RETRIES + 1,
      totalTokensUsed,
      duration: Date.now() - startTime,
      log,
    };

  } catch (err) {
    progress('error', `Fatal error: ${err.message}`, { error: err.stack });
    return {
      success: false,
      className,
      error: err.message,
      stack: err.stack,
      duration: Date.now() - startTime,
      log,
    };
  }
}

module.exports = {
  executeHarness,
};
