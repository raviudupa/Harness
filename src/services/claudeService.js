/**
 * Claude LLM Service
 * Integrates with the Anthropic Messages API to generate and fix Apex test classes.
 * Constructs detailed prompts using the dependency report so Claude has full context.
 *
 * Enhancements:
 *   - Callout/Mock detection → explicit HttpCalloutMock instructions
 *   - Batch/Schedulable/Queueable → exact test patterns
 *   - @RestResource / @AuraEnabled / @InvocableMethod → test strategy hints
 *   - Error history accumulation → prevents Claude from repeating failed fixes
 *   - Existing test body passthrough → Claude improves rather than rewrites
 */
const Anthropic = require('@anthropic-ai/sdk');

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';
const MAX_TOKENS = parseInt(process.env.MAX_OUTPUT_TOKENS || '128000', 10);

let anthropicClient = null;

function getClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return anthropicClient;
}

/**
 * Smart brace-balancing repair for truncated Apex code.
 * Counts unmatched '{' vs '}' (ignoring those inside string literals)
 * and appends the correct number of closing braces.
 * Also strips any dangling incomplete line at the truncation point.
 */
function repairUnbalancedBraces(code) {
  // Strip any trailing incomplete line (truncated mid-statement)
  const lines = code.split('\n');
  const lastLine = lines[lines.length - 1].trim();
  if (lastLine && !lastLine.endsWith('}') && !lastLine.endsWith('{') &&
      !lastLine.endsWith(';') && !lastLine.endsWith('*/') && !lastLine.endsWith('//')) {
    lines.pop();
    code = lines.join('\n');
  }

  // Count unmatched braces (skip braces inside string literals)
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let prevChar = '';

  for (const ch of code) {
    if (inString) {
      if (ch === stringChar && prevChar !== '\\') {
        inString = false;
      }
    } else {
      if (ch === "'" || ch === '"') {
        inString = true;
        stringChar = ch;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
      }
    }
    prevChar = ch;
  }

  if (depth > 0) {
    console.log(`[ClaudeService] Brace repair: adding ${depth} closing brace(s)`);
    code += '\n' + '}\n'.repeat(depth).trimEnd();
  }

  return code;
}


function buildSystemPrompt() {
  return `You are a Principal Salesforce Architect and Apex testing expert.
Your goal is to generate clean, robust, compilable Apex test classes that achieve 85%+ coverage without unnecessary boilerplate.

STRICT APEX TESTING RULES:
1. NEVER use @isTest(SeeAllData=true). Always create isolated mock data.
2. Annotate the class with @isTest and every test method with @isTest.
3. Structure tests cleanly with helper methods for test data creation.
4. Keep the test class concise and focused (3-5 comprehensive test methods: Positive, Negative, Edge case/Bulk).
5. ALWAYS use Test.startTest() and Test.stopTest() around the execution under test.
6. ALWAYS include meaningful System.assert / System.assertEquals assertions.
7. Satisfy all validation rules and required fields provided in the metadata.
8. Only use valid picklist values from the provided metadata list.
9. For REST API classes (like @RestResource):
   - Set up RestContext.request and RestContext.response properly with Blob.valueOf(...)
10. Ensure the class is COMPLETE and syntactically valid with all opening and closing braces properly balanced.
11. Return ONLY the pure Apex class code. Do NOT include markdown code blocks, intro, or outro text.

CRITICAL FIELD WRITABILITY RULES — FOLLOW THESE EXACTLY:
12. NEVER set fields marked as FORMULA, AUTO-NUMBER, or NOT CREATEABLE. These are read-only and will cause compile errors like "Field is not writeable".
13. For LOOKUP / REFERENCE fields: you must create and insert the parent record FIRST, then use its Id to populate the lookup field on the child. Follow the INSERTION ORDER provided in the metadata.
14. For fields marked CREATEABLE but NOT UPDATEABLE: only set them during insert, never in an update statement.
15. If a field has "has default value" — you can omit it from test data unless it's needed for specific test logic.
16. When in doubt about a field, check its metadata flags. If createable=false, do NOT set it.

CALLOUT & MOCK RULES:
17. If the class makes HTTP callouts (Http.send, HttpRequest, etc.), you MUST create an inner class that implements HttpCalloutMock. Register it with Test.setMock(HttpCalloutMock.class, new YourMock()) BEFORE Test.startTest().
18. If the class uses WebServiceCallout.invoke, implement WebServiceMock instead.
19. Never make actual HTTP callouts in tests — they will always fail.

ASYNC PATTERN RULES:
20. For @future methods: call them between Test.startTest() and Test.stopTest().
21. For Database.Batchable: use Database.executeBatch() between Test.startTest() and Test.stopTest().
22. For Schedulable: use System.schedule() between Test.startTest() and Test.stopTest().
23. For Queueable: use System.enqueueJob() between Test.startTest() and Test.stopTest().

DATA ISOLATION RULES:
24. Use @TestSetup ONLY when all test data objects are non-setup objects. If you need to insert User, Profile, Group, or PermissionSet records, use System.runAs() inside individual test methods instead to avoid mixed DML errors.
25. For custom settings, insert them in @TestSetup or at the start of each test method. Never assume they exist.`;
}

