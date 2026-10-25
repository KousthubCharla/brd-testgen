/**
 * LLM Service — unified interface to OpenAI (or Azure OpenAI).
 *
 * SECURITY: This module NEVER receives raw credentials.
 *           The caller must strip credentials before sending data here.
 *
 * Tracks token usage and cost per call (assessment NFR: performance & cost).
 */

const OpenAI = require('openai');
const config = require('../../config/default');
const { createModuleLogger } = require('./logger');

const log = createModuleLogger('LLMService');

// ── Pricing (approximate, per 1 K tokens) ──────────────────
const PRICING = {
  'gpt-4o':        { input: 0.0025, output: 0.01 },
  'gpt-4o-mini':   { input: 0.00015, output: 0.0006 },
  'gpt-4-turbo':   { input: 0.01, output: 0.03 },
  'gpt-4':         { input: 0.03, output: 0.06 },
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
};

class LLMService {
  constructor() {
    this.totalTokensUsed = { input: 0, output: 0 };
    this.totalCost = 0;
    this.callCount = 0;

    const { provider, openai: oai, azure } = config.llm;
    this._provider = provider;
    this._oai = oai;
    this._azure = azure;
    this.model = provider === 'azure' && azure.deployment ? azure.deployment : oai.model;
    this.client = null; // lazy-initialised on first call

    log.info(`LLM provider configured: ${provider}, model: ${this.model}`);
  }

  /** Lazy-initialise the OpenAI client on first actual API call. */
  _ensureClient() {
    if (this.client) return;
    const { _provider: provider, _azure: azure, _oai: oai } = this;
    if (provider === 'azure' && azure.endpoint) {
      this.client = new OpenAI({
        apiKey: azure.apiKey,
        baseURL: `${azure.endpoint}/openai/deployments/${azure.deployment}`,
        defaultQuery: { 'api-version': '2024-02-01' },
        defaultHeaders: { 'api-key': azure.apiKey },
      });
    } else {
      if (!oai.apiKey) throw new Error('OPENAI_API_KEY is not set in .env');
      this.client = new OpenAI({ apiKey: oai.apiKey });
    }
    log.info(`LLM client initialised: ${provider}, model: ${this.model}`);
  }

  /**
   * Send a chat completion request.
   * @param {string} systemPrompt
   * @param {string} userPrompt
   * @param {object} [options]  — temperature, maxTokens, responseFormat
   * @returns {Promise<{content: string, usage: object, cost: number}>}
   */
  async chat(systemPrompt, userPrompt, options = {}) {
    this._ensureClient();
    const {
      temperature = 0.2,
      maxTokens = 4096,
      responseFormat,
    } = options;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const reqBody = {
      model: this.model,
      messages,
      temperature,
      max_tokens: maxTokens,
    };

    if (responseFormat) {
      reqBody.response_format = responseFormat;
    }

    const startMs = Date.now();
    try {
      const res = await this.client.chat.completions.create(reqBody);
      const elapsed = Date.now() - startMs;
      const usage = res.usage || { prompt_tokens: 0, completion_tokens: 0 };
      const cost = this._calculateCost(usage);

      this.totalTokensUsed.input += usage.prompt_tokens;
      this.totalTokensUsed.output += usage.completion_tokens;
      this.totalCost += cost;
      this.callCount++;

      log.info(
        `LLM call #${this.callCount} — ${usage.prompt_tokens}+${usage.completion_tokens} tokens, `
        + `$${cost.toFixed(5)}, ${elapsed}ms`,
      );

      return {
        content: res.choices[0]?.message?.content || '',
        usage,
        cost,
        elapsed,
      };
    } catch (err) {
      log.error(`LLM call failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Convenience: send prompt and parse JSON from response.
   */
  async chatJSON(systemPrompt, userPrompt, options = {}) {
    const res = await this.chat(systemPrompt, userPrompt, {
      ...options,
      responseFormat: { type: 'json_object' },
    });
    try {
      res.parsed = JSON.parse(res.content);
    } catch {
      log.warn('Failed to parse LLM JSON response; returning raw content');
      res.parsed = null;
    }
    return res;
  }

  /** Return aggregate usage stats. */
  getUsageStats() {
    return {
      callCount: this.callCount,
      totalTokensUsed: { ...this.totalTokensUsed },
      totalCost: parseFloat(this.totalCost.toFixed(5)),
      model: this.model,
    };
  }

  _calculateCost(usage) {
    const p = PRICING[this.model] || PRICING['gpt-4o'];
    return (
      (usage.prompt_tokens / 1000) * p.input +
      (usage.completion_tokens / 1000) * p.output
    );
  }
}

// Singleton
let instance;
function getLLMService() {
  if (!instance) instance = new LLMService();
  return instance;
}

module.exports = { LLMService, getLLMService };
