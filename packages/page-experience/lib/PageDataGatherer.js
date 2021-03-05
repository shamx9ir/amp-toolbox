/**
 * Copyright 2021  The AMP HTML Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const puppeteer = require('puppeteer');
const treeKill = require('tree-kill');
const parseFontfaces = require('./helpers/parseFontface');

// Pixel 5 XL
const DEFAULT_VIEWPORT = {
  width: 393,
  height: 851,
};

/**
 * Renders a page in Puppeteer and collects all data required for the page experience recommendations.
 */
class PageAnalyzer {
  constructor(config = {}) {
    this.viewport = config.viewport || DEFAULT_VIEWPORT;
    this.debug = config.debug || false;
  }

  async start() {
    this.browser = await puppeteer.launch();
  }

  async execute(url) {
    const {page, remoteStyles} = await this.setupPage();
    await page.goto(url, {waitUntil: 'load'});
    return await this.gatherPageData(page, remoteStyles);
  }

  async gatherPageData(page, remoteStyles) {
    const result = await page.evaluate(async () => {
      /* global document, window */

      /**
       * Returns true if the given element is in the first viewport.
       *
       * @param {Element} el
       * @return {boolean}
       */
      const isElementInViewport = (el) => {
        const rect = el.getBoundingClientRect();
        return (
          rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
          rect.left <= (window.innerWidth || document.documentElement.clientWidth)
        );
      };

      /**
       * Returns a list of all inline `<style>` definitions.
       *
       * @return {Array<string>}
       */
      const collectInlineStyles = () => {
        const css = [];
        for (const style of document.querySelectorAll('style')) {
          css.push(style.innerText);
        }
        return css;
      };

      /**
       * Returns a list of all font preload hrefs. URLs are normalized to the current origin.
       *
       * @return {Array<string>} a list of URLs
       */
      const collectFontPreloads = () => {
        return Array.from(document.querySelectorAll('link[rel=preload][as=font]')).map(
          (preload) => {
            const href = preload.getAttribute('href');
            if (!href) {
              return null;
            }
            try {
              return new URL(href, window.location.origin).toString();
            } catch (e) {
              console.log('Preload is not an URL');
            }
          }
        );
      };

      /**
       * Returns the first font name in a font-family definition. Quotes etc are removed.
       *
       * @param {string} fontFamilyString
       * @return {string} the first font
       */
      const extractFirstFont = (fontFamilyString) => {
        if (!fontFamilyString) {
          return null;
        }
        const font = fontFamilyString.split(',')[0];
        return font.replace(/["']/g, '');
      };

      /**
       * Returns a list of critical and non-critical fonts. Critical fonts are used in the first viewport.
       * All other fonts are considered non-critical.
       *
       * TODO: take font-weights into account when calculating critical fonts.
       *
       * @return {Object}
       */
      const collectFontsUsedOnPage = () => {
        const criticalFonts = new Set();
        const nonCriticalFonts = new Set();
        document.querySelectorAll('body *').forEach((node) => {
          const computedStyles = window.getComputedStyle(node);
          const fontFamily = computedStyles.getPropertyValue('font-family');
          const font = extractFirstFont(fontFamily);
          if (!font) {
            return;
          }
          if (isElementInViewport(node)) {
            criticalFonts.add(font);
          } else {
            nonCriticalFonts.add(font);
          }
        });
        return {
          criticalFonts: Array.from(criticalFonts),
          nonCriticalFonts: Array.from(nonCriticalFonts).filter((font) => !criticalFonts.has(font)),
        };
      };

      return {
        origin: window.location.origin,
        fontPreloads: collectFontPreloads(),
        localStyles: collectInlineStyles(),
        ...collectFontsUsedOnPage(),
      };
    });

    return {
      remoteStyles: remoteStyles,
      criticalFonts: result.criticalFonts,
      nonCriticalFonts: result.nonCriticalFonts,
      fontPreloads: result.fontPreloads,
      fontFaces: parseFontfaces([...remoteStyles, ...result.localStyles].join('\n'), result.origin),
    };
  }

  async setupPage() {
    const page = await this.browser.newPage();
    const remoteStyles = [];
    if (this.debug) {
      page.on('console', (msg) => console.log('[PAGE LOG] ', msg.text()));
    }
    page.setViewport(this.viewport);
    page.setRequestInterception(true);

    // Abort requests not needed for rendering the page
    page.on('request', (request) => {
      const requestTypeIgnoreList = new Set(['image', 'video']);
      if (requestTypeIgnoreList.has(request.resourceType())) {
        return request.abort();
      }
      if (
        request.resourceType() === 'script' &&
        !request.url().startsWith('https://cdn.ampproject.org')
      ) {
        // Only donwload AMP runtime scripts as they're need for layouting the page
        // Once self-hosting is a thing we'll have to change this
        // TODO: investigate whether we could cache these locally
        return request.abort();
      }
      return request.continue();
    });

    // Collect external stylesheets from requests as we can't read them otherwise due to CORS
    page.on('response', async (response) => {
      if (response.request().resourceType() === 'stylesheet') {
        remoteStyles.push(await response.text());
      }
    });
    return {
      page,
      remoteStyles,
    };
  }

  async shutdown() {
    await this.browser.close();
    treeKill(this.browser.process().pid, 'SIGKILL');
  }
}

module.exports = PageAnalyzer;
