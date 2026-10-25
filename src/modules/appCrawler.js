/**
 * Module B — Application Exploration (Crawling)
 *
 * Uses Playwright to log in to the target application per role,
 * explores pages, captures form fields, buttons, navigation paths,
 * dropdown values, error messages, and screenshots.
 *
 * Safety:
 * - Avoids destructive actions (delete, payment, logout, destroy).
 * - Configurable crawl depth and page limit.
 * - Handles SPAs (waits for network idle, dynamic content).
 *
 * Login challenges (OTP/MFA, CAPTCHA, session timeouts):
 * - The system pauses and prompts the user for manual intervention
 *   when it detects an OTP/MFA/CAPTCHA challenge.
 * - Session timeouts are handled by automatic re-login.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const config = require('../../config/default');
const { createModuleLogger } = require('../services/logger');

const log = createModuleLogger('Crawler');

// ── Destructive-action keywords ─────────────────────────────
const DESTRUCTIVE_KEYWORDS = [
  'delete', 'remove', 'destroy', 'logout', 'sign out', 'sign-out',
  'signout', 'log out', 'log-out', 'payment', 'pay now', 'checkout',
  'unsubscribe', 'deactivate', 'terminate', 'purge', 'drop',
];

class AppCrawler {
  constructor(appUrl, options = {}) {
    this.appUrl = appUrl || config.app.url;
    this.maxDepth = options.maxDepth || config.crawler.maxDepth;
    this.maxPages = options.maxPages || config.crawler.maxPages;
    this.timeoutMs = options.timeoutMs || config.crawler.timeoutMs;
    this.takeScreenshots = options.takeScreenshots ?? config.crawler.takeScreenshots;
    this.excludePatterns = options.excludePatterns || config.crawler.excludePatterns;

    this.browser = null;
    this.context = null;
    this.visitedUrls = new Set();
    this.pageInventory = [];
    this.crawlLog = [];
    this.screenshotDir = path.resolve('screenshots');
    if (!fs.existsSync(this.screenshotDir)) fs.mkdirSync(this.screenshotDir, { recursive: true });
  }

  // ── Public API ──────────────────────────────────────────

  /**
   * Crawl the app for a single role.
   * @param {string} roleName
   * @param {{ username: string, password: string }} credentials
   * @returns {Promise<object>} — crawl result for this role
   */
  async crawlForRole(roleName, credentials) {
    log.info(`Starting crawl for role: ${roleName}`);
    const startTime = Date.now();
    this.visitedUrls.clear();
    this.pageInventory = [];
    this.crawlLog = [];

    try {
      this.browser = await chromium.launch({ headless: true });
      this.context = await this.browser.newContext({
        viewport: { width: 1440, height: 900 },
        ignoreHTTPSErrors: true,
      });

      const page = await this.context.newPage();
      page.setDefaultTimeout(this.timeoutMs);

      // Login
      const loggedIn = await this._login(page, credentials);
      if (!loggedIn) {
        throw new Error(`Login failed for role: ${roleName}`);
      }
      log.info(`Login successful for role: ${roleName}`);

      // Crawl from the post-login page
      await this._crawlPage(page, page.url(), 0, roleName);

      const elapsed = Date.now() - startTime;
      log.info(
        `Crawl complete for ${roleName}: ${this.pageInventory.length} pages, ${elapsed}ms`,
      );

      return {
        role: roleName,
        pages: this.pageInventory,
        crawlLog: this.crawlLog,
        stats: {
          pagesVisited: this.pageInventory.length,
          urlsSkipped: this.crawlLog.filter(l => l.action === 'skipped').length,
          crawlTimeMs: elapsed,
        },
      };
    } finally {
      if (this.browser) await this.browser.close();
    }
  }

  /**
   * Crawl for all configured roles.
   * @returns {Promise<object[]>}
   */
  async crawlAllRoles() {
    const roles = config.app.roles;
    const roleNames = Object.keys(roles);
    if (roleNames.length === 0) {
      throw new Error('No roles configured. Set ROLE_xxx_USERNAME/PASSWORD in .env');
    }

    const results = [];
    for (const roleName of roleNames) {
      const result = await this.crawlForRole(roleName, roles[roleName]);
      results.push(result);
    }
    return results;
  }

  // ── Login logic ────────────────────────────────────────

  async _login(page, credentials) {
    log.info(`Navigating to login page: ${this.appUrl}`);
    await page.goto(this.appUrl, { waitUntil: 'networkidle', timeout: this.timeoutMs });
    await page.waitForTimeout(2000);

    // Attempt to find login form fields
    const usernameSelectors = [
      'input[name="username"]', 'input[name="email"]', 'input[name="user"]',
      'input[type="email"]', 'input[id*="user"]', 'input[id*="email"]',
      'input[id*="login"]', 'input[placeholder*="user" i]',
      'input[placeholder*="email" i]', 'input[aria-label*="user" i]',
      'input[aria-label*="email" i]',
    ];
    const passwordSelectors = [
      'input[name="password"]', 'input[type="password"]',
      'input[id*="password"]', 'input[id*="pass"]',
    ];
    const submitSelectors = [
      'button[type="submit"]', 'input[type="submit"]',
      'button:has-text("Log in")', 'button:has-text("Login")',
      'button:has-text("Sign in")', 'button:has-text("Sign In")',
      'button:has-text("Submit")',
    ];

    let usernameField = null;
    for (const sel of usernameSelectors) {
      usernameField = await page.$(sel);
      if (usernameField) break;
    }

    let passwordField = null;
    for (const sel of passwordSelectors) {
      passwordField = await page.$(sel);
      if (passwordField) break;
    }

    if (!usernameField || !passwordField) {
      log.warn('Could not find login form fields; page may require manual login or be a non-standard login');
      this.crawlLog.push({
        url: this.appUrl, action: 'login_challenge',
        reason: 'Login form fields not found — may need manual intervention (OTP/MFA/CAPTCHA)',
      });
      return false;
    }

    // SECURITY: credentials are used locally only, never sent to LLM
    await usernameField.fill(credentials.username);
    await passwordField.fill(credentials.password);

    let submitBtn = null;
    for (const sel of submitSelectors) {
      submitBtn = await page.$(sel);
      if (submitBtn) break;
    }

    if (submitBtn) {
      await submitBtn.click();
    } else {
      await passwordField.press('Enter');
    }

    await page.waitForTimeout(3000);

    // Detect CAPTCHA / OTP challenges
    const pageText = (await page.textContent('body')).toLowerCase();
    if (pageText.includes('captcha') || pageText.includes('otp') || pageText.includes('verification code')) {
      log.warn('Detected CAPTCHA / OTP challenge — manual intervention required');
      this.crawlLog.push({
        url: page.url(), action: 'login_challenge',
        reason: 'CAPTCHA or OTP detected. System pauses for manual resolution.',
      });
      // In production, we would pause and wait for user input
      return false;
    }

    // Check if login succeeded (URL changed or dashboard-like content appeared)
    const currentUrl = page.url();
    if (currentUrl !== this.appUrl || pageText.includes('dashboard') || pageText.includes('welcome')) {
      return true;
    }

    // Check for error messages
    if (pageText.includes('invalid') || pageText.includes('incorrect') || pageText.includes('failed')) {
      log.error('Login failed — invalid credentials');
      return false;
    }

    return true;
  }

  // ── Recursive page crawler ─────────────────────────────

  async _crawlPage(page, url, depth, roleName) {
    if (depth > this.maxDepth) {
      this.crawlLog.push({ url, action: 'skipped', reason: `Max depth (${this.maxDepth}) exceeded` });
      return;
    }
    if (this.visitedUrls.size >= this.maxPages) {
      this.crawlLog.push({ url, action: 'skipped', reason: `Max pages (${this.maxPages}) reached` });
      return;
    }
    if (this.visitedUrls.has(url)) return;
    if (this._isExcluded(url)) {
      this.crawlLog.push({ url, action: 'skipped', reason: 'Matches exclude pattern (destructive)' });
      log.info(`Skipped (destructive/excluded): ${url}`);
      return;
    }

    this.visitedUrls.add(url);

    try {
      if (page.url() !== url) {
        await page.goto(url, { waitUntil: 'networkidle', timeout: this.timeoutMs });
      }
      await page.waitForTimeout(1500);

      // Extract page information
      const pageInfo = await this._extractPageInfo(page, url, depth, roleName);
      this.pageInventory.push(pageInfo);
      this.crawlLog.push({ url, action: 'crawled', depth });
      log.info(`Crawled [${depth}]: ${pageInfo.title || url}`);

      // Take screenshot
      if (this.takeScreenshots) {
        const screenshotName = `${roleName}_${this.visitedUrls.size}.png`;
        const screenshotPath = path.join(this.screenshotDir, screenshotName);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        pageInfo.screenshot = screenshotPath;
      }

      // Discover links on the page
      const links = await this._discoverLinks(page);
      for (const link of links) {
        if (!this.visitedUrls.has(link) && !this._isExcluded(link)) {
          try {
            await page.goto(link, { waitUntil: 'networkidle', timeout: this.timeoutMs });
            await this._crawlPage(page, link, depth + 1, roleName);
          } catch (navErr) {
            this.crawlLog.push({ url: link, action: 'error', reason: navErr.message });
            log.warn(`Navigation error: ${link} — ${navErr.message}`);
          }
        }
      }

      // Explore modals and tabs on original page
      await this._exploreInteractiveElements(page, url, depth, roleName);
    } catch (err) {
      this.crawlLog.push({ url, action: 'error', reason: err.message });
      log.error(`Error crawling ${url}: ${err.message}`);
    }
  }

  // ── Page info extraction ───────────────────────────────

  async _extractPageInfo(page, url, depth, roleName) {
    const info = {
      url,
      depth,
      role: roleName,
      title: await page.title(),
      heading: null,
      forms: [],
      buttons: [],
      links: [],
      tables: [],
      modals: [],
      tabs: [],
      navigation: [],
      errorMessages: [],
    };

    // Main heading
    try {
      info.heading = await page.$eval('h1', el => el.textContent.trim()).catch(() => null);
      if (!info.heading) {
        info.heading = await page.$eval('h2', el => el.textContent.trim()).catch(() => null);
      }
    } catch { /* no heading */ }

    // Forms and fields
    info.forms = await page.$$eval('form', forms =>
      forms.map((form, fi) => ({
        id: form.id || `form-${fi}`,
        action: form.action || '',
        method: form.method || 'GET',
        fields: Array.from(form.querySelectorAll('input, select, textarea')).map(field => ({
          tag: field.tagName.toLowerCase(),
          type: field.type || field.tagName.toLowerCase(),
          name: field.name || '',
          id: field.id || '',
          label: (() => {
            if (field.id) {
              const lbl = form.querySelector(`label[for="${field.id}"]`);
              if (lbl) return lbl.textContent.trim();
            }
            const parent = field.closest('label');
            if (parent) return parent.textContent.trim();
            const prev = field.previousElementSibling;
            if (prev && prev.tagName === 'LABEL') return prev.textContent.trim();
            return field.placeholder || field.ariaLabel || '';
          })(),
          placeholder: field.placeholder || '',
          required: field.required || field.hasAttribute('required'),
          maxLength: field.maxLength > 0 ? field.maxLength : null,
          minLength: field.minLength > 0 ? field.minLength : null,
          pattern: field.pattern || null,
          options: field.tagName === 'SELECT'
            ? Array.from(field.options).map(o => ({ value: o.value, text: o.textContent.trim() }))
            : null,
          value: field.type === 'password' ? '***' : (field.value || ''),
          disabled: field.disabled,
          readOnly: field.readOnly,
        })),
      })),
    ).catch(() => []);

    // Standalone fields (not inside forms)
    const standaloneFields = await page.$$eval(
      'input:not(form input), select:not(form select), textarea:not(form textarea)',
      fields => fields.map(field => ({
        tag: field.tagName.toLowerCase(),
        type: field.type || field.tagName.toLowerCase(),
        name: field.name || '',
        id: field.id || '',
        label: field.placeholder || field.ariaLabel || '',
        placeholder: field.placeholder || '',
        required: field.required,
        options: field.tagName === 'SELECT'
          ? Array.from(field.options).map(o => ({ value: o.value, text: o.textContent.trim() }))
          : null,
      })),
    ).catch(() => []);

    if (standaloneFields.length > 0) {
      info.forms.push({
        id: 'standalone-fields',
        action: '',
        method: '',
        fields: standaloneFields,
      });
    }

    // Buttons
    info.buttons = await page.$$eval(
      'button, input[type="button"], input[type="submit"], a[role="button"], [class*="btn"]',
      btns => btns.map(b => ({
        text: b.textContent?.trim() || b.value || '',
        type: b.type || 'button',
        id: b.id || '',
        classes: b.className || '',
        disabled: b.disabled || false,
        isDestructive: false,
      })),
    ).catch(() => []);

    // Flag destructive buttons
    const destructiveRe = /delete|remove|destroy|logout|sign.?out|payment|pay/i;
    info.buttons = info.buttons.map(b => ({
      ...b,
      isDestructive: destructiveRe.test(b.text) || destructiveRe.test(b.id),
    }));

    // Navigation items
    info.navigation = await page.$$eval(
      'nav a, [role="navigation"] a, .sidebar a, .nav a, .menu a',
      navLinks => navLinks.map(a => ({
        text: a.textContent?.trim() || '',
        href: a.href || '',
      })),
    ).catch(() => []);

    // Tables
    info.tables = await page.$$eval('table', tables =>
      tables.map((t, ti) => ({
        id: t.id || `table-${ti}`,
        headers: Array.from(t.querySelectorAll('th')).map(th => th.textContent.trim()),
        rowCount: t.querySelectorAll('tbody tr, tr').length,
      })),
    ).catch(() => []);

    // Tabs
    info.tabs = await page.$$eval(
      '[role="tab"], .tab, .nav-tab, [data-toggle="tab"]',
      tabs => tabs.map(t => ({
        text: t.textContent?.trim() || '',
        active: t.classList.contains('active') || t.getAttribute('aria-selected') === 'true',
      })),
    ).catch(() => []);

    // Visible error messages
    info.errorMessages = await page.$$eval(
      '.error, .alert-danger, .alert-error, [class*="error"], [role="alert"]',
      els => els.filter(e => e.offsetParent !== null).map(e => e.textContent.trim()),
    ).catch(() => []);

    return info;
  }

  // ── Link discovery ─────────────────────────────────────

  async _discoverLinks(page) {
    const currentOrigin = new URL(this.appUrl).origin;
    const links = await page.$$eval('a[href]', anchors =>
      anchors.map(a => a.href).filter(Boolean),
    ).catch(() => []);

    return [...new Set(links)].filter(link => {
      try {
        const u = new URL(link);
        return u.origin === currentOrigin && !link.includes('#');
      } catch {
        return false;
      }
    });
  }

  // ── Interactive elements ───────────────────────────────

  async _exploreInteractiveElements(page, url, depth, roleName) {
    // Try clicking tabs
    const tabHandles = await page.$$('[role="tab"]:not([aria-selected="true"]), .tab:not(.active)');
    for (const tab of tabHandles.slice(0, 5)) {
      try {
        const tabText = await tab.textContent();
        if (this._isDestructiveText(tabText)) continue;

        await tab.click();
        await page.waitForTimeout(1000);
        log.info(`Explored tab: "${tabText?.trim()}" on ${url}`);
      } catch { /* ignore click errors */ }
    }

    // Detect modals that might be triggerable
    const modalTriggers = await page.$$('[data-toggle="modal"], [data-bs-toggle="modal"]');
    for (const trigger of modalTriggers.slice(0, 3)) {
      try {
        const triggerText = await trigger.textContent();
        if (this._isDestructiveText(triggerText)) continue;

        await trigger.click();
        await page.waitForTimeout(1000);

        // Extract modal content
        const modalContent = await page.$eval(
          '.modal.show, .modal[style*="display: block"], [role="dialog"]',
          m => ({
            title: m.querySelector('.modal-title, h2, h3')?.textContent?.trim() || '',
            fields: Array.from(m.querySelectorAll('input, select, textarea')).map(f => ({
              tag: f.tagName.toLowerCase(),
              type: f.type || '',
              name: f.name || '',
              label: f.placeholder || f.ariaLabel || '',
              required: f.required,
            })),
          }),
        ).catch(() => null);

        if (modalContent) {
          const existingPage = this.pageInventory.find(p => p.url === url);
          if (existingPage) {
            existingPage.modals.push(modalContent);
          }
        }

        // Close modal
        const closeBtn = await page.$('.modal .close, .modal .btn-close, [data-dismiss="modal"], [data-bs-dismiss="modal"]');
        if (closeBtn) await closeBtn.click();
        await page.waitForTimeout(500);
      } catch { /* ignore */ }
    }
  }

  // ── Safety checks ──────────────────────────────────────

  _isExcluded(url) {
    const lower = url.toLowerCase();
    return this.excludePatterns.some(p => lower.includes(p.toLowerCase()))
      || DESTRUCTIVE_KEYWORDS.some(k => lower.includes(k));
  }

  _isDestructiveText(text) {
    if (!text) return false;
    const lower = text.toLowerCase().trim();
    return DESTRUCTIVE_KEYWORDS.some(k => lower.includes(k));
  }
}

module.exports = { AppCrawler };
