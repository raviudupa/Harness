/**
 * Harness Routes
 * API endpoints for listing Apex classes, running the harness pipeline,
 * and checking execution status.
 */
const express = require('express');
const router = express.Router();
const salesforceAuth = require('../services/salesforceAuth');
const apexClassService = require('../services/apexClassService');
const { executeHarness } = require('../services/harnessOrchestrator');

// In-memory store for running harness jobs (for SSE progress updates)
const activeJobs = new Map();

// Cleanup completed jobs after 30 minutes to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  const TTL_MS = 30 * 60 * 1000; // 30 minutes
  for (const [jobId, job] of activeJobs) {
    if (job.status !== 'running' && (now - job.startTime) > TTL_MS) {
      activeJobs.delete(jobId);
    }
  }
}, 5 * 60 * 1000); // Run cleanup every 5 minutes

/**
 * Middleware: require Salesforce authentication.
 */
// function requireAuth(req, res, next) {
//   if (!salesforceAuth.isAuthenticated(req.session)) {
//     return res.status(401).json({ error: 'Not authenticated. Please login to Salesforce first.' });
//   }
//   next();
// }
function requireAuth(req, res, next) {
  const configuredKey = process.env.HARNESS_API_KEY;
  const receivedKey = req.get('X-Harness-Key');

  if (
    configuredKey &&
    receivedKey &&
    receivedKey === configuredKey
  ) {
    return next();
  }

  if (salesforceAuth.isAuthenticated(req.session)) {
    return next();
  }

  return res.status(401).json({
    error: 'Not authenticated'
  });
}
/**
 * GET /api/classes
 * List all non-test Apex classes in the org.
 */
router.get('/classes', requireAuth, async (req, res) => {
  try {
    const conn = await salesforceAuth.getConnection(req.session);
    const classes = await apexClassService.listApexClasses(conn);

    // Filter out test classes (those with @isTest in common naming patterns)
    const nonTestClasses = classes.filter((c) => {
      const name = c.name.toLowerCase();
      return !name.endsWith('test') && !name.endsWith('_test') && !name.startsWith('test_');
    });

    res.json({ classes: nonTestClasses, total: nonTestClasses.length });
  } catch (err) {
    console.error('[Harness API] Error listing classes:', err.message);
    res.status(500).json({ error: 'Failed to list Apex classes', details: err.message });
  }
});

/**
 * GET /api/classes/:name
 * Get the full body and details of a specific Apex class.
 */
router.get('/classes/:name', requireAuth, async (req, res) => {
  try {
    const conn = await salesforceAuth.getConnection(req.session);
    const detail = await apexClassService.getApexClassDetail(conn, req.params.name);
    res.json(detail);
  } catch (err) {
    console.error(`[Harness API] Error fetching class ${req.params.name}:`, err.message);
    res.status(500).json({ error: `Failed to fetch class: ${req.params.name}`, details: err.message });
  }
});

const { AVAILABLE_MODELS, CLAUDE_MODEL } = require('../services/claudeService');

/**
 * GET /api/models
 * Get the list of selectable AI models and current default model.
 */
router.get('/models', (req, res) => {
  res.json({
    defaultModel: process.env.CLAUDE_MODEL || CLAUDE_MODEL || 'claude-opus-5',
    models: AVAILABLE_MODELS,
  });
});

/**
 * POST /api/harness/run
 * Execute the full harness pipeline for a given class.
 * Body: { className: "MyApexClass", model: "claude-sonnet-5" }
 */
router.post('/harness/run', requireAuth, async (req, res) => {
  const { className, model } = req.body;

  if (!className) {
    return res.status(400).json({ error: 'Missing className in request body' });
  }

  const conn = await salesforceAuth.getConnection(req.session);
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const selectedModel = model || process.env.CLAUDE_MODEL || CLAUDE_MODEL || 'claude-opus-5';

  // Initialize job tracking
  activeJobs.set(jobId, {
    status: 'running',
    className,
    model: selectedModel,
    progress: [],
    result: null,
    startTime: Date.now(),
  });

  // Start the harness asynchronously
  res.json({ jobId, message: `Harness started for ${className} using ${selectedModel}` });

  // Execute in background
  try {
    const result = await executeHarness(
      conn,
      className,
      (step, message, data) => {
        const job = activeJobs.get(jobId);
        if (job) {
          job.progress.push({ step, message, data, timestamp: Date.now() });
        }
      },
      { model: selectedModel }
    );

    const job = activeJobs.get(jobId);
    if (job) {
      job.status = result.success ? 'completed' : 'failed';
      job.result = result;
    }
  } catch (err) {
    const job = activeJobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.result = { success: false, error: err.message };
    }
  }
});

