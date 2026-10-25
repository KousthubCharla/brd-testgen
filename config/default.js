/**
 * Default configuration — merged with environment variables.
 * Every knob that the assessment asks for (crawl depth, modules,
 * test-case template, etc.) is represented here.
 */

require('dotenv').config();

function parseRoles() {
  const roles = {};
  const envKeys = Object.keys(process.env);
  const rolePattern = /^ROLE_(.+)_USERNAME$/;

  for (const key of envKeys) {
    const match = key.match(rolePattern);
    if (match) {
      const roleName = match[1].toLowerCase();
      const passwordKey = `ROLE_${match[1]}_PASSWORD`;
      if (process.env[key] && process.env[passwordKey]) {
        roles[roleName] = {
          username: process.env[key],
          password: process.env[passwordKey],
        };
      }
    }
  }
  return roles;
}

function csv(envVar, fallback = []) {
  const val = process.env[envVar];
  if (!val || val.trim() === '') return fallback;
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

module.exports = {
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    env: process.env.NODE_ENV || 'development',
  },

  llm: {
    provider: process.env.LLM_PROVIDER || 'openai',
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'gpt-4o',
    },
    azure: {
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    },
  },

  app: {
    url: process.env.APP_URL || '',
    roles: parseRoles(),
  },

  crawler: {
    maxDepth: parseInt(process.env.CRAWL_MAX_DEPTH, 10) || 5,
    maxPages: parseInt(process.env.CRAWL_MAX_PAGES, 10) || 100,
    timeoutMs: parseInt(process.env.CRAWL_TIMEOUT_MS, 10) || 30000,
    takeScreenshots: process.env.CRAWL_SCREENSHOT !== 'false',
    excludePatterns: csv('CRAWL_EXCLUDE_PATTERNS', [
      'logout', 'delete', 'remove', 'payment', 'destroy',
    ]),
    includeModules: csv('CRAWL_INCLUDE_MODULES'),
  },

  testCase: {
    types: csv('TEST_TYPES', [
      'positive', 'negative', 'boundary',
      'field-validation', 'role-access', 'e2e', 'business-rule',
    ]),
    maxPerRequirement: parseInt(process.env.MAX_TESTS_PER_REQUIREMENT, 10) || 10,
  },

  paths: {
    output: process.env.OUTPUT_DIR || './output',
    knowledgeModel: process.env.KNOWLEDGE_MODEL_DIR || './data/knowledge',
  },
};
