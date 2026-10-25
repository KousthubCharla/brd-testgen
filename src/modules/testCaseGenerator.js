/**
 * Module E — Test Case Generation
 *
 * Generates business-specific, contextual test cases that use real
 * UI labels and navigation paths from the knowledge model.
 *
 * Covers: positive, negative, boundary value, field validation,
 *         role-based access, end-to-end business flows, and
 *         business-rule scenarios.
 *
 * Each test case includes:
 *   Test Case ID, Requirement ID, Module, Title, Preconditions,
 *   Test Steps, Test Data, Expected Result, Priority, Test Type, Role.
 *
 * Avoids duplicate and trivial test cases.
 */

const config = require('../../config/default');
const { getLLMService } = require('../services/llmService');
const { createModuleLogger } = require('../services/logger');

const log = createModuleLogger('TestCaseGen');

const SYSTEM_PROMPT = `You are a senior QA engineer generating test cases for a web application.

CRITICAL RULES:
1. Use REAL UI labels, screen names, field names, and navigation paths from the knowledge model — never generic steps like "click the button".
2. Each test case must be actionable and executable on the real application.
3. Do NOT invent screens or fields that don't exist in the knowledge model.
4. Avoid duplicate and trivial test cases.
5. Cover diverse test types as specified.

For each test case, provide ALL of these fields:
- test_case_id: "TC-XXX" format
- requirement_id: The BRD requirement this tests (e.g. "REQ-001")
- module: The application module/area
- title: Clear, descriptive title
- preconditions: What must be true before the test
- test_steps: Array of specific steps with real UI elements
- test_data: Specific data values to use
- expected_result: What should happen
- priority: Critical / High / Medium / Low
- test_type: positive / negative / boundary / field-validation / role-access / e2e / business-rule
- role: Which user role executes this test

Return JSON:
{
  "test_cases": [
    {
      "test_case_id": "TC-001",
      "requirement_id": "REQ-001",
      "module": "User Management",
      "title": "Verify admin can create new user with valid data",
      "preconditions": ["Admin is logged in", "Navigate to Users page"],
      "test_steps": [
        "1. Click 'Add User' button on the Users page",
        "2. Enter 'John Doe' in the 'Full Name' field",
        "3. Enter 'john@example.com' in the 'Email' field",
        "4. Select 'Manager' from the 'Role' dropdown",
        "5. Click 'Save' button"
      ],
      "test_data": {
        "full_name": "John Doe",
        "email": "john@example.com",
        "role": "Manager"
      },
      "expected_result": "New user is created successfully. Success message is displayed. User appears in the users list.",
      "priority": "High",
      "test_type": "positive",
      "role": "admin"
    }
  ]
}`;

class TestCaseGenerator {
  constructor() {
    this.llm = getLLMService();
    this.generatedCases = [];
  }