/**
 * GET /api/harness/status/:jobId
 * Check the status and progress of a running harness job.
 * Supports polling and optionally returns progress since a given index.
 */
router.get('/harness/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const sinceIndex = parseInt(req.query.since || '0', 10);

  const job = activeJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const newProgress = job.progress.slice(sinceIndex);

  res.json({
    jobId,
    status: job.status,
    className: job.className,
    progress: newProgress,
    progressIndex: job.progress.length,
    result: job.status !== 'running' ? job.result : null,
    elapsed: Date.now() - job.startTime,
  });
});

/**
 * GET /api/harness/jobs
 * List all active/recent harness jobs.
 */
router.get('/harness/jobs', (req, res) => {
  const jobs = [];
  for (const [jobId, job] of activeJobs) {
    jobs.push({
      jobId,
      status: job.status,
      className: job.className,
      elapsed: Date.now() - job.startTime,
    });
  }
  res.json({ jobs });
});

/**
 * POST /api/fls/check
 * Run dependency analysis only and return FLS summary for all detected objects.
 * Body: { className: "MyApexClass" }
 */
router.post('/fls/check', requireAuth, async (req, res) => {
  const { className } = req.body;

  if (!className) {
    return res.status(400).json({ error: 'Missing className in request body' });
  }

  try {
    const conn = await salesforceAuth.getConnection(req.session);
    const apexClassService = require('../services/apexClassService');
    const dependencyAnalyzer = require('../services/dependencyAnalyzer');

    // Fetch class body + symbol table
    const classDetail = await apexClassService.getApexClassDetail(conn, className);

    // Run the full dependency analysis
    const report = await dependencyAnalyzer.analyzeClassDependencies(
      conn,
      classDetail.body,
      classDetail.symbolTable,
      className
    );

    // Build a clean FLS-focused response
    const flsReport = {};
    for (const [objName, meta] of Object.entries(report.objects)) {
      flsReport[objName] = {
        objectAccessible: meta.accessible,
        objectCreateable: meta.createable,
        flsSummary: meta.flsSummary || { fullAccess: [], readOnly: [], noAccess: [] },
        totalFields: (meta.usedFields || []).length,
      };
    }

    const totalNoAccess = Object.values(flsReport)
      .reduce((sum, obj) => sum + (obj.flsSummary.noAccess?.length || 0), 0);
    const totalReadOnly = Object.values(flsReport)
      .reduce((sum, obj) => sum + (obj.flsSummary.readOnly?.length || 0), 0);
    const totalFullAccess = Object.values(flsReport)
      .reduce((sum, obj) => sum + (obj.flsSummary.fullAccess?.length || 0), 0);

    res.json({
      className,
      objects: flsReport,
      summary: {
        totalObjects: Object.keys(flsReport).length,
        totalFields: totalFullAccess + totalReadOnly + totalNoAccess,
        fullAccess: totalFullAccess,
        readOnly: totalReadOnly,
        noAccess: totalNoAccess,
        hasIssues: totalNoAccess > 0,
      },
    });
  } catch (err) {
    console.error(`[FLS Check] Error for ${className}:`, err.message);
    res.status(500).json({ error: 'Failed to check FLS', details: err.message });
  }
});

const auditLogger = require('../services/auditLogger');

/**
 * GET /api/audit/history
 * Get full history of test generation runs with aggregated summary.
 */
router.get('/audit/history', (req, res) => {
  try {
    const history = auditLogger.getHistory();
    const summary = auditLogger.getSummary();
    res.json({ history, summary });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve audit history', details: err.message });
  }
});

/**
 * GET /api/audit/export/csv
 * Export full audit history as a downloadable CSV spreadsheet.
 */
router.get('/audit/export/csv', (req, res) => {
  try {
    const csvContent = auditLogger.exportCSV();
    const filename = `apex_test_harness_audit_${new Date().toISOString().split('T')[0]}.csv`;
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
  } catch (err) {
    res.status(500).json({ error: 'Failed to export audit CSV', details: err.message });
  }
});

/**
 * GET /api/audit/export/json
 * Export full audit history as a downloadable JSON file.
 */
router.get('/audit/export/json', (req, res) => {
  try {
    const history = auditLogger.getHistory();
    const summary = auditLogger.getSummary();
    const payload = JSON.stringify({ summary, history }, null, 2);
    const filename = `apex_test_harness_audit_${new Date().toISOString().split('T')[0]}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(payload);
  } catch (err) {
    res.status(500).json({ error: 'Failed to export audit JSON', details: err.message });
  }
});

/**
 * DELETE /api/audit/clear
 * Clear all audit history.
 */
router.delete('/audit/clear', (req, res) => {
  try {
    auditLogger.clearHistory();
    res.json({ success: true, message: 'Audit history cleared' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear audit history', details: err.message });
  }
});

module.exports = router;
