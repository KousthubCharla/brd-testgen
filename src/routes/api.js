/**
 * API Routes — REST endpoints for every step of the pipeline.
 *
 * POST /api/brd/upload          → Module A: Parse BRD
 * POST /api/crawl/start         → Module B: Start crawling
 * GET  /api/crawl/status        → Crawl status
 * POST /api/model/build         → Module C: Build knowledge model
 * GET  /api/model/load          → Load saved model
 * GET  /api/model/list          → List saved models
 * POST /api/mapping/run         → Module D: Map requirements
 * POST /api/testcases/generate  → Module E: Generate test cases
 * POST /api/testcases/regenerate → Regenerate for one requirement
 * PUT  /api/testcases/:id       → QA review: edit/approve
 * POST /api/export/excel        → Module F: Export Excel
 * POST /api/export/csv          → Module F: Export CSV
 * POST /api/export/json         → Module F: Export JSON
 * POST /api/pipeline/run        → Run full pipeline
 * GET  /api/stats               → Usage & cost stats
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { parseBRD } = require('../modules/brdParser');
const { AppCrawler } = require('../modules/appCrawler');
const { KnowledgeModelBuilder } = require('../modules/knowledgeModel');
const { RequirementMapper } = require('../modules/requirementMapper');
const { TestCaseGenerator } = require('../modules/testCaseGenerator');
const { ExportManager } = require('../modules/exportManager');
const { getLLMService } = require('../services/llmService');
const { createModuleLogger } = require('../services/logger');

const log = createModuleLogger('API');
const router = express.Router();

// ── File upload config ───────────────────────────────────
const uploadDir = path.resolve('uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.docx', '.txt', '.md'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${ext}. Allowed: ${allowed.join(', ')}`));
  },
});

// ── In-memory session state ──────────────────────────────
// In production this would be Redis / DB; for the assessment, in-memory is fine.
const state = {
  brdResult: null,
  crawlResults: null,
  knowledgeModel: null,
  mappingResult: null,
  testCaseResult: null,
  rtmResult: null,
  pipelineStatus: 'idle', // idle | running | complete | error
  pipelineProgress: [],
  error: null,
};

// ── Helpers ──────────────────────────────────────────────

function ok(res, data) { res.json({ success: true, data }); }
function fail(res, msg, status = 400) { res.status(status).json({ success: false, error: msg }); }

function addProgress(step, status, detail = '') {
  state.pipelineProgress.push({
    step, status, detail, timestamp: new Date().toISOString(),
  });
}

// ══════════════════════════════════════════════════════════
//  A. BRD Upload & Parse
// ══════════════════════════════════════════════════════════

router.post('/brd/upload', upload.single('brd'), async (req, res) => {
  try {
    if (!req.file) return fail(res, 'No BRD file uploaded');

    const originalExt = path.extname(req.file.originalname).toLowerCase();
    const newPath = req.file.path + originalExt;
    fs.renameSync(req.file.path, newPath);

    log.info(`BRD uploaded: ${req.file.originalname}`);
    addProgress('BRD Upload', 'complete', req.file.originalname);

    state.brdResult = await parseBRD(newPath);
    addProgress('BRD Parsing', 'complete',
      `${state.brdResult.requirements.length} requirements extracted`);

    ok(res, {
      fileName: req.file.originalname,
      brdResult: state.brdResult,
    });
  } catch (err) {
    log.error(`BRD upload failed: ${err.message}`);
    addProgress('BRD Parsing', 'error', err.message);
    fail(res, err.message, 500);
  }
});

// ══════════════════════════════════════════════════════════
//  B. Application Crawling
// ══════════════════════════════════════════════════════════

router.post('/crawl/start', async (req, res) => {
  try {
    const { appUrl, roles, options } = req.body;

    // Use body roles or fallback to env config
    const crawlRoles = roles || {};
    const url = appUrl || require('../../config/default').app.url;

    if (!url) return fail(res, 'No application URL provided');
    if (Object.keys(crawlRoles).length === 0) {
      const envRoles = require('../../config/default').app.roles;
      if (Object.keys(envRoles).length === 0) {
        return fail(res, 'No roles configured');
      }
      Object.assign(crawlRoles, envRoles);
    }

    addProgress('Crawling', 'running', `Starting crawl for ${Object.keys(crawlRoles).length} role(s)`);

    const crawler = new AppCrawler(url, options);
    const results = [];

    for (const [roleName, creds] of Object.entries(crawlRoles)) {
      addProgress('Crawling', 'running', `Crawling as ${roleName}...`);
      const result = await crawler.crawlForRole(roleName, creds);
      results.push(result);
      addProgress('Crawling', 'running',
        `${roleName}: ${result.pages.length} pages crawled`);
    }

    state.crawlResults = results;
    addProgress('Crawling', 'complete',
      `${results.reduce((a, r) => a + r.pages.length, 0)} total pages crawled`);

    ok(res, { crawlResults: results });
  } catch (err) {
    log.error(`Crawl failed: ${err.message}`);
    addProgress('Crawling', 'error', err.message);
    fail(res, err.message, 500);
  }
});

router.get('/crawl/status', (req, res) => {
  ok(res, {
    hasCrawlData: !!state.crawlResults,
    roles: state.crawlResults?.map(r => ({
      role: r.role,
      pages: r.pages.length,
    })) || [],
  });
});

// ══════════════════════════════════════════════════════════
//  C. Knowledge Model
// ══════════════════════════════════════════════════════════

router.post('/model/build', (req, res) => {
  try {
    if (!state.crawlResults) return fail(res, 'No crawl data. Run crawl first.');

    const builder = new KnowledgeModelBuilder();
    state.knowledgeModel = builder.build(state.crawlResults);
    const savedPath = builder.save(state.knowledgeModel);

    addProgress('Knowledge Model', 'complete',
      `${state.knowledgeModel.summary.totalPages} pages, ${state.knowledgeModel.summary.totalFields} fields`);

    ok(res, { knowledgeModel: state.knowledgeModel, savedPath });
  } catch (err) {
    log.error(`Model build failed: ${err.message}`);
    addProgress('Knowledge Model', 'error', err.message);
    fail(res, err.message, 500);
  }
});

router.get('/model/load', (req, res) => {
  try {
    const { fileName } = req.query;
    const builder = new KnowledgeModelBuilder();
    const model = builder.load(fileName || 'knowledge-model.json');
    if (!model) return fail(res, 'No saved model found', 404);
    state.knowledgeModel = model;
    ok(res, { knowledgeModel: model });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

router.get('/model/list', (req, res) => {
  const builder = new KnowledgeModelBuilder();
  ok(res, { models: builder.listSavedModels() });
});

// ══════════════════════════════════════════════════════════
//  D. Requirement Mapping
// ══════════════════════════════════════════════════════════

router.post('/mapping/run', async (req, res) => {
  try {
    if (!state.brdResult) return fail(res, 'No BRD parsed. Upload a BRD first.');
    if (!state.knowledgeModel) return fail(res, 'No knowledge model. Build model first.');

    addProgress('Requirement Mapping', 'running', 'Mapping requirements to application...');

    const mapper = new RequirementMapper();
    state.mappingResult = await mapper.mapRequirements(state.brdResult, state.knowledgeModel);

    addProgress('Requirement Mapping', 'complete',
      `${state.mappingResult.stats.coveragePercent}% coverage`);

    ok(res, { mappingResult: state.mappingResult });
  } catch (err) {
    log.error(`Mapping failed: ${err.message}`);
    addProgress('Requirement Mapping', 'error', err.message);
    fail(res, err.message, 500);
  }
});

// ══════════════════════════════════════════════════════════
//  E. Test Case Generation
// ══════════════════════════════════════════════════════════

router.post('/testcases/generate', async (req, res) => {
  try {
    if (!state.brdResult) return fail(res, 'No BRD parsed.');
    if (!state.knowledgeModel) return fail(res, 'No knowledge model.');
    if (!state.mappingResult) return fail(res, 'No mapping result. Run mapping first.');

    addProgress('Test Case Generation', 'running', 'Generating contextual test cases...');

    const generator = new TestCaseGenerator();
    state.testCaseResult = await generator.generateAll(
      state.brdResult, state.knowledgeModel, state.mappingResult,
    );

    addProgress('Test Case Generation', 'complete',
      `${state.testCaseResult.test_cases.length} test cases generated`);

    ok(res, { testCaseResult: state.testCaseResult });
  } catch (err) {
    log.error(`Test generation failed: ${err.message}`);
    addProgress('Test Case Generation', 'error', err.message);
    fail(res, err.message, 500);
  }
});

router.post('/testcases/regenerate', async (req, res) => {
  try {
    const { requirementId, feedback } = req.body;
    if (!requirementId) return fail(res, 'requirementId is required');

    const generator = new TestCaseGenerator();
    const newCases = await generator.regenerateForRequirement(
      requirementId, state.brdResult, state.knowledgeModel, state.mappingResult, feedback,
    );

    // Replace old cases for this requirement
    if (state.testCaseResult) {
      state.testCaseResult.test_cases = state.testCaseResult.test_cases
        .filter(tc => tc.requirement_id !== requirementId);
      state.testCaseResult.test_cases.push(...newCases);
    }

    ok(res, { regeneratedCases: newCases });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

// QA Review: update test case
router.put('/testcases/:id', (req, res) => {
  try {
    if (!state.testCaseResult) return fail(res, 'No test cases generated');
    const exporter = new ExportManager();
    const updated = exporter.updateTestCaseStatus(
      state.testCaseResult.test_cases, req.params.id, req.body,
    );
    ok(res, { testCase: updated });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

// ══════════════════════════════════════════════════════════
//  F. Export
// ══════════════════════════════════════════════════════════

router.post('/export/excel', async (req, res) => {
  try {
    if (!state.testCaseResult) return fail(res, 'No test cases to export');

    const exporter = new ExportManager();
    const rtm = exporter.buildRTM(state.brdResult, state.testCaseResult, state.mappingResult);
    state.rtmResult = rtm;

    const filePath = await exporter.exportToExcel(
      state.testCaseResult, rtm, state.mappingResult,
    );

    addProgress('Export', 'complete', `Excel: ${path.basename(filePath)}`);
    res.download(filePath);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

router.post('/export/csv', (req, res) => {
  try {
    if (!state.testCaseResult) return fail(res, 'No test cases to export');
    const exporter = new ExportManager();
    const filePath = exporter.exportToCSV(state.testCaseResult);
    addProgress('Export', 'complete', `CSV: ${path.basename(filePath)}`);
    res.download(filePath);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

router.post('/export/json', (req, res) => {
  try {
    const data = {
      brd: state.brdResult,
      knowledgeModel: state.knowledgeModel,
      mapping: state.mappingResult,
      testCases: state.testCaseResult,
      rtm: state.rtmResult,
    };
    const exporter = new ExportManager();
    const filePath = exporter.exportToJSON(data);
    addProgress('Export', 'complete', `JSON: ${path.basename(filePath)}`);
    res.download(filePath);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

// ══════════════════════════════════════════════════════════
//  Full Pipeline
// ══════════════════════════════════════════════════════════

router.post('/pipeline/run', upload.single('brd'), async (req, res) => {
  try {
    state.pipelineStatus = 'running';
    state.pipelineProgress = [];
    state.error = null;

    const startTime = Date.now();

    // --- Step A: Parse BRD ---
    if (!req.file) return fail(res, 'No BRD file uploaded');
    const originalExt = path.extname(req.file.originalname).toLowerCase();
    const newPath = req.file.path + originalExt;
    fs.renameSync(req.file.path, newPath);
    addProgress('A. BRD Understanding', 'running', 'Parsing BRD...');
    state.brdResult = await parseBRD(newPath);
    addProgress('A. BRD Understanding', 'complete',
      `${state.brdResult.requirements.length} requirements extracted`);

    // --- Step B: Crawl Application ---
    const appUrl = req.body.appUrl || require('../../config/default').app.url;
    let roles = {};
    try { roles = JSON.parse(req.body.roles || '{}'); } catch { /* use env */ }
    if (Object.keys(roles).length === 0) roles = require('../../config/default').app.roles;

    if (appUrl && Object.keys(roles).length > 0) {
      addProgress('B. Application Exploration', 'running', 'Crawling application...');
      const crawler = new AppCrawler(appUrl, JSON.parse(req.body.crawlOptions || '{}'));
      state.crawlResults = [];
      for (const [roleName, creds] of Object.entries(roles)) {
        const result = await crawler.crawlForRole(roleName, creds);
        state.crawlResults.push(result);
      }
      addProgress('B. Application Exploration', 'complete',
        `${state.crawlResults.reduce((a, r) => a + r.pages.length, 0)} pages crawled`);
    } else {
      addProgress('B. Application Exploration', 'skipped', 'No URL or roles configured');
      state.crawlResults = [];
    }

    // --- Step C: Knowledge Model ---
    addProgress('C. Knowledge Model', 'running', 'Building knowledge model...');
    const builder = new KnowledgeModelBuilder();
    if (state.crawlResults.length > 0) {
      state.knowledgeModel = builder.build(state.crawlResults);
      builder.save(state.knowledgeModel);
    } else {
      // Minimal model from BRD alone
      state.knowledgeModel = {
        pageInventory: [],
        elementMap: [],
        workflowGraph: { nodes: [], edges: [] },
        rolePermissionMatrix: {},
        summary: { totalPages: 0, totalFields: 0, totalButtons: 0, totalRoles: 0 },
      };
    }
    addProgress('C. Knowledge Model', 'complete',
      `${state.knowledgeModel.summary.totalPages} pages modelled`);

    // --- Step D: Mapping ---
    addProgress('D. Requirement Mapping', 'running', 'Mapping requirements...');
    const mapper = new RequirementMapper();
    state.mappingResult = await mapper.mapRequirements(state.brdResult, state.knowledgeModel);
    addProgress('D. Requirement Mapping', 'complete',
      `${state.mappingResult.stats.coveragePercent}% coverage`);

    // --- Step E: Test Case Generation ---
    addProgress('E. Test Case Generation', 'running', 'Generating test cases...');
    const generator = new TestCaseGenerator();
    state.testCaseResult = await generator.generateAll(
      state.brdResult, state.knowledgeModel, state.mappingResult,
    );
    addProgress('E. Test Case Generation', 'complete',
      `${state.testCaseResult.test_cases.length} test cases generated`);

    // --- Step F: Traceability ---
    addProgress('F. Traceability & Output', 'running', 'Building RTM and exports...');
    const exporter = new ExportManager();
    state.rtmResult = exporter.buildRTM(state.brdResult, state.testCaseResult, state.mappingResult);

    const excelPath = await exporter.exportToExcel(state.testCaseResult, state.rtmResult, state.mappingResult);
    const csvPath = exporter.exportToCSV(state.testCaseResult);
    const jsonPath = exporter.exportToJSON({
      brd: state.brdResult,
      knowledgeModel: state.knowledgeModel,
      mapping: state.mappingResult,
      testCases: state.testCaseResult,
      rtm: state.rtmResult,
    });

    addProgress('F. Traceability & Output', 'complete', 'All exports ready');

    const totalTime = Date.now() - startTime;
    const llmStats = getLLMService().getUsageStats();

    state.pipelineStatus = 'complete';

    ok(res, {
      pipelineStatus: 'complete',
      progress: state.pipelineProgress,
      summary: {
        requirements: state.brdResult.requirements.length,
        pagesCrawled: state.crawlResults.reduce((a, r) => a + r.pages.length, 0),
        testCasesGenerated: state.testCaseResult.test_cases.length,
        rtmCoverage: state.rtmResult.summary.coverage_percent + '%',
        totalTimeMs: totalTime,
        llmStats,
      },
      exports: {
        excel: path.basename(excelPath),
        csv: path.basename(csvPath),
        json: path.basename(jsonPath),
      },
      brdResult: state.brdResult,
      mappingResult: state.mappingResult,
      testCaseResult: state.testCaseResult,
      rtmResult: state.rtmResult,
    });
  } catch (err) {
    state.pipelineStatus = 'error';
    state.error = err.message;
    log.error(`Pipeline failed: ${err.message}`);
    addProgress('Pipeline', 'error', err.message);
    fail(res, err.message, 500);
  }
});

