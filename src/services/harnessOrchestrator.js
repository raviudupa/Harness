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
const auditLogger = require('./auditLogger');

const MIN_FIX_RETRIES = 3;
const MAX_FIX_RETRIES = parseInt(process.env.MAX_FIX_RETRIES || '3', 10);
const MIN_COVERAGE_PERCENT = parseInt(process.env.MIN_COVERAGE_PERCENT || '80', 10);
const PREFLIGHT_COMPILE_CHECK = process.env.PREFLIGHT_COMPILE_CHECK !== 'false';

// ─── Claude Pricing (per 1M tokens) ──────────────────────
// Pricing table: model prefix → { input, output } in USD per 1M tokens
const MODEL_PRICING = {
  'claude-opus-5':             { input: 15.00, output: 75.00 },
  'claude-opus-4':             { input: 15.00, output: 75.00 },
  'claude-sonnet-5':           { input: 4.00,  output: 20.00 },
  'claude-sonnet-4':           { input: 4.00,  output: 20.00 },
  'claude-3-7-sonnet':         { input: 3.00,  output: 15.00 },
  'claude-3-5-sonnet':         { input: 3.00,  output: 15.00 },
  'claude-3-5-haiku':          { input: 0.80,  output: 4.00 },
  'claude-3-opus':             { input: 15.00, output: 75.00 },
  'claude-3-sonnet':           { input: 3.00,  output: 15.00 },
  'claude-3-haiku':            { input: 0.25,  output: 1.25 },
};

/**
 * Calculate estimated cost in USD from token usage.
 * @param {{ input: number, output: number }} tokens
 * @param {string} model - The model identifier
 * @returns {{ inputCost: number, outputCost: number, totalCost: number, model: string }}
 */
function calculateCost(tokens, model) {
  // Find the best matching pricing entry
  let pricing = null;
  const modelLower = (model || '').toLowerCase();
  for (const [prefix, rates] of Object.entries(MODEL_PRICING)) {
    if (modelLower.includes(prefix) || modelLower.startsWith(prefix)) {
      pricing = rates;
      break;
    }
  }
  // Fallback: use sonnet pricing as default
  if (!pricing) pricing = { input: 4.00, output: 20.00 };

  const inputCost = (tokens.input / 1_000_000) * pricing.input;
  const outputCost = (tokens.output / 1_000_000) * pricing.output;
  return {
    inputCost: Math.round(inputCost * 1_000_000) / 1_000_000,
    outputCost: Math.round(outputCost * 1_000_000) / 1_000_000,
    totalCost: Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000,
    model: model || 'unknown',
    pricingUsed: pricing,
  };
}

/**
 * Execute the full harness pipeline for a given Apex class.
 *
 * @param {jsforce.Connection} conn - Authenticated Salesforce connection
 * @param {string} className - Name of the Apex class to generate tests for
 * @param {function} onProgress - Callback for progress updates: (step, message, data) => void
 * @param {object} [options] - Additional options (e.g. { model: 'claude-sonnet-5' })
 * @returns {Promise<object>} Final result with test outcomes and generated code
 */
