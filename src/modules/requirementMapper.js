/**
 * Module D — Requirement-to-Application Mapping
 *
 * Uses the LLM to link each BRD requirement to screens, workflows,
 * and UI elements discovered during crawling.
 *
 * Reports gaps in BOTH directions:
 *   1. Requirements with no matching feature in the app.
 *   2. Features in the app that the BRD doesn't mention.
 */

const { getLLMService } = require('../services/llmService');
const { createModuleLogger } = require('../services/logger');

const log = createModuleLogger('ReqMapper');

const SYSTEM_PROMPT = `You are a QA expert mapping Business Requirements to an application's UI.

You are given:
1. A list of BRD requirements (each with an ID, title, description, module).
2. An application knowledge model containing pages, forms, fields, buttons, workflows, and role-permissions.

Your task:
1. For EACH requirement, find the page(s), form(s), field(s), and button(s) in the application that implement it.
2. Provide a confidence score (0.0 to 1.0) for each mapping.
3. If a requirement has NO matching feature in the app, include it in "unmapped_requirements".
4. If a feature exists in the app but is NOT mentioned in any requirement, include it in "unmapped_features".

Return JSON:
{
  "mappings": [
    {
      "requirement_id": "REQ-001",
      "requirement_title": "...",
      "mapped_pages": [
        {
          "url": "...",
          "title": "...",
          "relevant_elements": ["field: ...", "button: ..."],
          "confidence": 0.9
        }
      ],
      "mapped_workflows": ["Login → Dashboard → ..."],
      "coverage": "full | partial | none"
    }
  ],
  "unmapped_requirements": [
    {
      "requirement_id": "REQ-XXX",
      "requirement_title": "...",
      "reason": "No matching feature found in the application"
    }
  ],
  "unmapped_features": [
    {
      "page_url": "...",
      "page_title": "...",
      "feature_description": "...",
      "reason": "Feature exists in app but not covered by any BRD requirement"
    }
  ]
}`;

class RequirementMapper {
  constructor() {
    this.llm = getLLMService();
  }

  /**
   * Map BRD requirements to application features.
   * @param {object} brdResult — output from parseBRD()
   * @param {object} knowledgeModel — output from KnowledgeModelBuilder.build()
   * @returns {Promise<object>} — mapping result with gaps
   */
  async mapRequirements(brdResult, knowledgeModel) {
    const startTime = Date.now();
    log.info(`Mapping ${brdResult.requirements.length} requirements to ${knowledgeModel.pageInventory.length} pages`);

    // Prepare a condensed version of the knowledge model to stay within token limits
    const condensedModel = this._condenseModel(knowledgeModel);
    const requirements = brdResult.requirements.map(r => ({
      id: r.id,
      title: r.title,
      description: r.description,
      module: r.module,
      type: r.type,
      acceptance_criteria: r.acceptance_criteria,
    }));

    // If there are many requirements, process in batches
    const batchSize = 15;
    const batches = [];
    for (let i = 0; i < requirements.length; i += batchSize) {
      batches.push(requirements.slice(i, i + batchSize));
    }

    let allMappings = [];
    let allUnmappedReqs = [];
    let allUnmappedFeatures = [];

    for (let i = 0; i < batches.length; i++) {
      log.info(`Processing mapping batch ${i + 1}/${batches.length}`);

      const userPrompt = `## BRD Requirements (batch ${i + 1}/${batches.length})\n\n`
        + JSON.stringify(batches[i], null, 2)
        + `\n\n## Application Knowledge Model\n\n`
        + JSON.stringify(condensedModel, null, 2);

      const result = await this.llm.chatJSON(SYSTEM_PROMPT, userPrompt, {
        temperature: 0.1,
        maxTokens: 4096,
      });

      if (result.parsed) {
        if (result.parsed.mappings) allMappings.push(...result.parsed.mappings);
        if (result.parsed.unmapped_requirements) allUnmappedReqs.push(...result.parsed.unmapped_requirements);
        if (i === batches.length - 1 && result.parsed.unmapped_features) {
          allUnmappedFeatures = result.parsed.unmapped_features;
        }
      }
    }

    // Deduplicate unmapped features
    const seenFeatures = new Set();
    allUnmappedFeatures = allUnmappedFeatures.filter(f => {
      const key = f.page_url || f.feature_description;
      if (seenFeatures.has(key)) return false;
      seenFeatures.add(key);
      return true;
    });

    const elapsed = Date.now() - startTime;

    const mappingResult = {
      mappings: allMappings,
      unmapped_requirements: allUnmappedReqs,
      unmapped_features: allUnmappedFeatures,
      stats: {
        totalRequirements: brdResult.requirements.length,
        mappedRequirements: allMappings.filter(m => m.coverage !== 'none').length,
        unmappedRequirements: allUnmappedReqs.length,
        unmappedFeatures: allUnmappedFeatures.length,
        coveragePercent: brdResult.requirements.length > 0
          ? Math.round(
              (allMappings.filter(m => m.coverage !== 'none').length / brdResult.requirements.length) * 100,
            )
          : 0,
        mappingTimeMs: elapsed,
      },
      generatedAt: new Date().toISOString(),
    };

    log.info(
      `Mapping complete: ${mappingResult.stats.mappedRequirements}/${mappingResult.stats.totalRequirements} `
      + `requirements mapped (${mappingResult.stats.coveragePercent}% coverage), `
      + `${allUnmappedFeatures.length} unmapped features, ${elapsed}ms`,
    );

    return mappingResult;
  }

  /**
   * Condense the knowledge model to fit within LLM token limits.
   */
  _condenseModel(model) {
    return {
      pages: model.pageInventory.map(p => ({
        url: p.url,
        title: p.title,
        heading: p.heading,
        roles: p.accessibleByRoles,
        hasForms: p.hasForms,
        hasTable: p.hasTable,
      })),
      elements: model.elementMap.map(e => ({
        url: e.url,
        title: e.title,
        forms: e.forms.map(f => ({
          id: f.id,
          fields: f.fields.map(field => ({
            label: field.label,
            type: field.type,
            required: field.required,
            options: field.options ? field.options.map(o => o.text) : null,
          })),
        })),
        buttons: e.buttons.map(b => b.text).filter(Boolean),
        tables: e.tables.map(t => t.headers),
        errorMessages: e.errorMessages,
      })),
      workflows: model.workflowGraph.edges.slice(0, 50).map(e => `${e.label}: → ${e.to}`),
      roles: Object.keys(model.rolePermissionMatrix),
    };
  }
}

module.exports = { RequirementMapper };