// ══════════════════════════════════════════════════════════
//  Stats & State
// ══════════════════════════════════════════════════════════

router.get('/stats', (req, res) => {
  const llmStats = getLLMService().getUsageStats();
  ok(res, {
    pipelineStatus: state.pipelineStatus,
    progress: state.pipelineProgress,
    llm: llmStats,
    data: {
      hasBRD: !!state.brdResult,
      hasCrawl: !!state.crawlResults,
      hasModel: !!state.knowledgeModel,
      hasMapping: !!state.mappingResult,
      hasTestCases: !!state.testCaseResult,
      hasRTM: !!state.rtmResult,
    },
  });
});

router.get('/state', (req, res) => {
  ok(res, {
    brd: state.brdResult ? {
      fileName: state.brdResult.fileName,
      requirements: state.brdResult.requirements.length,
      actors: state.brdResult.actors,
    } : null,
    crawl: state.crawlResults?.map(r => ({
      role: r.role,
      pages: r.pages.length,
    })) || null,
    model: state.knowledgeModel?.summary || null,
    mapping: state.mappingResult?.stats || null,
    testCases: state.testCaseResult?.stats || null,
    rtm: state.rtmResult?.summary || null,
    pipelineStatus: state.pipelineStatus,
  });
});

// Download outputs
router.get('/download/:filename', (req, res) => {
  const filePath = path.join(path.resolve(require('../../config/default').paths.output), req.params.filename);
  if (!fs.existsSync(filePath)) return fail(res, 'File not found', 404);
  res.download(filePath);
});

module.exports = router;
