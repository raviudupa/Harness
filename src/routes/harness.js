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
function requireAuth(req, res, next) {
  if (!salesforceAuth.isAuthenticated(req.session)) {
    return res.status(401).json({ error: 'Not authenticated. Please login to Salesforce first.' });
  }
  next();
}

/**
 * GET /api/classes
 * List all non-test Apex classes in the org.
 */
router.get('/classes', requireAuth, async (req, res) => {
  try {
    const conn = salesforceAuth.getConnection(req.session);
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
    const conn = salesforceAuth.getConnection(req.session);
    const detail = await apexClassService.getApexClassDetail(conn, req.params.name);
    res.json(detail);
  } catch (err) {
    console.error(`[Harness API] Error fetching class ${req.params.name}:`, err.message);
    res.status(500).json({ error: `Failed to fetch class: ${req.params.name}`, details: err.message });
  }
});

/**
 * POST /api/harness/run
 * Execute the full harness pipeline for a given class.
 * Body: { className: "MyApexClass" }
 */
router.post('/harness/run', requireAuth, async (req, res) => {
  const { className } = req.body;

  if (!className) {
    return res.status(400).json({ error: 'Missing className in request body' });
  }

  const conn = salesforceAuth.getConnection(req.session);
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  // Initialize job tracking
  activeJobs.set(jobId, {
    status: 'running',
    className,
    progress: [],
    result: null,
    startTime: Date.now(),
  });

  // Start the harness asynchronously
  res.json({ jobId, message: `Harness started for ${className}` });

  // Execute in background
  try {
    const result = await executeHarness(conn, className, (step, message, data) => {
      const job = activeJobs.get(jobId);
      if (job) {
        job.progress.push({ step, message, data, timestamp: Date.now() });
      }
    });

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

module.exports = router;