function formatDependencyContext(dependencyReport) {
  let context = '';

  context += '=== SOBJECT METADATA ===\n\n';
  for (const [objName, meta] of Object.entries(dependencyReport.objects || {})) {
    context += `--- ${objName} ---\n`;
    context += `Used Fields: ${(meta.usedFields || []).join(', ')}\n`;
    context += `Required Fields: ${(meta.requiredFields || []).join(', ') || 'None'}\n`;

    if (meta.lookupFields && meta.lookupFields.length > 0) {
      context += `Lookup Fields:\n`;
      for (const lf of meta.lookupFields) {
        context += `  - ${lf.field} → references: ${(lf.referenceTo || []).join(', ')}\n`;
      }
    }

    if (meta.fieldMetadata) {
      context += `Field Details:\n`;
      for (const [fieldName, fieldMeta] of Object.entries(meta.fieldMetadata)) {
        let line = `  - ${fieldName}: type=${fieldMeta.type}`;

        // Writability flags — critical for Claude to know
        if (fieldMeta.formula) {
          line += `, FORMULA (READ-ONLY — do NOT set this field)`;
        } else if (fieldMeta.autoNumber) {
          line += `, AUTO-NUMBER (READ-ONLY — do NOT set this field)`;
        } else if (!fieldMeta.createable) {
          line += `, NOT CREATEABLE (READ-ONLY — do NOT set this field in insert)`;
        }
        if (fieldMeta.createable && !fieldMeta.updateable) {
          line += `, CREATEABLE but NOT UPDATEABLE`;
        }

        if (fieldMeta.required) line += `, REQUIRED`;
        if (fieldMeta.defaultedOnCreate) line += `, has default value`;

        // Lookup/reference info
        if (fieldMeta.type === 'reference' && fieldMeta.referenceTo && fieldMeta.referenceTo.length > 0) {
          line += `, references=[${fieldMeta.referenceTo.join(', ')}]`;
          if (fieldMeta.relationshipName) {
            line += ` (relationship: ${fieldMeta.relationshipName})`;
          }
        }

        // Picklist valid values
        if (fieldMeta.picklistValues && fieldMeta.picklistValues.length > 0) {
          line += `, validValues=[${fieldMeta.picklistValues.slice(0, 10).join(', ')}]`;
        }

        // Length for strings
        if (fieldMeta.type === 'string' && fieldMeta.length) {
          line += `, maxLength=${fieldMeta.length}`;
        }

        context += line + '\n';
      }
    }

    if (meta.validationRules && meta.validationRules.length > 0) {
      context += `Active Validation Rules:\n`;
      for (const vr of meta.validationRules) {
        context += `  - "${vr.name}": Error: "${vr.errorMessage}"\n`;
      }
    }

    if (meta.recordTypes && meta.recordTypes.length > 0) {
      context += `Available Record Types:\n`;
      for (const rt of meta.recordTypes) {
        context += `  - "${rt.name}" (default: ${rt.defaultRecordTypeMapping})\n`;
      }
    }

    context += '\n';
  }

  if (dependencyReport.customSettings && dependencyReport.customSettings.length > 0) {
    context += '=== CUSTOM SETTINGS / CUSTOM METADATA ===\n';
    context += `Referenced: ${dependencyReport.customSettings.join(', ')}\n\n`;
  }

  context += `=== SHARING MODEL ===\n`;
  context += `Class uses: ${dependencyReport.sharingModel}\n\n`;

  if (dependencyReport.insertionOrder && dependencyReport.insertionOrder.length > 1) {
    context += '=== INSERTION ORDER ===\n';
    context += `Create records in this order: ${dependencyReport.insertionOrder.join(' → ')}\n\n`;
  }

  // ── NEW: Callout / Interface / Annotation context ──

  if (dependencyReport.calloutInfo && dependencyReport.calloutInfo.hasCallout) {
    context += '=== ⚠️ CALLOUT DETECTED ===\n';
    context += `This class makes HTTP callouts via: ${dependencyReport.calloutInfo.patterns.join(', ')}\n`;
    context += `You MUST create an inner class implementing HttpCalloutMock and register it with Test.setMock() BEFORE Test.startTest().\n`;
    context += `Example mock:\n`;
    context += `  private class MockHttpResponse implements HttpCalloutMock {\n`;
    context += `    public HTTPResponse respond(HTTPRequest req) {\n`;
    context += `      HttpResponse res = new HttpResponse();\n`;
    context += `      res.setHeader('Content-Type', 'application/json');\n`;
    context += `      res.setBody('{"status":"success"}');\n`;
    context += `      res.setStatusCode(200);\n`;
    context += `      return res;\n`;
    context += `    }\n`;
    context += `  }\n\n`;
  }

  if (dependencyReport.interfaceInfo && dependencyReport.interfaceInfo.testInstructions.length > 0) {
    context += '=== CLASS INTERFACE INSTRUCTIONS ===\n';
    for (const instruction of dependencyReport.interfaceInfo.testInstructions) {
      context += `• ${instruction}\n`;
    }
    context += '\n';
  }

  if (dependencyReport.annotationInfo && dependencyReport.annotationInfo.testInstructions.length > 0) {
    context += '=== CLASS ANNOTATION INSTRUCTIONS ===\n';
    for (const instruction of dependencyReport.annotationInfo.testInstructions) {
      context += `• ${instruction}\n`;
    }
    context += '\n';
  }

  return context;
}

