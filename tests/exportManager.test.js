/**
 * tests/exportManager.test.js
 * Tests for Module F — Export Manager
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ExportManager } = require('../src/modules/exportManager');

const MOCK_TC_RESULT = {
  test_cases: [
    {
      test_case_id: 'TC-001',
      requirement_id: 'REQ-001',
      module: 'Authentication',
      title: 'Verify login with valid credentials',
      preconditions: ['App is running', 'User account exists'],
      test_steps: ['1. Navigate to Login page', '2. Enter username', '3. Click Login'],
      test_data: { username: 'testuser', password: '***' },
      expected_result: 'User is redirected to Dashboard',
      priority: 'Critical',
      test_type: 'positive',
      role: 'admin',
    },
  ],
  stats: { totalTestCases: 1 },
};

const MOCK_BRD = {
  requirements: [{
    id: 'REQ-001', title: 'Login', module: 'Auth', priority: 'Critical', is_vague: false,
  }],
};

const MOCK_MAPPING = {
  mappings: [{ requirement_id: 'REQ-001', mapped_pages: [{ title: 'Login Page', url: '/login' }], coverage: 'full' }],
  unmapped_requirements: [],
  unmapped_features: [],
};

describe('ExportManager', () => {
  let csvPath, excelPath, jsonPath;

  it('should export CSV', () => {
    const exp = new ExportManager();
    csvPath = exp.exportToCSV(MOCK_TC_RESULT, 'test-export.csv');
    assert.ok(fs.existsSync(csvPath), 'CSV file should exist');
    const content = fs.readFileSync(csvPath, 'utf-8');
    assert.ok(content.includes('TC-001'), 'CSV should contain test case ID');
  });

  it('should export JSON', () => {
    const exp = new ExportManager();
    jsonPath = exp.exportToJSON({ testCases: MOCK_TC_RESULT }, 'test-export.json');
    assert.ok(fs.existsSync(jsonPath), 'JSON file should exist');
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    assert.equal(data.testCases.test_cases[0].test_case_id, 'TC-001');
  });

  it('should build RTM correctly', () => {
    const exp = new ExportManager();
    const rtm = exp.buildRTM(MOCK_BRD, MOCK_TC_RESULT, MOCK_MAPPING);
    assert.equal(rtm.rtm.length, 1, 'Should have 1 RTM entry');
    assert.equal(rtm.summary.coverage_percent, 100, 'Should be 100% coverage');
  });

  it('should update test case status', () => {
    const exp = new ExportManager();
    const tcs = [...MOCK_TC_RESULT.test_cases];
    const updated = exp.updateTestCaseStatus(tcs, 'TC-001', { status: 'approved' });
    assert.equal(updated.status, 'approved');
  });

  after(() => {
    // Cleanup test files
    [csvPath, jsonPath].forEach(f => { try { if (f) fs.unlinkSync(f); } catch { /* ok */ } });
  });
});
