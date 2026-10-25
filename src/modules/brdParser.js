/**
 * Module A — BRD Understanding
 *
 * Parses Business Requirements Documents (PDF / DOCX) and uses an LLM
 * to extract functional requirements, business rules, actors/roles,
 * validations, and acceptance criteria.
 *
 * - Assigns a unique ID to every requirement (REQ-001 …).
 * - Flags vague / incomplete requirements rather than guessing.
 */

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { v4: uuidv4 } = require('uuid');
const { getLLMService } = require('../services/llmService');
const { createModuleLogger } = require('../services/logger');

const log = createModuleLogger('BRDParser');

// ── File readers ────────────────────────────────────────────

async function readPDF(filePath) {
  log.info(`Parsing PDF: ${path.basename(filePath)}`);
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return data.text;
}

async function readDOCX(filePath) {
  log.info(`Parsing DOCX: ${path.basename(filePath)}`);
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

async function readText(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf':  return readPDF(filePath);
    case '.docx': return readDOCX(filePath);
    case '.txt':
    case '.md':   return readText(filePath);
    default:
      throw new Error(`Unsupported BRD file type: ${ext}`);
  }
}

// ── LLM-powered extraction ─────────────────────────────────

const SYSTEM_PROMPT = `You are an expert Business Analyst and QA Architect.
You are given the raw text of a Business Requirements Document (BRD).

Your task:
1. Extract EVERY functional requirement, business rule, validation rule, and acceptance criterion.
2. Identify all actors / user roles mentioned.
3. For each requirement, determine:
   - A short title
   - A detailed description
   - The module / area it belongs to
   - Priority (Critical / High / Medium / Low) — infer from context
   - Any acceptance criteria associated with it
   - Whether it is clear or vague/incomplete
4. If a requirement is vague, incomplete, or ambiguous, set "is_vague" to true and
   provide a "vague_reason" explaining what is missing or unclear.
5. Do NOT invent requirements that are not in the document.

Return a JSON object with this structure:
{
  "title": "BRD title if found",
  "summary": "1–2 sentence summary of the document",
  "actors": ["role1", "role2"],
  "modules": ["module1", "module2"],
  "requirements": [
    {
      "id": "REQ-001",
      "title": "Short title",
      "description": "Detailed description",
      "module": "Module name",
      "type": "functional | business_rule | validation | acceptance_criterion",
      "priority": "Critical | High | Medium | Low",
      "acceptance_criteria": ["criterion 1", "criterion 2"],
      "actors": ["role involved"],
      "is_vague": false,
      "vague_reason": null
    }
  ]
}`;

/**
 * Parse a BRD file and extract structured requirements.
 * @param {string} filePath — absolute path to the BRD file
 * @returns {Promise<object>} — parsed BRD with requirements array
 */
async function parseBRD(filePath) {
  const startTime = Date.now();
  log.info(`Starting BRD parse: ${filePath}`);

  // 1. Extract raw text
  const rawText = await extractText(filePath);
  log.info(`Extracted ${rawText.length} characters from BRD`);

  if (rawText.trim().length < 50) {
    throw new Error('BRD appears to be empty or too short to analyse.');
  }

  // 2. Chunk if needed (for very large documents)
  const chunks = chunkText(rawText, 12000);
  log.info(`Split into ${chunks.length} chunk(s) for LLM processing`);

  // 3. Process each chunk
  const llm = getLLMService();
  let allRequirements = [];
  let actors = new Set();
  let modules = new Set();
  let title = '';
  let summary = '';

  for (let i = 0; i < chunks.length; i++) {
    log.info(`Processing chunk ${i + 1}/${chunks.length}`);
    const userPrompt = chunks.length > 1
      ? `This is part ${i + 1} of ${chunks.length} of the BRD document.\n\n${chunks[i]}`
      : chunks[i];

    const result = await llm.chatJSON(SYSTEM_PROMPT, userPrompt, {
      temperature: 0.1,
      maxTokens: 4096,
    });

    if (result.parsed) {
      if (result.parsed.title) title = result.parsed.title;
      if (result.parsed.summary) summary = result.parsed.summary;
      if (result.parsed.actors) result.parsed.actors.forEach(a => actors.add(a));
      if (result.parsed.modules) result.parsed.modules.forEach(m => modules.add(m));
      if (result.parsed.requirements) {
        allRequirements.push(...result.parsed.requirements);
      }
    }
  }

  // 4. Deduplicate and re-index requirement IDs
  allRequirements = deduplicateRequirements(allRequirements);
  allRequirements = assignSequentialIds(allRequirements);

  const vagueCount = allRequirements.filter(r => r.is_vague).length;
  const elapsed = Date.now() - startTime;

  log.info(
    `BRD parsing complete: ${allRequirements.length} requirements extracted `
    + `(${vagueCount} flagged vague), ${elapsed}ms`,
  );

  return {
    id: uuidv4(),
    filePath,
    fileName: path.basename(filePath),
    title,
    summary,
    actors: [...actors],
    modules: [...modules],
    requirements: allRequirements,
    stats: {
      totalRequirements: allRequirements.length,
      vagueRequirements: vagueCount,
      clearRequirements: allRequirements.length - vagueCount,
      parseTimeMs: elapsed,
    },
    parsedAt: new Date().toISOString(),
  };
}

// ── Helpers ─────────────────────────────────────────────────

function chunkText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxChars;
    // Try to break at paragraph boundary
    if (end < text.length) {
      const lastPara = text.lastIndexOf('\n\n', end);
      if (lastPara > start + maxChars * 0.5) end = lastPara;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function deduplicateRequirements(reqs) {
  const seen = new Map();
  for (const r of reqs) {
    const key = (r.title || '').toLowerCase().trim();
    if (!seen.has(key)) {
      seen.set(key, r);
    }
  }
  return [...seen.values()];
}

function assignSequentialIds(reqs) {
  return reqs.map((r, i) => ({
    ...r,
    id: `REQ-${String(i + 1).padStart(3, '0')}`,
  }));
}

module.exports = { parseBRD, extractText };
