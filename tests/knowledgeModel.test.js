/**
 * tests/knowledgeModel.test.js
 * Tests for Module C — Knowledge Model Builder
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { KnowledgeModelBuilder } = require('../src/modules/knowledgeModel');

const MOCK_CRAWL = [
  {
    role: 'admin',
    pages: [
      {
        url: 'https://app.example.com/dashboard',
        title: 'Dashboard',
        heading: 'Admin Dashboard',
        depth: 0,
        forms: [],
        buttons: [{ text: 'Add User', type: 'button', isDestructive: false }],
        navigation: [{ text: 'Users', href: 'https://app.example.com/users' }],
        tables: [],
        tabs: [],
        modals: [],
        errorMessages: [],
      },
      {
        url: 'https://app.example.com/users',
        title: 'Users',
        heading: 'User Management',
        depth: 1,
        forms: [{
          id: 'form-0',
          fields: [
            { tag: 'input', type: 'text', name: 'username', label: 'Username', required: true, maxLength: 50 },
            { tag: 'input', type: 'email', name: 'email', label: 'Email', required: true },
          ],
        }],
        buttons: [{ text: 'Save', type: 'submit', isDestructive: false }],
        navigation: [],
        tables: [{ id: 'users-table', headers: ['Name', 'Email', 'Role'], rowCount: 5 }],
        tabs: [],
        modals: [],
        errorMessages: [],
      },
    ],
    crawlLog: [],
    stats: { pagesVisited: 2, urlsSkipped: 0, crawlTimeMs: 1000 },
  },
];

describe('KnowledgeModelBuilder', () => {
  it('should build a model from crawl results', () => {
    const builder = new KnowledgeModelBuilder();
    const model = builder.build(MOCK_CRAWL);

    assert.equal(model.pageInventory.length, 2, 'Should have 2 pages');
    assert.equal(model.summary.totalPages, 2);
    assert.ok(model.summary.totalFields >= 2, 'Should have at least 2 fields');
    assert.ok(model.workflowGraph.edges.length >= 1, 'Should have at least 1 edge');
    assert.ok(model.rolePermissionMatrix['admin'], 'Admin role should exist');
  });

  it('should identify page types correctly', () => {
    const builder = new KnowledgeModelBuilder();
    const type = builder._inferPageType({ forms: [{ fields: [] }], tables: [], url: 'https://x.com/form' });
    assert.equal(type, 'form', 'Page with forms should be type "form"');
  });

  it('should build role-permission matrix', () => {
    const builder = new KnowledgeModelBuilder();
    const model = builder.build(MOCK_CRAWL);
    assert.ok(model.rolePermissionMatrix['admin'].totalPages >= 2);
  });
});