async function executeHarness(conn, className, onProgress = () => {}, options = {}) {
  const startTime = Date.now();
  const log = [];
  const targetModel = options.model || process.env.CLAUDE_MODEL || 'claude-opus-5';

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

    // ─── Step 1.5: Pre-flight compile check ────────────────
    // A broken class under test can never have a deployable test class, so fail
    // fast here instead of burning LLM calls on an unfixable error.
    if (PREFLIGHT_COMPILE_CHECK) {
      progress('preflight', `Verifying ${className} compiles in the org...`);
      const preflight = await testDeployer.verifySourceClassCompiles(
        conn,
        className,
        classDetail.id,
        classDetail.body
      );

      if (!preflight.compiles) {
        const diagnosis = testDeployer.diagnoseCompileError(preflight.error, classDetail.apiVersion);
        const reason = `'${className}' does not compile in this org. `
          + 'Fix the compile error below and re-run the harness — no test class can be '
          + 'deployed against a broken class, so generation was skipped (no AI cost incurred).';

        progress('failed', `❌ Pre-flight failed: ${reason}`, {
          error: preflight.error,
          offendingClass: className,
          apiVersion: classDetail.apiVersion,
          likelyCause: diagnosis.likelyCause,
          hints: diagnosis.hints,
          unfixableByAI: true,
        });

        if (diagnosis.likelyCause) {
          console.error(`[Harness] Likely cause: ${diagnosis.likelyCause}`);
        }
        diagnosis.hints.forEach((h, i) => console.error(`[Harness] Fix ${i + 1}: ${h}`));

        return {
          success: false,
          className,
          testClassName: null,
          testClassBody: null,
          testResults: [],
          summary: { compileError: preflight.error },
          unfixableByAI: true,
          offendingClass: className,
          error: reason,
          compileError: preflight.error,
          apiVersion: classDetail.apiVersion,
          likelyCause: diagnosis.likelyCause,
          hints: diagnosis.hints,
          attempts: 0,
          totalTokensUsed: { input: 0, output: 0, total: 0 },
          duration: Date.now() - startTime,
          log,
        };
      }

      progress('preflight', `${className} compiles cleanly — proceeding.`);
    }

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
    let totalTokensUsed = { input: 0, output: 0, total: 0 };
    let totalCostUSD = 0;
    let totalPromptCharsWithBlanks = 0;
    let totalGeneratedCharsWithBlanks = 0;
    const attemptsUsage = [];

    // Error history — accumulates ALL errors across ALL attempts
    const errorHistory = [];

    while (attempt <= MAX_FIX_RETRIES) {
      const isRetry = attempt > 0;
      const label = isRetry ? `Attempt ${attempt + 1}/${MAX_FIX_RETRIES + 1} (auto-fix)` : 'Initial generation';

      // ── Generate / Fix ────────────────────────────────
      progress('generate', `${label}: ${isRetry ? 'Fixing' : 'Generating'} test class via Claude...`);
      const genStartTime = Date.now();
      const generated = await claudeService.generateTestClass(
        classDetail.body,
        className,
        dependencyReport,
        previousAttempt,
        {
          model: targetModel,
          existingTestBody: attempt === 0 ? (existingTest.testClassBody || null) : null,
          errorHistory: isRetry ? errorHistory : [],
        }
      );
      const genDuration = Date.now() - genStartTime;

      finalTestClassName = generated.testClassName;
      finalTestClassBody = generated.testClassBody;
      
      const inTokens = generated.tokensUsed.input || 0;
      const outTokens = generated.tokensUsed.output || 0;
      const costUSD = generated.cost?.totalCostUSD || 0;
      const inChars = generated.characterMetrics?.input?.withBlanks || 0;
      const outChars = generated.characterMetrics?.output?.withBlanks || finalTestClassBody.length;

      totalTokensUsed.input += inTokens;
      totalTokensUsed.output += outTokens;
      totalTokensUsed.total = totalTokensUsed.input + totalTokensUsed.output;
      totalCostUSD += costUSD;
      totalPromptCharsWithBlanks += inChars;
      totalGeneratedCharsWithBlanks += outChars;

      const attemptRecord = {
        attempt: attempt + 1,
        label: isRetry ? (previousAttempt?.coverageIssue ? 'Coverage Boost' : 'Auto-Fix') : 'Initial Generation',
        model: generated.model,
        tokensUsed: generated.tokensUsed,
        cost: generated.cost,
        characterMetrics: generated.characterMetrics,
        durationMs: genDuration,
      };
      attemptsUsage.push(attemptRecord);

      progress('generate', `${label}: Test class generated (${outChars} chars w/ blanks, ${inTokens + outTokens} tokens, Cost: ${generated.cost?.formattedCost || '$0.00'})`, {
        testClassName: finalTestClassName,
        tokensUsed: generated.tokensUsed,
        cost: generated.cost,
        characterMetrics: generated.characterMetrics,
        attempt: attempt + 1,
        totalCumulativeCost: `$${totalCostUSD.toFixed(4)}`,
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

        // Stop immediately if the failure is in another class — retrying is pointless
        const classification = testDeployer.classifyDeployError(deployResult.error, finalTestClassName);
        if (classification.fatal) {
          const diagnosis = testDeployer.diagnoseCompileError(deployResult.error, null);

          progress('failed', `❌ Aborting auto-fix: ${classification.reason}`, {
            error: deployResult.error,
            offendingClass: classification.offendingClass,
            likelyCause: diagnosis.likelyCause,
            hints: diagnosis.hints,
            unfixableByAI: true,
          });

          if (diagnosis.likelyCause) {
            console.error(`[Harness] Likely cause: ${diagnosis.likelyCause}`);
          }
          diagnosis.hints.forEach((h, i) => console.error(`[Harness] Fix ${i + 1}: ${h}`));

          const abortPayload = {
            success: false,
            className,
            testClassName: finalTestClassName,
            testClassBody: finalTestClassBody,
            testResults: [],
            summary: { compileError: deployResult.error },
            unfixableByAI: true,
            offendingClass: classification.offendingClass,
            error: classification.reason,
            likelyCause: diagnosis.likelyCause,
            hints: diagnosis.hints,
            dependencyReport,
            attempts: attempt + 1,
            totalTokensUsed,
            duration: Date.now() - startTime,
            log,
          };

          return abortPayload;
        }

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
      const testResult = await testDeployer.runTests(conn, finalTestClassName, deployResult.classId);
      lastResult = { ...testResult, classId: deployResult.classId };

      // Handle API-level test run errors (e.g., "Invalid ID or name")
      if (testResult.summary.error && testResult.results.length === 0) {
        progress('test', `${label}: Test run error — ${testResult.summary.error}`, {
          summary: testResult.summary,
        });

        errorHistory.push({
          attempt: attempt + 1,
          compileError: `Test run API error: ${testResult.summary.error}`,
          errors: [],
        });

        previousAttempt = {
          testClassBody: finalTestClassBody,
          errors: [],
          compileError: `Test run API error: ${testResult.summary.error}`,
        };
        attempt++;
        continue;
      }

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
          totalCostUSD,
          formattedCost: `$${totalCostUSD.toFixed(4)}`,
        });

        const aiUsage = {
          model: attemptsUsage[0]?.model || process.env.CLAUDE_MODEL || 'claude-3-7-sonnet',
          totalInputTokens: totalTokensUsed.input,
          totalOutputTokens: totalTokensUsed.output,
          totalTokens: totalTokensUsed.total,
          totalCostUSD: Number(totalCostUSD.toFixed(6)),
          formattedCost: `$${totalCostUSD.toFixed(4)}`,
          attempts: attemptsUsage,
          characterStats: {
            sourceClass: {
              withBlanks: classDetail.body.length,
              withoutBlanks: classDetail.body.replace(/\s/g, '').length,
              whitespace: classDetail.body.length - classDetail.body.replace(/\s/g, '').length,
              lines: classDetail.body.split('\n').length,
            },
            testClass: {
              withBlanks: finalTestClassBody ? finalTestClassBody.length : 0,
              withoutBlanks: finalTestClassBody ? finalTestClassBody.replace(/\s/g, '').length : 0,
              whitespace: finalTestClassBody ? (finalTestClassBody.length - finalTestClassBody.replace(/\s/g, '').length) : 0,
              lines: finalTestClassBody ? finalTestClassBody.split('\n').length : 0,
            },
            totalPromptCharsWithBlanks,
            totalGeneratedCharsWithBlanks,
          },
        };

        const resultPayload = {
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
          aiUsage,
          duration: Date.now() - startTime,
          log,
        };

        // Log to persistent Audit History
        auditLogger.logRun({
          ...resultPayload,
          characterStats: aiUsage.characterStats,
          costUSD: aiUsage.totalCostUSD,
          formattedCost: aiUsage.formattedCost,
          model: aiUsage.model,
          tokensUsed: totalTokensUsed,
        });

        return resultPayload;
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

    const aiUsageFailed = {
      model: attemptsUsage[0]?.model || process.env.CLAUDE_MODEL || 'claude-3-7-sonnet',
      totalInputTokens: totalTokensUsed.input,
      totalOutputTokens: totalTokensUsed.output,
      totalTokens: totalTokensUsed.total,
      totalCostUSD: Number(totalCostUSD.toFixed(6)),
      formattedCost: `$${totalCostUSD.toFixed(4)}`,
      attempts: attemptsUsage,
      characterStats: {
        sourceClass: {
          withBlanks: classDetail.body.length,
          withoutBlanks: classDetail.body.replace(/\s/g, '').length,
          whitespace: classDetail.body.length - classDetail.body.replace(/\s/g, '').length,
          lines: classDetail.body.split('\n').length,
        },
        testClass: {
          withBlanks: finalTestClassBody ? finalTestClassBody.length : 0,
          withoutBlanks: finalTestClassBody ? finalTestClassBody.replace(/\s/g, '').length : 0,
          whitespace: finalTestClassBody ? (finalTestClassBody.length - finalTestClassBody.replace(/\s/g, '').length) : 0,
          lines: finalTestClassBody ? finalTestClassBody.split('\n').length : 0,
        },
        totalPromptCharsWithBlanks,
        totalGeneratedCharsWithBlanks,
      },
    };

    const failedPayload = {
      success: false,
      className,
      testClassName: finalTestClassName,
      testClassBody: finalTestClassBody,
      testResults: lastResult?.results || [],
      summary: lastResult?.summary || {},
      dependencyReport,
      attempts: MAX_FIX_RETRIES + 1,
      totalTokensUsed,
      aiUsage: aiUsageFailed,
      duration: Date.now() - startTime,
      log,
    };

    // Log to persistent Audit History
    auditLogger.logRun({
      ...failedPayload,
      characterStats: aiUsageFailed.characterStats,
      costUSD: aiUsageFailed.totalCostUSD,
      formattedCost: aiUsageFailed.formattedCost,
      model: aiUsageFailed.model,
      tokensUsed: totalTokensUsed,
    });

    return failedPayload;

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
