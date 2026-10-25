/**
 * Module C — Application Knowledge Model
 *
 * Builds a structured representation of the application:
 *   - Page inventory
 *   - Element map (fields, buttons, dropdowns per page)
 *   - Workflow graph (how pages connect)
 *   - Role-permission matrix (what each role can access)
 *
 * Persists the model as JSON so it can be reused without re-crawling.
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config/default');
const { createModuleLogger } = require('../services/logger');

const log = createModuleLogger('KnowledgeModel');

class KnowledgeModelBuilder {
  constructor() {
    this.modelDir = path.resolve(config.paths.knowledgeModel);
    if (!fs.existsSync(this.modelDir)) fs.mkdirSync(this.modelDir, { recursive: true });
  }

  /**
   * Build a complete knowledge model from crawl results.
   * @param {object[]} crawlResults — array of per-role crawl results from AppCrawler
   * @returns {object} — the application knowledge model
   */
  build(crawlResults) {
    log.info('Building application knowledge model...');
    const startTime = Date.now();

    const model = {
      id: `model-${Date.now()}`,
      createdAt: new Date().toISOString(),
      appUrl: config.app.url,
      pageInventory: this._buildPageInventory(crawlResults),
      elementMap: this._buildElementMap(crawlResults),
      workflowGraph: this._buildWorkflowGraph(crawlResults),
      rolePermissionMatrix: this._buildRolePermissionMatrix(crawlResults),
      summary: {},
    };

    // Summary stats
    model.summary = {
      totalPages: model.pageInventory.length,
      totalForms: model.elementMap.reduce((acc, p) => acc + p.forms.length, 0),
      totalFields: model.elementMap.reduce(
        (acc, p) => acc + p.forms.reduce((a, f) => a + f.fields.length, 0), 0,
      ),
      totalButtons: model.elementMap.reduce((acc, p) => acc + p.buttons.length, 0),
      totalRoles: Object.keys(model.rolePermissionMatrix).length,
      workflowEdges: model.workflowGraph.edges.length,
      buildTimeMs: Date.now() - startTime,
    };

    log.info(`Knowledge model built: ${model.summary.totalPages} pages, `
      + `${model.summary.totalFields} fields, ${model.summary.totalRoles} roles`);

    return model;
  }

  /**
   * Save the model to disk as JSON for reuse.
   */
  save(model, fileName = 'knowledge-model.json') {
    const filePath = path.join(this.modelDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(model, null, 2), 'utf-8');
    log.info(`Knowledge model saved: ${filePath}`);
    return filePath;
  }

  /**
   * Load a previously saved model.
   */
  load(fileName = 'knowledge-model.json') {
    const filePath = path.join(this.modelDir, fileName);
    if (!fs.existsSync(filePath)) {
      log.warn(`No saved model found at ${filePath}`);
      return null;
    }
    const model = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    log.info(`Knowledge model loaded from: ${filePath}`);
    return model;
  }

  /**
   * List all saved models.
   */
  listSavedModels() {
    if (!fs.existsSync(this.modelDir)) return [];
    return fs.readdirSync(this.modelDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const filePath = path.join(this.modelDir, f);
        const stat = fs.statSync(filePath);
        return { fileName: f, size: stat.size, modifiedAt: stat.mtime.toISOString() };
      });
  }

  // ── Page inventory ─────────────────────────────────────

  _buildPageInventory(crawlResults) {
    const pagesMap = new Map();

    for (const roleResult of crawlResults) {
      for (const page of roleResult.pages) {
        const key = page.url;
        if (!pagesMap.has(key)) {
          pagesMap.set(key, {
            url: page.url,
            title: page.title,
            heading: page.heading,
            depth: page.depth,
            accessibleByRoles: [roleResult.role],
            hasForms: page.forms.length > 0,
            hasTable: page.tables.length > 0,
            hasTabs: page.tabs.length > 0,
            hasModals: (page.modals || []).length > 0,
            navigationItems: page.navigation.map(n => n.text).filter(Boolean),
          });
        } else {
          const existing = pagesMap.get(key);
          if (!existing.accessibleByRoles.includes(roleResult.role)) {
            existing.accessibleByRoles.push(roleResult.role);
          }
        }
      }
    }

    return [...pagesMap.values()];
  }

  // ── Element map ────────────────────────────────────────

  _buildElementMap(crawlResults) {
    const elementMap = new Map();

    for (const roleResult of crawlResults) {
      for (const page of roleResult.pages) {
        const key = page.url;
        if (!elementMap.has(key)) {
          elementMap.set(key, {
            url: page.url,
            title: page.title,
            forms: page.forms.map(f => ({
              id: f.id,
              fields: f.fields.map(field => ({
                name: field.name || field.id || field.label,
                label: field.label || field.placeholder || field.name,
                type: field.type,
                tag: field.tag,
                required: field.required,
                maxLength: field.maxLength,
                minLength: field.minLength,
                pattern: field.pattern,
                options: field.options,
                disabled: field.disabled,
                readOnly: field.readOnly,
              })),
            })),
            buttons: page.buttons.map(b => ({
              text: b.text,
              type: b.type,
              isDestructive: b.isDestructive,
            })),
            tables: page.tables,
            tabs: page.tabs,
            modals: page.modals || [],
            errorMessages: page.errorMessages,
          });
        }
      }
    }

    return [...elementMap.values()];
  }

  // ── Workflow graph ─────────────────────────────────────

  _buildWorkflowGraph(crawlResults) {
    const nodes = new Map();
    const edges = [];
    const edgeSet = new Set();

    for (const roleResult of crawlResults) {
      for (const page of roleResult.pages) {
        if (!nodes.has(page.url)) {
          nodes.set(page.url, {
            id: page.url,
            label: page.title || page.heading || page.url,
            type: this._inferPageType(page),
          });
        }

        // Create edges from navigation links
        for (const nav of page.navigation) {
          if (nav.href && nav.href !== page.url) {
            const edgeKey = `${page.url}→${nav.href}`;
            if (!edgeSet.has(edgeKey)) {
              edgeSet.add(edgeKey);
              edges.push({
                from: page.url,
                to: nav.href,
                label: nav.text,
                role: roleResult.role,
              });
            }
          }
        }
      }
    }

    return {
      nodes: [...nodes.values()],
      edges,
    };
  }

  // ── Role-permission matrix ─────────────────────────────

  _buildRolePermissionMatrix(crawlResults) {
    const matrix = {};

    for (const roleResult of crawlResults) {
      matrix[roleResult.role] = {
        accessiblePages: roleResult.pages.map(p => ({
          url: p.url,
          title: p.title || p.heading,
          canEdit: p.forms.length > 0,
          canView: true,
          buttons: p.buttons.map(b => b.text).filter(Boolean),
        })),
        totalPages: roleResult.pages.length,
        totalFormsAccess: roleResult.pages.reduce((a, p) => a + p.forms.length, 0),
      };
    }

    return matrix;
  }

  // ── Helpers ────────────────────────────────────────────

  _inferPageType(page) {
    if (page.forms.length > 0) return 'form';
    if (page.tables.length > 0) return 'list';
    if (page.url.includes('dashboard') || page.url.includes('home')) return 'dashboard';
    if (page.url.includes('report')) return 'report';
    if (page.url.includes('setting')) return 'settings';
    return 'content';
  }
}

module.exports = { KnowledgeModelBuilder };