/**
 * Format error history to prevent Claude from repeating the same mistakes.
 * @param {Array} errorHistory - Array of { attempt, compileError, errors }
 * @returns {string}
 */
function formatErrorHistory(errorHistory) {
  if (!errorHistory || errorHistory.length === 0) return '';

  let history = '=== ⚠️ PREVIOUS ATTEMPT HISTORY (DO NOT REPEAT THESE MISTAKES) ===\n';
  for (const entry of errorHistory) {
    history += `\n--- Attempt ${entry.attempt} ---\n`;
    if (entry.compileError) {
      history += `COMPILE ERROR: ${entry.compileError}\n`;
    }
    if (entry.errors && entry.errors.length > 0) {
      for (const err of entry.errors) {
        history += `TEST FAIL [${err.methodName}]: ${err.message}\n`;
      }
    }
  }
  history += '\nYou MUST use a DIFFERENT approach from the failed attempts above.\n\n';
  return history;
}

/**
 * Generate a test class for the given Apex class.
 *
 * @param {string} apexClassBody - Source code of the class under test
 * @param {string} className - API name of the class
 * @param {object} dependencyReport - Full dependency analysis report
 * @param {object|null} previousAttempt - Previous failing attempt (testClassBody, errors, compileError)
 * @param {object} options - Additional options
 * @param {string} options.existingTestBody - Body of the existing test class (if any)
 * @param {Array} options.errorHistory - Array of all previous error entries
 * @returns {Promise<{testClassName, testClassBody, tokensUsed}>}
 */
