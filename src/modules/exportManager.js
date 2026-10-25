/**
 * Module F — Traceability and Output
 *
 * - Produces a Requirement Traceability Matrix (RTM)
 * - Exports to Excel (.xlsx), CSV, and JSON
 * - Supports a QA review step (edit, approve, regenerate)
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const config = require('../../config/default');
const { createModuleLogger } = require('../services/logger');

const log = createModuleLogger('ExportManager');

class ExportManager {
  constructor() {
    this.outputDir = path.resolve(config.paths.output);
    if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });
  }

  // ──────────────────────────────────────────────────────
  //  Requirement Traceability Matrix
  // ──────────────────────────────────────────────────────

  buildRTM(brdResult, testCaseResult, mappingResult) {
    log.info('Building Requirement Traceability Matrix...');

    const rtm = brdResult.requirements.map(req => {
      const testCases = testCaseResult.test_cases.filter(tc => tc.requirement_id === req.id);
      const mapping = mappingResult.mappings.find(m => m.requirement_id === req.id);

      return {
        requirement_id: req.id,
        requirement_title: req.title,
        requirement_module: req.module,
        requirement_priority: req.priority,
        is_vague: req.is_vague || false,
        mapped_pages: mapping?.mapped_pages?.map(p => p.title || p.url).join('; ') || 'N/A',
        coverage_status: mapping?.coverage || 'none',
        test_case_count: testCases.length,
        test_case_ids: testCases.map(tc => tc.test_case_id).join(', '),
        test_types_covered: [...new Set(testCases.map(tc => tc.test_type))].join(', '),
        status: testCases.length > 0 ? 'Covered' : 'Not Covered',
      };
    });

    const summary = {
      total_requirements: rtm.length,
      covered: rtm.filter(r => r.status === 'Covered').length,
      not_covered: rtm.filter(r => r.status === 'Not Covered').length,
      coverage_percent: rtm.length > 0
        ? Math.round((rtm.filter(r => r.status === 'Covered').length / rtm.length) * 100)
        : 0,
      total_test_cases: testCaseResult.test_cases.length,
      vague_requirements: rtm.filter(r => r.is_vague).length,
    };

    log.info(`RTM built: ${summary.covered}/${summary.total_requirements} requirements covered `
      + `(${summary.coverage_percent}%)`);

    return { rtm, summary };
  }

  // ──────────────────────────────────────────────────────
  //  Excel Export
  // ──────────────────────────────────────────────────────

  async exportToExcel(testCaseResult, rtmResult, gapReport, fileName = 'test-output.xlsx') {
    log.info('Exporting to Excel...');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'AL-FS-01 BRD Test Generator';
    workbook.created = new Date();

    // ── Sheet 1: Test Cases ──
    const tcSheet = workbook.addWorksheet('Test Cases', {
      properties: { tabColor: { argb: '4472C4' } },
    });
    tcSheet.columns = [
      { header: 'Test Case ID', key: 'test_case_id', width: 14 },
      { header: 'Requirement ID', key: 'requirement_id', width: 16 },
      { header: 'Module', key: 'module', width: 20 },
      { header: 'Title', key: 'title', width: 40 },
      { header: 'Preconditions', key: 'preconditions', width: 35 },
      { header: 'Test Steps', key: 'test_steps', width: 50 },
      { header: 'Test Data', key: 'test_data', width: 30 },
      { header: 'Expected Result', key: 'expected_result', width: 40 },
      { header: 'Priority', key: 'priority', width: 12 },
      { header: 'Test Type', key: 'test_type', width: 18 },
      { header: 'Role', key: 'role', width: 14 },
      { header: 'Status', key: 'status', width: 14 },
    ];

    this._styleHeaderRow(tcSheet);

    for (const tc of testCaseResult.test_cases) {
      tcSheet.addRow({
        test_case_id: tc.test_case_id,
        requirement_id: tc.requirement_id,
        module: tc.module,
        title: tc.title,
        preconditions: Array.isArray(tc.preconditions) ? tc.preconditions.join('\n') : tc.preconditions,
        test_steps: Array.isArray(tc.test_steps) ? tc.test_steps.join('\n') : tc.test_steps,
        test_data: typeof tc.test_data === 'object' ? JSON.stringify(tc.test_data) : tc.test_data,
        expected_result: tc.expected_result,
        priority: tc.priority,
        test_type: tc.test_type,
        role: tc.role,
        status: 'Draft',
      });
    }

    // ── Sheet 2: RTM ──
    const rtmSheet = workbook.addWorksheet('Traceability Matrix', {
      properties: { tabColor: { argb: '70AD47' } },
    });
    rtmSheet.columns = [
      { header: 'Requirement ID', key: 'requirement_id', width: 16 },
      { header: 'Title', key: 'requirement_title', width: 35 },
      { header: 'Module', key: 'requirement_module', width: 20 },
      { header: 'Priority', key: 'requirement_priority', width: 12 },
      { header: 'Mapped Pages', key: 'mapped_pages', width: 30 },
      { header: 'Coverage', key: 'coverage_status', width: 14 },
      { header: '# Test Cases', key: 'test_case_count', width: 14 },
      { header: 'Test Case IDs', key: 'test_case_ids', width: 30 },
      { header: 'Test Types', key: 'test_types_covered', width: 25 },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Vague?', key: 'is_vague', width: 10 },
    ];

    this._styleHeaderRow(rtmSheet);

    for (const row of rtmResult.rtm) {
      const addedRow = rtmSheet.addRow(row);
      // Color-code coverage
      const statusCell = addedRow.getCell('status');
      if (row.status === 'Covered') {
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'C6EFCE' } };
      } else {
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC7CE' } };
      }
    }

    // RTM Summary row
    rtmSheet.addRow({});
    rtmSheet.addRow({
      requirement_id: 'SUMMARY',
      requirement_title: `${rtmResult.summary.covered}/${rtmResult.summary.total_requirements} covered`,
      requirement_module: `${rtmResult.summary.coverage_percent}%`,
      requirement_priority: '',
      mapped_pages: '',
      coverage_status: '',
      test_case_count: rtmResult.summary.total_test_cases,
    });

    // ── Sheet 3: Gap Report ──
    if (gapReport) {
      const gapSheet = workbook.addWorksheet('Gap Report', {
        properties: { tabColor: { argb: 'FF6347' } },
      });
      gapSheet.columns = [
        { header: 'Gap Type', key: 'gap_type', width: 25 },
        { header: 'ID / URL', key: 'identifier', width: 30 },
        { header: 'Title / Description', key: 'description', width: 40 },
        { header: 'Reason', key: 'reason', width: 40 },
      ];

      this._styleHeaderRow(gapSheet);

      if (gapReport.unmapped_requirements) {
        for (const gap of gapReport.unmapped_requirements) {
          gapSheet.addRow({
            gap_type: 'Requirement without feature',
            identifier: gap.requirement_id,
            description: gap.requirement_title,
            reason: gap.reason,
          });
        }
      }
      if (gapReport.unmapped_features) {
        for (const gap of gapReport.unmapped_features) {
          gapSheet.addRow({
            gap_type: 'Feature without requirement',
            identifier: gap.page_url,
            description: gap.feature_description,
            reason: gap.reason,
          });
        }
      }
    }

    const filePath = path.join(this.outputDir, fileName);
    await workbook.xlsx.writeFile(filePath);
    log.info(`Excel exported: ${filePath}`);
    return filePath;
  }

  // ──────────────────────────────────────────────────────
  //  CSV Export
  // ──────────────────────────────────────────────────────

  exportToCSV(testCaseResult, fileName = 'test-cases.csv') {
    log.info('Exporting to CSV...');
    const headers = [
      'Test Case ID', 'Requirement ID', 'Module', 'Title',
      'Preconditions', 'Test Steps', 'Test Data', 'Expected Result',
      'Priority', 'Test Type', 'Role',
    ];

    const rows = testCaseResult.test_cases.map(tc => [
      tc.test_case_id,
      tc.requirement_id,
      tc.module,
      `"${(tc.title || '').replace(/"/g, '""')}"`,
      `"${(Array.isArray(tc.preconditions) ? tc.preconditions.join('; ') : tc.preconditions || '').replace(/"/g, '""')}"`,
      `"${(Array.isArray(tc.test_steps) ? tc.test_steps.join('; ') : tc.test_steps || '').replace(/"/g, '""')}"`,
      `"${(typeof tc.test_data === 'object' ? JSON.stringify(tc.test_data) : tc.test_data || '').replace(/"/g, '""')}"`,
      `"${(tc.expected_result || '').replace(/"/g, '""')}"`,
      tc.priority,
      tc.test_type,
      tc.role,
    ].join(','));

    const csv = [headers.join(','), ...rows].join('\n');
    const filePath = path.join(this.outputDir, fileName);
    fs.writeFileSync(filePath, csv, 'utf-8');
    log.info(`CSV exported: ${filePath}`);
    return filePath;
  }

  // ──────────────────────────────────────────────────────
  //  JSON Export
  // ──────────────────────────────────────────────────────

  exportToJSON(data, fileName = 'test-output.json') {
    const filePath = path.join(this.outputDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    log.info(`JSON exported: ${filePath}`);
    return filePath;
  }

  // ──────────────────────────────────────────────────────
  //  QA Review Helpers
  // ──────────────────────────────────────────────────────

  /**
   * Update a test case's status (approve / reject / edit).
   */
  updateTestCaseStatus(testCases, testCaseId, updates) {
    const tc = testCases.find(t => t.test_case_id === testCaseId);
    if (!tc) throw new Error(`Test case ${testCaseId} not found`);
    Object.assign(tc, updates);
    log.info(`Test case ${testCaseId} updated: ${JSON.stringify(updates)}`);
    return tc;
  }

  // ── Style helpers ──────────────────────────────────────

  _styleHeaderRow(sheet) {
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' }, size: 11 };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '2F5496' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    headerRow.height = 25;
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheet.columns.length },
    };
  }
}

module.exports = { ExportManager };
