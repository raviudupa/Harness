/**
 * Audit Logger Service
 * Persists test generation audit records to disk (data/audit_history.json).
 * Tracks all parameters: Apex class characters (with/without blanks),
 * token consumption (input/output), Claude charges ($ USD), coverage %,
 * attempts, status, and duration.
 *
 * Provides CSV and JSON export capabilities for monitoring and reporting.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const AUDIT_FILE = path.join(DATA_DIR, 'audit_history.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Load audit history from JSON file.
 * @returns {Array<object>}
 */
function getHistory() {
  try {
    if (!fs.existsSync(AUDIT_FILE)) {
      return [];
    }
    const raw = fs.readFileSync(AUDIT_FILE, 'utf8');
    return JSON.parse(raw) || [];
  } catch (err) {
    console.error('[AuditLogger] Error reading history:', err.message);
    return [];
  }
}

/**
 * Save history array to JSON file.
 * @param {Array<object>} history
 */
function saveHistory(history) {
  try {
    fs.writeFileSync(AUDIT_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (err) {
    console.error('[AuditLogger] Error saving history:', err.message);
  }
}

/**
 * Log a new test generation audit record.
 * @param {object} record
 * @returns {object} The logged record
 */
function logRun(record) {
  const history = getHistory();

  const entry = {
    id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    timestamp: new Date().toISOString(),
    formattedDate: new Date().toLocaleString(),
    className: record.className,
    testClassName: record.testClassName || `${record.className}Test`,
    status: record.success ? 'Pass' : 'Fail',
    
    // Character Metrics (with & without blanks)
    sourceClassCharsWithBlanks: record.characterStats?.sourceClass?.withBlanks || 0,
    sourceClassCharsNoBlanks: record.characterStats?.sourceClass?.withoutBlanks || 0,
    sourceClassBlanksOnly: record.characterStats?.sourceClass?.whitespace || 0,
    sourceClassLines: record.characterStats?.sourceClass?.lines || 0,

    testClassCharsWithBlanks: record.characterStats?.testClass?.withBlanks || 0,
    testClassCharsNoBlanks: record.characterStats?.testClass?.withoutBlanks || 0,
    testClassBlanksOnly: record.characterStats?.testClass?.whitespace || 0,
    testClassLines: record.characterStats?.testClass?.lines || 0,

    // Token Consumption
    inputTokens: record.tokensUsed?.input || 0,
    outputTokens: record.tokensUsed?.output || 0,
    totalTokens: record.tokensUsed?.total || ((record.tokensUsed?.input || 0) + (record.tokensUsed?.output || 0)),

    // Financial Charges
    costUSD: Number((record.costUSD || record.aiUsage?.totalCostUSD || 0).toFixed(6)),
    formattedCost: record.formattedCost || `$${(record.costUSD || record.aiUsage?.totalCostUSD || 0).toFixed(4)}`,

    // Test & Coverage Results
    coveragePercent: record.coverage?.coveragePercent != null ? record.coverage.coveragePercent : null,
    targetPercent: record.targetPercent || 80,
    targetMet: record.targetMet || false,
    passedTests: record.summary?.passed || 0,
    failedTests: record.summary?.failed || 0,
    attempts: record.attempts || 1,

    // Metadata
    model: record.model || process.env.CLAUDE_MODEL || 'claude-3-7-sonnet',
    durationMs: record.duration || 0,
    durationSeconds: Number(((record.duration || 0) / 1000).toFixed(1)),
    durationFormatted: formatDuration(record.duration),
  };

  history.unshift(entry); // Newest first
  saveHistory(history);
  console.log(`[AuditLogger] Logged run for ${entry.className} (Tokens: ${entry.totalTokens}, Cost: ${entry.formattedCost}, Coverage: ${entry.coveragePercent}%)`);
  return entry;
}

/**
 * Get aggregated summary metrics across all logged runs.
 * @returns {object}
 */
function getSummary() {
  const history = getHistory();
  if (history.length === 0) {
    return {
      totalRuns: 0,
      uniqueClasses: 0,
      totalSourceCharsWithBlanks: 0,
      totalTestCharsWithBlanks: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalCostUSD: 0,
      formattedTotalCost: '$0.0000',
      averageCoverage: 0,
      passCount: 0,
      failCount: 0,
      passRate: '0%',
    };
  }

  const uniqueClasses = new Set(history.map((h) => h.className)).size;
  let totalSourceChars = 0;
  let totalTestChars = 0;
  let totalInTokens = 0;
  let totalOutTokens = 0;
  let totalCost = 0;
  let coverageSum = 0;
  let coverageCount = 0;
  let passCount = 0;
  let failCount = 0;

  for (const h of history) {
    totalSourceChars += h.sourceClassCharsWithBlanks || 0;
    totalTestChars += h.testClassCharsWithBlanks || 0;
    totalInTokens += h.inputTokens || 0;
    totalOutTokens += h.outputTokens || 0;
    totalCost += h.costUSD || 0;
    if (h.coveragePercent != null && h.coveragePercent >= 0) {
      coverageSum += h.coveragePercent;
      coverageCount++;
    }
    if (h.status === 'Pass') passCount++;
    else failCount++;
  }

  const avgCov = coverageCount > 0 ? Math.round(coverageSum / coverageCount) : 0;
  const passRate = Math.round((passCount / history.length) * 100);

  return {
    totalRuns: history.length,
    uniqueClasses,
    totalSourceCharsWithBlanks: totalSourceChars,
    totalTestCharsWithBlanks: totalTestChars,
    totalInputTokens: totalInTokens,
    totalOutputTokens: totalOutTokens,
    totalTokens: totalInTokens + totalOutTokens,
    totalCostUSD: Number(totalCost.toFixed(5)),
    formattedTotalCost: `$${totalCost.toFixed(4)}`,
    averageCoverage: avgCov,
    passCount,
    failCount,
    passRate: `${passRate}%`,
  };
}

/**
 * Generate CSV export content.
 * @returns {string}
 */
function exportCSV() {
  const history = getHistory();
  const summary = getSummary();

  const headers = [
    'Timestamp',
    'Apex Class',
    'Test Class',
    'Status',
    'Source Chars (w/ blanks)',
    'Source Chars (no blanks)',
    'Source Lines',
    'Test Chars (w/ blanks)',
    'Test Chars (no blanks)',
    'Test Lines',
    'Input Tokens',
    'Output Tokens',
    'Total Tokens',
    'Claude Charges (USD)',
    'Coverage (%)',
    'Target (%)',
    'Attempts',
    'Model',
    'Duration (s)',
  ];

  const escapeCSV = (val) => {
    if (val == null) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const rows = history.map((r) => [
    escapeCSV(r.formattedDate || r.timestamp),
    escapeCSV(r.className),
    escapeCSV(r.testClassName),
    escapeCSV(r.status),
    r.sourceClassCharsWithBlanks,
    r.sourceClassCharsNoBlanks,
    r.sourceClassLines,
    r.testClassCharsWithBlanks,
    r.testClassCharsNoBlanks,
    r.testClassLines,
    r.inputTokens,
    r.outputTokens,
    r.totalTokens,
    Number((r.costUSD || 0).toFixed(5)),
    r.coveragePercent != null ? r.coveragePercent : 'N/A',
    r.targetPercent || 80,
    r.attempts,
    escapeCSV(r.model),
    r.durationSeconds,
  ].join(','));

  // Summary footer row
  const summaryRow = [
    escapeCSV('--- TOTALS & AVERAGES ---'),
    escapeCSV(`${summary.uniqueClasses} unique classes (${summary.totalRuns} runs)`),
    escapeCSV(''),
    escapeCSV(`Pass Rate: ${summary.passRate}`),
    summary.totalSourceCharsWithBlanks,
    '',
    '',
    summary.totalTestCharsWithBlanks,
    '',
    '',
    summary.totalInputTokens,
    summary.totalOutputTokens,
    summary.totalTokens,
    Number(summary.totalCostUSD.toFixed(5)),
    summary.averageCoverage,
    '',
    '',
    '',
    '',
  ].join(',');

  return [headers.join(','), ...rows, '', summaryRow].join('\r\n');
}

/**
 * Clear all audit history.
 */
function clearHistory() {
  saveHistory([]);
}

function formatDuration(ms) {
  if (!ms) return '0s';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

module.exports = {
  logRun,
  getHistory,
  getSummary,
  exportCSV,
  clearHistory,
};
