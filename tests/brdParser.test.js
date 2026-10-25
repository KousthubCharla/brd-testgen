/**
 * tests/brdParser.test.js
 * Tests for Module A — BRD Parser
 * Run with: node --test tests/
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// ── Helpers ──────────────────────────────────────────────────
const { extractText } = require('../src/modules/brdParser');

describe('BRD Parser — extractText()', () => {
  it('should extract text from a TXT file', async () => {
    const tmpFile = path.join(__dirname, '_tmp_test.txt');
    fs.writeFileSync(tmpFile, 'Hello BRD World\nRequirement 1: Users can log in.');
    const text = await extractText(tmpFile);
    assert.ok(text.includes('Hello BRD World'), 'Should contain file content');
    fs.unlinkSync(tmpFile);
  });

  it('should throw for unsupported file types', async () => {
    const tmpFile = path.join(__dirname, '_tmp_test.xyz');
    fs.writeFileSync(tmpFile, 'test');
    await assert.rejects(() => extractText(tmpFile), /Unsupported BRD file type/);
    fs.unlinkSync(tmpFile);
  });
});