  /**
   * Generate test cases for all mapped requirements.
   * @param {object} brdResult — output of parseBRD()
   * @param {object} knowledgeModel — output of KnowledgeModelBuilder.build()
   * @param {object} mappingResult — output of RequirementMapper.mapRequirements()
   * @returns {Promise<object>} — generated test cases
   */
  async generateAll(brdResult, knowledgeModel, mappingResult) {
    const startTime = Date.now();
    this.generatedCases = [];

    const testTypes = config.testCase.types;
    const maxPerReq = config.testCase.maxPerRequirement;

    log.info(`Generating test cases — types: [${testTypes.join(', ')}], max per req: ${maxPerReq}`);

    // Group requirements by module for more contextual generation
    const moduleGroups = this._groupByModule(brdResult.requirements, mappingResult);

    let tcCounter = 1;

    for (const [moduleName, group] of Object.entries(moduleGroups)) {
      log.info(`Generating tests for module: ${moduleName} (${group.requirements.length} requirements)`);

      // Build context from knowledge model for this module
      const moduleContext = this._getModuleContext(moduleName, knowledgeModel, group);

      // Process requirements in batches
      const batchSize = 5;
      for (let i = 0; i < group.requirements.length; i += batchSize) {
        const batch = group.requirements.slice(i, i + batchSize);
        const batchMappings = batch.map(r => {
          const mapping = mappingResult.mappings.find(m => m.requirement_id === r.id);
          return { requirement: r, mapping };
        });

        const userPrompt = this._buildPrompt(batchMappings, moduleContext, testTypes, maxPerReq);

        try {
          const result = await this.llm.chatJSON(SYSTEM_PROMPT, userPrompt, {
            temperature: 0.3,
            maxTokens: 4096,
          });

          if (result.parsed?.test_cases) {
            // Re-index test case IDs
            const cases = result.parsed.test_cases.map(tc => ({
              ...tc,
              test_case_id: `TC-${String(tcCounter++).padStart(3, '0')}`,
            }));

            this.generatedCases.push(...cases);
            log.info(`Generated ${cases.length} test cases for ${moduleName} batch ${Math.floor(i / batchSize) + 1}`);
          }
        } catch (err) {
          log.error(`Test generation failed for ${moduleName}: ${err.message}`);
        }
      }
    }

    // Deduplicate
    this.generatedCases = this._deduplicateTestCases(this.generatedCases);

    // Re-index after dedup
    this.generatedCases = this.generatedCases.map((tc, idx) => ({
      ...tc,
      test_case_id: `TC-${String(idx + 1).padStart(3, '0')}`,
    }));

    const elapsed = Date.now() - startTime;
    const stats = this._computeStats(this.generatedCases, brdResult.requirements);

    log.info(
      `Test generation complete: ${this.generatedCases.length} unique test cases, `
      + `${stats.typeBreakdown.length} types, ${elapsed}ms`,
    );

    return {
      test_cases: this.generatedCases,
      stats: {
        ...stats,
        generationTimeMs: elapsed,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Regenerate test cases for a specific requirement.
   */
  async regenerateForRequirement(reqId, brdResult, knowledgeModel, mappingResult, feedback = '') {
    const req = brdResult.requirements.find(r => r.id === reqId);
    if (!req) throw new Error(`Requirement ${reqId} not found`);

    const mapping = mappingResult.mappings.find(m => m.requirement_id === reqId);
    const moduleContext = this._getModuleContext(req.module, knowledgeModel, {
      requirements: [req],
      mappings: mapping ? [mapping] : [],
    });

    const extraInstructions = feedback
      ? `\n\nThe QA reviewer provided this feedback — incorporate it:\n${feedback}`
      : '';

    const userPrompt = this._buildPrompt(
      [{ requirement: req, mapping }],
      moduleContext,
      config.testCase.types,
      config.testCase.maxPerRequirement,
    ) + extraInstructions;

    const result = await this.llm.chatJSON(SYSTEM_PROMPT, userPrompt, {
      temperature: 0.3,
      maxTokens: 4096,
    });

    return result.parsed?.test_cases || [];
  }

  // ── Private helpers ────────────────────────────────────

  _groupByModule(requirements, mappingResult) {
    const groups = {};
    for (const req of requirements) {
      const mod = req.module || 'General';
      if (!groups[mod]) {
        groups[mod] = { requirements: [], mappings: [] };
      }
      groups[mod].requirements.push(req);
      const mapping = mappingResult.mappings.find(m => m.requirement_id === req.id);
      if (mapping) groups[mod].mappings.push(mapping);
    }
    return groups;
  }

  _getModuleContext(moduleName, knowledgeModel, group) {
    // Find pages relevant to this module based on mappings
    const relevantUrls = new Set();
    for (const mapping of (group.mappings || [])) {
      if (mapping?.mapped_pages) {
        mapping.mapped_pages.forEach(p => relevantUrls.add(p.url));
      }
    }

    const relevantPages = knowledgeModel.elementMap
      .filter(e => relevantUrls.has(e.url) || relevantUrls.size === 0)
      .slice(0, 10); // Limit context size

    return {
      module: moduleName,
      pages: relevantPages.map(p => ({
        url: p.url,
        title: p.title,
        forms: p.forms.map(f => ({
          id: f.id,
          fields: f.fields.map(fi => ({
            label: fi.label,
            type: fi.type,
            required: fi.required,
            maxLength: fi.maxLength,
            minLength: fi.minLength,
            options: fi.options ? fi.options.map(o => o.text || o) : null,
          })),
        })),
        buttons: p.buttons.map(b => b.text).filter(Boolean),
        tables: p.tables,
        errorMessages: p.errorMessages,
      })),
      roles: Object.keys(knowledgeModel.rolePermissionMatrix),
    };
  }

  _buildPrompt(batchMappings, moduleContext, testTypes, maxPerReq) {
    return `## Requirements to generate test cases for:\n\n`
      + JSON.stringify(batchMappings.map(bm => ({
        requirement: {
          id: bm.requirement.id,
          title: bm.requirement.title,
          description: bm.requirement.description,
          acceptance_criteria: bm.requirement.acceptance_criteria,
          actors: bm.requirement.actors,
        },
        mapped_to: bm.mapping?.mapped_pages?.map(p => ({
          page: p.title || p.url,
          elements: p.relevant_elements,
        })) || [],
      })), null, 2)
      + `\n\n## Application Context for module "${moduleContext.module}":\n\n`
      + JSON.stringify(moduleContext, null, 2)
      + `\n\n## Instructions:\n`
      + `- Generate up to ${maxPerReq} test cases PER requirement.\n`
      + `- Required test types: ${testTypes.join(', ')}.\n`
      + `- Use REAL field labels and screen names from the context above.\n`
      + `- Available roles: ${moduleContext.roles.join(', ')}.\n`
      + `- Each test case must have ALL required fields.\n`;
  }

  _deduplicateTestCases(cases) {
    const seen = new Map();
    for (const tc of cases) {
      const key = `${tc.requirement_id}|${tc.title?.toLowerCase().trim()}|${tc.test_type}`;
      if (!seen.has(key)) {
        seen.set(key, tc);
      }
    }
    const deduped = [...seen.values()];
    const removed = cases.length - deduped.length;
    if (removed > 0) {
      log.info(`Removed ${removed} duplicate test cases`);
    }
    return deduped;
  }

  _computeStats(cases, requirements) {
    const typeBreakdown = {};
    const priorityBreakdown = {};
    const reqCoverage = {};

    for (const tc of cases) {
      typeBreakdown[tc.test_type] = (typeBreakdown[tc.test_type] || 0) + 1;
      priorityBreakdown[tc.priority] = (priorityBreakdown[tc.priority] || 0) + 1;
      reqCoverage[tc.requirement_id] = (reqCoverage[tc.requirement_id] || 0) + 1;
    }

    const coveredReqs = new Set(cases.map(tc => tc.requirement_id));
    const uncoveredReqs = requirements
      .filter(r => !coveredReqs.has(r.id))
      .map(r => ({ id: r.id, title: r.title }));

    return {
      totalTestCases: cases.length,
      typeBreakdown: Object.entries(typeBreakdown).map(([type, count]) => ({ type, count })),
      priorityBreakdown: Object.entries(priorityBreakdown).map(([priority, count]) => ({ priority, count })),
      requirementCoverage: {
        total: requirements.length,
        covered: coveredReqs.size,
        uncovered: uncoveredReqs.length,
        coveragePercent: requirements.length > 0
          ? Math.round((coveredReqs.size / requirements.length) * 100)
          : 0,
        uncoveredRequirements: uncoveredReqs,
      },
    };
  }
}

module.exports = { TestCaseGenerator };