async function generateTestClass(apexClassBody, className, dependencyReport, previousAttempt = null, options = {}) {
  const client = getClient();
  const testClassName = `${className}Test`;
  const { existingTestBody, errorHistory } = options;

  let userMessage = '';

  if (!previousAttempt) {
    // ── Initial Generation ──
    userMessage = `Write a high-quality, concise Apex test class for:

=== APEX CLASS: ${className} ===
${apexClassBody}

=== METADATA CONTEXT ===
${formatDependencyContext(dependencyReport)}
`;

    // Include existing test body as reference (if any)
    if (existingTestBody) {
      userMessage += `=== EXISTING TEST CLASS (reference — improve upon this) ===
${existingTestBody}

IMPORTANT: An existing test class was found. Use it as a starting reference but ensure you fix any issues and improve coverage. Do NOT blindly copy it if it has problems.

`;
    }

    userMessage += `REQUIREMENTS:
- Class Name: ${testClassName}
- Write 3 to 5 clean, focused test methods (e.g. testSuccess, testMissingFields, testInvalidInput, testBulkOrException).
- Keep helper data creation methods simple and modular to avoid overly long code.
- Ensure the code finishes completely with all matching braces.

Return ONLY the raw Apex code.`;
  } else if (previousAttempt.coverageIssue) {
    // ── Coverage Boost Attempt (Tests passed, but coverage < target) ──
    const { currentPercent, targetPercent, uncoveredLines } = previousAttempt.coverageIssue;
    const linesList = uncoveredLines && uncoveredLines.length > 0
      ? uncoveredLines.slice(0, 30).join(', ') + (uncoveredLines.length > 30 ? ` (+${uncoveredLines.length - 30} more)` : '')
      : 'Branches/conditionals';

    userMessage = `All tests currently PASS, but code coverage is ${currentPercent}% which is BELOW the required ${targetPercent}% threshold.

=== APEX CLASS UNDER TEST: ${className} ===
${apexClassBody}

=== CURRENT WORKING TEST CLASS: ${testClassName} ===
${previousAttempt.testClassBody}

=== UNCOVERED LINE NUMBERS IN ${className} ===
The following lines in ${className} were NOT executed by any test:
${linesList}

=== OBJECTIVE ===
Write additional test methods (or expand existing ones) to exercise the uncovered lines and branches above.
- Achieve AT LEAST ${targetPercent}% code coverage.
- Preserve all existing passing assertions and setup logic.
- Add negative/edge/catch block tests if necessary to cover exception handlers or boundary conditions.
- Keep helper methods clean and ensure all braces match.

=== METADATA CONTEXT ===
${formatDependencyContext(dependencyReport)}

Return ONLY the complete updated Apex test class.`;
  } else {
    // ── Fix Attempt (Compilation or Test Failures) ──
    userMessage = `The test class failed compilation or test execution. Fix the errors:

=== APEX CLASS UNDER TEST: ${className} ===
${apexClassBody}

=== FAILING TEST CLASS: ${testClassName} ===
${previousAttempt.testClassBody}

=== COMPILATION / RUNTIME ERRORS ===
${previousAttempt.compileError ? `COMPILE ERROR: ${previousAttempt.compileError}\n` : ''}
${(previousAttempt.errors || []).map((e) =>
      `Method: ${e.methodName}\nError: ${e.message}\nStack Trace: ${e.stackTrace || 'N/A'}`
    ).join('\n\n')}

${formatErrorHistory(errorHistory)}
=== METADATA CONTEXT ===
${formatDependencyContext(dependencyReport)}

Fix the exact line / syntax / variable mismatch. Ensure the test class is concise, complete, and ends with the closing '}'.

Return ONLY the raw fixed Apex code.`;
  }

  console.log(`[ClaudeService] Calling Claude (${CLAUDE_MODEL}) to ${previousAttempt ? 'fix' : 'generate'} test class...`);

  const response = await client.messages.stream({
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: userMessage }],
  }).finalMessage();

  let testClassBody = '';
  for (const block of response.content) {
    if (block.type === 'text') {
      testClassBody += block.text;
    }
  }

  // Clean markdown tags
  testClassBody = testClassBody
    .replace(/^```(?:apex|java|cls)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

  // If Claude got cut off due to max_tokens, repair unbalanced braces
  if (response.stop_reason === 'max_tokens') {
    console.warn('[ClaudeService] Warning: Output was truncated by max_tokens limit. Attempting smart brace repair...');
    testClassBody = repairUnbalancedBraces(testClassBody);
  }

  const inputTokens = response.usage?.input_tokens || 0;
  const outputTokens = response.usage?.output_tokens || 0;
<<<<<<< Updated upstream
  const cacheCreationTokens = response.usage?.cache_creation_input_tokens || 0;
  const cacheReadTokens = response.usage?.cache_read_input_tokens || 0;

  // Character counts: input prompt length + output body length
  const inputChars = userMessage.length + buildSystemPrompt().length;
  const outputChars = testClassBody.length;

  console.log(`[ClaudeService] Received test class (${testClassBody.length} chars, stop_reason: ${response.stop_reason}, tokens: ${inputTokens}in/${outputTokens}out)`);
=======
  const cost = calculateClaudeCost(CLAUDE_MODEL, inputTokens, outputTokens);

  const inputCharsWithBlanks = userMessage.length;
  const inputCharsWithoutBlanks = userMessage.replace(/\s/g, '').length;
  const inputWhitespaceChars = inputCharsWithBlanks - inputCharsWithoutBlanks;

  const outputCharsWithBlanks = testClassBody.length;
  const outputCharsWithoutBlanks = testClassBody.replace(/\s/g, '').length;
  const outputWhitespaceChars = outputCharsWithBlanks - outputCharsWithoutBlanks;

  console.log(
    `[ClaudeService] Received test class (${outputCharsWithBlanks} chars w/ blanks, ${inputTokens + outputTokens} tokens, Cost: ${cost.formattedCost})`
  );
>>>>>>> Stashed changes

  return {
    testClassName,
    testClassBody,
    model: CLAUDE_MODEL,
    tokensUsed: {
      input: inputTokens,
      output: outputTokens,
<<<<<<< Updated upstream
      cacheCreation: cacheCreationTokens,
      cacheRead: cacheReadTokens,
    },
    charsUsed: {
      input: inputChars,
      output: outputChars,
=======
      total: inputTokens + outputTokens,
>>>>>>> Stashed changes
    },
    cost,
    characterMetrics: {
      input: {
        withBlanks: inputCharsWithBlanks,
        withoutBlanks: inputCharsWithoutBlanks,
        whitespace: inputWhitespaceChars,
      },
      output: {
        withBlanks: outputCharsWithBlanks,
        withoutBlanks: outputCharsWithoutBlanks,
        whitespace: outputWhitespaceChars,
        lines: testClassBody.split('\n').length,
      },
    },
  };
}

const MODEL_RATES = {
  // Rates per 1,000,000 tokens (USD)
  'claude-3-7-sonnet': { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet': { input: 3.00, output: 15.00 },
  'claude-3-sonnet': { input: 3.00, output: 15.00 },
  'claude-3-5-haiku': { input: 0.80, output: 4.00 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'claude-3-opus': { input: 15.00, output: 75.00 },
};

function getModelRates(modelName = CLAUDE_MODEL) {
  const normalized = (modelName || '').toLowerCase();
  for (const [key, rates] of Object.entries(MODEL_RATES)) {
    if (normalized.includes(key)) {
      return { ...rates, matchedModel: key };
    }
  }
  return { input: 3.00, output: 15.00, matchedModel: 'claude-3-7-sonnet' };
}

function calculateClaudeCost(modelName, inputTokens, outputTokens) {
  const rates = getModelRates(modelName);
  const inputCost = (inputTokens / 1_000_000) * rates.input;
  const outputCost = (outputTokens / 1_000_000) * rates.output;
  const totalCost = inputCost + outputCost;

  return {
    model: modelName,
    rates: {
      inputPerMillionUSD: rates.input,
      outputPerMillionUSD: rates.output,
    },
    inputCostUSD: Number(inputCost.toFixed(6)),
    outputCostUSD: Number(outputCost.toFixed(6)),
    totalCostUSD: Number(totalCost.toFixed(6)),
    formattedCost: `$${totalCost.toFixed(4)}`,
  };
}

module.exports = {
  generateTestClass,
  calculateClaudeCost,
  getModelRates,
};

