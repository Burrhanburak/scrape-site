// lib/scraper-utils.ts
import * as cheerio from 'cheerio';
import { URL as NodeURL } from 'url';
// MODIFIED: Import GENERAL_SELECTORS and URL_PATTERNS from config
import {  getStoredSiteSelectors, SelectorConfigItem, SiteSpecificSelectors, GENERAL_SELECTORS, URL_PATTERNS as GENERAL_URL_PATTERNS } from './config'; 
import { addLog, logError } from './logger';
import axios, { AxiosInstance, AxiosError } from 'axios';
import xml2js from 'xml2js';
import zlib from 'zlib';

// --- INTERFACES --- (Keep existing interfaces: LinkItem, ImageItem, HeadingItem, BreadcrumbItem, ScrapedPageData)
export interface LinkItem { text: string; href: string; isExternal?: boolean; }
export interface ImageItem { src: string; alt: string | null; width?: string | null; height?: string | null; hasAlt: boolean; }
export interface HeadingItem { level: number; text: string; }
export interface BreadcrumbItem { text: string; href?: string; position: number; }

export interface ScrapedPageData {
  url: string;
  // Cheerio ile çıkarılanlar ve ilk tahminler
  pageTypeGuess?: 'product' | 'blog' | 'category' | 'page' | 'unknown' | 'collection' | 'forum' | 'search' | 'error' | 'sitemap' | 'robots' | 'feed';
  title?: string | null;
  metaDescription?: string | null;
  keywords?: string[] | null;
  ogType?: string | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  ogImage?: string | null;
  canonicalUrl?: string | null;
  htmlLang?: string | null; 
  metaRobots?: string | null; 
  jsonLdData?: any[] | null;      
  schemaOrgTypes?: string[];      
  // Sayfa türüne göre Cheerio ile çıkarılan spesifik veriler
  price?: string | null;           
  currencySymbol?: string | null;  
  currencyCode?: string | null;    
  stockStatus?: string | null;     
  images?: ImageItem[] | null;     
  category?: string | null;        
  date?: string | null;            
  features?: string[] | null;      
  blogContentSample?: string | null; 
  blogCategories?: string[] | null;  
  // Genel yapısal elemanlar
  headings?: { h1: string[]; h2: string[]; h3: string[]; h4: string[]; h5: string[]; h6: string[]; all: HeadingItem[]; } | null;
  allLinks?: LinkItem[] | null;
  internalLinks?: LinkItem[] | null;
  externalLinks?: LinkItem[] | null;
  navigationLinks?: LinkItem[] | null;
  footerLinks?: LinkItem[] | null;
  breadcrumbs?: BreadcrumbItem[] | null;
  mainTextContent?: string | null; 
  publishDate?: string | null; 
  // AI Sonrası Alanlar
  aiDetectedType?: string; 
  aiExtractedData?: { 
    detectedPageType: string;
    pageTitle?: string | null;
    metaDescription?: string | null;
    productInfo?: {
      productName?: string | null;
      price?: string | null;       
      currency?: string | null;    
      sku?: string | null;
      brand?: string | null;
      shortDescription?: string | null;
      detailedDescription?: string | null;
      images?: string[] | null;    
      features?: string[] | null;
      categoriesFromPage?: string[] | null;
      stockStatus?: string | null; 
    } | null;
    blogPostInfo?: {
      postTitle?: string | null;
      author?: string | null;
      publishDate?: string | null;
      summary?: string | null;
      fullContentSample?: string | null;
      categoriesFromPage?: string[] | null;
      tags?: string[] | null;
      images?: string[] | null;    
    } | null;
    categoryPageInfo?: {
      categoryName?: string | null;
      description?: string | null;
      itemCountOnPage?: number | null;
      filtersAvailable?: string[] | null;
      images?: string[] | null;    
    } | null;
    staticPageInfo?: {
      pagePurpose?: string | null;
      images?: string[] | null;
    } | null;
    error?: string;
    partialResponse?: string;
    rawContent?: string;
  } | null;
  // Eski koddan gelen ek alanlar
  aiProductBrand?: string | null;
  aiProductSku?: string | null;
  aiBlogAuthor?: string | null;
  aiBlogTags?: string[] | null;
  siteSelectorsUsed?: boolean; 
  rawHtmlLength?: number; // ADDED: HTML uzunluğunu ekle
}

// REMOVED: Local URL_PATTERNS definition (now imported from config)
// const URL_PATTERNS = { ... }; 

function sanitizeText(text: string | undefined | null): string | null {
  if (typeof text !== 'string') return null;
  return text.replace(/\s\s+/g, ' ').replace(/\u00A0/g, ' ').trim() || null; // Replaces non-breaking spaces too
}

function resolveUrl(relativeUrl: string | undefined | null, baseUrl: string): string | null {
  if (!relativeUrl) return null;
  try {
    // If relativeUrl is already absolute, NodeURL constructor will handle it.
    // If it starts with '//', prepend protocol from baseUrl.
    if (relativeUrl.startsWith('//')) {
        const base = new NodeURL(baseUrl);
        return base.protocol + relativeUrl;
    }
    return new NodeURL(relativeUrl, baseUrl).toString();
  } catch (e) {
    // logError(e, '[ScraperUtils] Failed to resolve URL', { relativeUrl, baseUrl }); // Optional: more detailed logging
    return null;
  }
}

// --- YARDIMCI FONKSİYONLAR (sanitizeText, resolveUrl, getElementText, getMultipleElementTexts, extractImages, extractHeadings, extractPageLinks, extractSpecificLinks, extractBreadcrumbs) ---
function getElementText(
    $: cheerio.CheerioAPI,
    primaryConfigs?: SelectorConfigItem[],
    fallbackConfigs?: SelectorConfigItem[],
    targetAttribute?: string // Sadece belirli bir attr hedefleniyorsa
): string | null {
    const configsToTry = [...(primaryConfigs || []), ...(fallbackConfigs || [])];
    for (const config of configsToTry) {
        if (!config || !config.selector) continue;
        const el = $(config.selector).first();
        if (el.length) {
            const attr = targetAttribute || config.attr;
            const text = sanitizeText(attr ? el.attr(attr) : el.text());
            if (text) return text;
        }
    }
    return null;
}

function getAllElementTexts($: cheerio.CheerioAPI, selectors: { selector: string, attr?: string, isTable?: boolean }[]): string[] | null {
  const results: string[] = [];
  
  for (const config of selectors) {
    $(config.selector).each((i, el) => {
      const item = $(el);
      let value: string | undefined | null = null;
      
      if (config.attr) {
        value = item.attr(config.attr);
      } else {
        if (item.is('tr') && config.isTable === true) { // Özellik tablosu
          const thText = sanitizeText(item.find('th, td:first-child').text());
          const tdText = sanitizeText(item.find('td:nth-child(2), td:last-child').text());
          if (thText && tdText) value = `${thText.replace(/:$/, '')}: ${tdText}`;
          else if (tdText && !thText) value = tdText; // Only value column
          else if (thText && !tdText) value = thText; // Only key column
        } else {
          value = item.text();
        }
      }
      
      const sanitized = sanitizeText(value);
      if (sanitized) results.push(sanitized);
    });
    
    if (results.length > 0 && selectors.length > 1) break; // If multiple selector groups, stop after first success
  }
  
  return results.length > 0 ? results : null;
}

function extractImagesFromSelectors($: cheerio.CheerioAPI, pageUrl: string, mainSelectorConfigs: {selector: string, attr?:string}[], fallbackSelector: string = 'img[src]'): ImageItem[] {
    const images: ImageItem[] = [];
    const seenSources = new Set<string>();

    const processImage = (item: cheerio.Cheerio<cheerio.Element>, srcAttrVal?: string) => {
        let rawSrc = srcAttrVal ? item.attr(srcAttrVal) : null;
        if (!rawSrc) { // If srcAttrVal not provided or not found, try common attributes
             rawSrc = item.attr('src') || item.attr('data-src') || item.attr('data-lazy-src') || item.attr('data-original') ||
                      item.attr('data-srcset')?.split(',')[0].trim().split(' ')[0];
        }
        const absSrc = resolveUrl(rawSrc, pageUrl);
        addLog(`[extractImages] Candidate: raw="${rawSrc}", abs="${absSrc}" from selector: ${item.parent().html()?.substring(0,50)}...`, {level: 'debug'}); // DETAYLI LOG

        if (absSrc && !seenSources.has(absSrc)) {
            if (!absSrc.match(/\.(jpeg|jpg|gif|png|webp|avif)(\?|$)/i)) {
                addLog(`[extractImages] Filtered out (bad extension): ${absSrc}`, {level: 'debug'});
                return;
            }
            // GEÇİCİ OLARAK BU FİLTREYİ YORUM SATIRI YAPIN
            /*
            if (/logo|icon|avatar|spinner|loader|placeholder|favicon|\.svg|dummy|ads|banner|1x1|pixel|feed|badge|rating|captcha|thumb|pattern|background|bg|spacer|shield|overlay/i.test(absSrc)) {
                addLog(`[extractImages] Filtered out (keyword match): ${absSrc}`, {level: 'debug'});
                return;
            }
            */
            if (absSrc.length < 10) {
                addLog(`[extractImages] Filtered out (too short): ${absSrc}`, {level: 'debug'});
                return;
            }

            const alt = sanitizeText(item.attr('alt'));
            let width = sanitizeText(item.attr('width'));
            let height = sanitizeText(item.attr('height'));

            // Try to get dimensions from style attribute if not present
            if ((!width || !height) && (item.is('img') || item.is('a'))) { // Only for img or a (if href is image)
                const style = item.attr('style');
                if (style) {
                    const widthMatch = style.match(/width:\s*(\d+)(px)?/i);
                    if (widthMatch && !width) width = widthMatch[1];
                    const heightMatch = style.match(/height:\s*(\d+)(px)?/i);
                    if (heightMatch && !height) height = heightMatch[1];
                }
            }
            // Filter out very small images if dimensions are known (geçici olarak yorumlandı)
            /*
            const numWidth = width ? parseInt(width) : 0;
            const numHeight = height ? parseInt(height) : 0;

            if ((width && numWidth < 50) || (height && numHeight < 50)) {
                if (!(numWidth > 200 || numHeight > 200)) { // Don't skip if one dimension is large
                    addLog(`[extractImages] Filtered out (too small dimensions): ${absSrc} W:${numWidth} H:${numHeight}`, {level: 'debug'});
                    return;
                }
            }
            */

            images.push({ 
                src: absSrc, 
                alt: alt || sanitizeText(item.attr('title')) || 'Image', // Fallback alt
                width: width || null, 
                height: height || null, 
                hasAlt: !!alt 
            });
            seenSources.add(absSrc);
        } else if (absSrc && seenSources.has(absSrc)) {
           addLog(`[extractImages] Already seen: ${absSrc}`, {level: 'debug'});
        } else if (!absSrc) {
            addLog(`[extractImages] No absolute source resolved for raw: ${rawSrc}`, {level: 'warn'});
        }
    };

    mainSelectorConfigs.forEach(config => {
        $(config.selector).each((i, el) => processImage($(el), config.attr));
    });

    // Fallback: If main selectors yield no images, try the general fallbackSelector
    if (images.length === 0 && fallbackSelector) {
        $(fallbackSelector).each((i, el) => processImage($(el))); // srcAttr will be determined by processImage
    }
    return images;
}

function extractHeadingsCheerio($: cheerio.CheerioAPI): ScrapedPageData['headings'] {
  const headingsData: { 
    h1: string[]; 
    h2: string[]; 
    h3: string[]; 
    h4: string[]; 
    h5: string[]; 
    h6: string[]; 
    all: HeadingItem[]; 
  } = {
    h1: [],
    h2: [],
    h3: [],
    h4: [],
    h5: [],
    h6: [],
    all: [],
  };

  $('h1, h2, h3, h4, h5, h6').each((i, el) => {
    const element = $(el);
    const text = sanitizeText(element.text());
    const tagName = element.prop('tagName');
    if (!tagName) return; 
    const level = parseInt(tagName.substring(1), 10);

    if (text && !isNaN(level) && level >= 1 && level <= 6) {
      const headingLevelKey = `h${level}` as keyof typeof headingsData;
      // Type guard to ensure we're pushing to an array
      if (Array.isArray(headingsData[headingLevelKey])) {
        (headingsData[headingLevelKey] as string[]).push(text);
      }
      headingsData.all.push({ level: level as HeadingItem['level'], text });
    }
  });
  
  // Return null if no headings were found at all, otherwise the populated object
  return headingsData.all.length > 0 ? headingsData : null;
}

function extractPageLinks($: cheerio.CheerioAPI, pageUrl: string): { allLinks: LinkItem[], internalLinks: LinkItem[], externalLinks: LinkItem[] } {
    const allLinks: LinkItem[] = [];
    const internalLinks: LinkItem[] = [];
    const externalLinks: LinkItem[] = [];
    const currentHostname = new NodeURL(pageUrl).hostname;
    const processedHrefs = new Set<string>();

    $('a[href]').each((i, el) => {
        const anchor = $(el);
        const rawHref = anchor.attr('href');
        if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:')) {
            return;
        }
        const absHref = resolveUrl(rawHref, pageUrl);
        if (!absHref || processedHrefs.has(absHref) || absHref === pageUrl) {
            return;
        }
        processedHrefs.add(absHref);
        const text = sanitizeText(anchor.text()) || sanitizeText(anchor.attr('title')) || sanitizeText(anchor.find('img').attr('alt')) || absHref.split('/').pop() || 'Link';
        try {
            const linkItem: LinkItem = { text, href: absHref, isExternal: new NodeURL(absHref).hostname !== currentHostname };
            allLinks.push(linkItem);
            if (linkItem.isExternal) externalLinks.push(linkItem);
            else internalLinks.push(linkItem);
        } catch (e) { /* ignore invalid URL */ }
    });
    return { allLinks, internalLinks, externalLinks };
}


function extractSpecificLinks($: cheerio.CheerioAPI, containerSelectorConfigs: {selector: string}[], pageUrl: string): LinkItem[] {
    const links: LinkItem[] = [];
    const currentHostname = new NodeURL(pageUrl).hostname;
    const processedHrefs = new Set<string>();

    for (const config of containerSelectorConfigs) {
        // Ana konteyneri bul, sonra içindeki tüm 'a' tag'larını al
        $(config.selector).find('a[href]').each((i, el) => {
            const anchor = $(el);
            const rawHref = anchor.attr('href');
            if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:')) {
                return;
            }
            const absHref = resolveUrl(rawHref, pageUrl);
            if (!absHref || processedHrefs.has(absHref) || absHref === pageUrl) {
                return;
            }
            processedHrefs.add(absHref);
            const text = sanitizeText(anchor.text()) || sanitizeText(anchor.attr('title')) || sanitizeText(anchor.find('img').attr('alt')) || absHref.split('/').pop() || 'Link';
            try {
                links.push({ text, href: absHref, isExternal: new NodeURL(absHref).hostname !== currentHostname });
            } catch(e) { /* no-op */ }
        });
    }
    return links;
}



function extractBreadcrumbsCheerio($: cheerio.CheerioAPI, pageUrl: string): BreadcrumbItem[] | null {
    const items: BreadcrumbItem[] = [];
    // Use GENERAL_SELECTORS.breadcrumbsContainers as per the updated GENERAL_SELECTORS structure
    for (const config of GENERAL_SELECTORS.breadcrumbsContainers) { 
        $(config.selector).find('li, [itemprop="itemListElement"]').each((i, el) => { // Hem li hem de schema item'larını al
            const itemEl = $(el);
            let text: string | null = null;
            let href: string | undefined = undefined;
            let position: number = i + 1;

            if (itemEl.is('[itemprop="itemListElement"]')) { // Schema.org yapısı
                const nameEl = itemEl.find('[itemprop="name"]').first();
                const itemLinkEl = itemEl.find('[itemprop="item"]').first();
                text = sanitizeText(nameEl.text() || itemEl.find('a').text() || itemEl.text()); // İçerideki span'ı da alabilir
                href = resolveUrl(itemLinkEl.attr('content') || itemEl.find('a').attr('href'), pageUrl) || undefined;
                const posAttr = itemEl.find('meta[itemprop="position"]').attr('content');
                if (posAttr) position = parseInt(posAttr);
            } else { // Genel li > a yapısı
                const anchor = itemEl.find('a').first();
                if (anchor.length) {
                    text = sanitizeText(anchor.text());
                    href = resolveUrl(anchor.attr('href'), pageUrl) || undefined;
                } else {
                    text = sanitizeText(itemEl.text()); // Link olmayan son eleman
                }
            }
            if (text) {
                items.push({ text, href, position });
            }
        });
        if (items.length > 0) {
             // İlk eleman Anasayfa değilse ekle
            if (!items[0] || (items[0].text.toLowerCase() !== 'anasayfa' && items[0].text.toLowerCase() !== 'home')) {
                items.unshift({ text: 'Anasayfa', href: resolveUrl('/', pageUrl) || pageUrl, position: 0 });
                items.forEach((item, index) => item.position = index + 1); // Pozisyonları yeniden ata
            }
            break;
        }
    }
    const uniqueItems = Array.from(new Map(items.map(item => [`${item.text}-${item.href}`, item])).values())
                        .sort((a,b) => a.position - b.position); // Pozisyona göre sırala
    return uniqueItems.length > 0 ? uniqueItems : null;
}


// --- SITEMAP UTILITIES ---

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const externalAxiosInstance: AxiosInstance = axios.create({
    timeout: 20000, // Default timeout
    headers: {
        'User-Agent': 'SITGenericFetcher/1.0 (compatible; Googlebot/2.1)',
        'Accept': 'application/xml, text/xml, text/plain, application/octet-stream, */*',
        'Accept-Encoding': 'gzip, deflate'
    }
});

externalAxiosInstance.interceptors.response.use(
    response => response,
    async (error: AxiosError) => {
        const config = error.config;
        if (!config) return Promise.reject(error);

        // @ts-ignore - Consider defining a custom config type if this causes issues
        config.retryCount = config.retryCount || 0;

        const status = error.response?.status;

        // Retry for specific HTTP status codes (e.g., rate limits, server errors) or network errors
        if (status === 429 || (status && status >= 500 && status <= 599) || error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || !status) {
            // @ts-ignore
            if (config.retryCount < 3) {
                // @ts-ignore
                config.retryCount += 1;
                const retryDelay = Math.pow(2, config.retryCount) * 1000 + Math.random() * 1000; // Exponential backoff
                addLog(`[SitemapUtil] Retrying request to ${config.url}, attempt ${config.retryCount} after ${retryDelay}ms due to ${status || error.code}`, { level: 'warn' });
                await delay(retryDelay);
                return externalAxiosInstance(config);
            }
        }
        return Promise.reject(error);
    }
);


interface SitemapEntry {
    loc: string[];
    lastmod?: string[];
}

interface UrlEntry {
    loc:string[];
    lastmod?: string[];
    // Add other potential fields like <changefreq>, <priority>, <image:image>, etc. if needed
}

export async function tryAlternativeSitemapUrls(baseUrlOrSitemapUrl: string): Promise<string | null> {
    let baseHostname: string;
    let baseProtocol: string;
    try {
        const parsedUrl = new NodeURL(baseUrlOrSitemapUrl);
        baseHostname = parsedUrl.hostname;
        baseProtocol = parsedUrl.protocol;
        if (!baseHostname) throw new Error("Invalid URL provided to tryAlternativeSitemapUrls");

        // If it already looks like a sitemap URL, try it first
        if (parsedUrl.pathname.match(/\.xml(\.gz)?$/i) || parsedUrl.pathname.includes('sitemap')) {
            try {
                await externalAxiosInstance.head(baseUrlOrSitemapUrl);
                addLog(`[SitemapUtil] Confirmed sitemap at initial URL: ${baseUrlOrSitemapUrl}`);
                return baseUrlOrSitemapUrl;
            } catch (e) {
                addLog(`[SitemapUtil] Initial sitemap URL ${baseUrlOrSitemapUrl} failed. Trying alternatives.`, { level: 'warn' });
            }
        }
    } catch (e) {
        logError(e, "[SitemapUtil] Invalid URL in tryAlternativeSitemapUrls", { url: baseUrlOrSitemapUrl });
        return null;
    }


    const commonPaths = [
        '/sitemap.xml',
        '/sitemap_index.xml',
        '/sitemap.xml.gz',
        '/sitemap_index.xml.gz',
        '/sitemap', // Less common, but seen
        '/sitemap/',
        '/sitemaps.xml',
        '/sitemap-index.xml',
        '/post-sitemap.xml',
        '/page-sitemap.xml',
        '/product-sitemap.xml',
        '/category-sitemap.xml',
        '/news-sitemap.xml',
        '/robots.txt' // To parse for sitemap directive
    ];

    for (const path of commonPaths) {
        const sitemapUrlToTry = `${baseProtocol}//${baseHostname}${path}`;
        try {
            addLog(`[SitemapUtil] Trying alternative sitemap URL: ${sitemapUrlToTry}`);
            if (path === '/robots.txt') {
                const response = await externalAxiosInstance.get(sitemapUrlToTry, { responseType: 'text' });
                const robotsContent = response.data;
                const sitemapLine = robotsContent.split('\n').find((line: string) => line.toLowerCase().startsWith('sitemap:'));
                if (sitemapLine) {
                    const sitemapFromRobots = sitemapLine.substring(sitemapLine.indexOf(':') + 1).trim();
                    if (sitemapFromRobots) {
                         // Verify this one too
                        try {
                            await externalAxiosInstance.head(sitemapFromRobots);
                            addLog(`[SitemapUtil] Found and verified sitemap from robots.txt: ${sitemapFromRobots}`);
                            return sitemapFromRobots;
                        } catch (headError) {
                            addLog(`[SitemapUtil] Sitemap from robots.txt (${sitemapFromRobots}) failed HEAD request.`, { level: 'warn' });
                            continue; // Try next common path
                        }
                    }
                }
            } else {
                await externalAxiosInstance.head(sitemapUrlToTry);
                addLog(`[SitemapUtil] Found sitemap at: ${sitemapUrlToTry}`);
                return sitemapUrlToTry;
            }
        } catch (error) {
            // addLog(`[SitemapUtil] No sitemap at ${sitemapUrlToTry}.`, { level: 'debug' });
        }
    }

    addLog(`[SitemapUtil] No common sitemap URL found for ${baseHostname}.`, { level: 'warn' });
    return null;
}


export async function fetchAndParseSitemap(
    sitemapUrlInput: string,
    depth = 0,
    visitedSitemaps = new Set<string>(),
    allFoundUrls = new Set<string>()
): Promise<string[]> {
    if (depth > 10) { // Max recursion depth
        logError(new Error("Sitemap parsing depth limit reached"), "[SitemapUtil] Max depth", { url: sitemapUrlInput });
        return Array.from(allFoundUrls);
    }

    let currentSitemapUrl = sitemapUrlInput;
    // Attempt to find a sitemap if a base URL is given
    if (depth === 0 && (!sitemapUrlInput.includes('.xml') && !sitemapUrlInput.includes('sitemap'))) {
        addLog(`[SitemapUtil] Initial input ${sitemapUrlInput} doesn't look like a sitemap URL. Trying alternatives.`);
        const foundSitemap = await tryAlternativeSitemapUrls(sitemapUrlInput);
        if (!foundSitemap) {
            addLog(`[SitemapUtil] No sitemap could be found for ${sitemapUrlInput}. Returning empty list.`);
            return [];
        }
        currentSitemapUrl = foundSitemap;
    }


    if (visitedSitemaps.has(currentSitemapUrl)) {
        addLog(`[SitemapUtil] Already visited: ${currentSitemapUrl}`, { level: 'debug' });
        if (depth === 0) return Array.from(allFoundUrls); // Return collected URLs if top-level call
        return []; // Return empty for recursive calls to avoid duplicate processing in current branch
    }
    visitedSitemaps.add(currentSitemapUrl);
    addLog(`[SitemapUtil] Fetching sitemap: ${currentSitemapUrl} (Depth: ${depth})`);

    try {
        const response = await externalAxiosInstance.get(currentSitemapUrl, {
            responseType: currentSitemapUrl.endsWith('.gz') ? 'arraybuffer' : 'text',
        });

        let xmlData: string;
        if (currentSitemapUrl.endsWith('.gz')) {
            xmlData = zlib.gunzipSync(response.data).toString();
        } else {
            xmlData = response.data;
        }

        const parser = new xml2js.Parser({ explicitArray: true, mergeAttrs: true, explicitRoot: true });
        const result = await parser.parseStringPromise(xmlData);

        if (result.sitemapindex && result.sitemapindex.sitemap) {
            addLog(`[SitemapUtil] Parsed sitemap index: ${currentSitemapUrl}. Found ${result.sitemapindex.sitemap.length} sub-sitemaps.`);
            const sitemaps: SitemapEntry[] = result.sitemapindex.sitemap;
            for (const sitemap of sitemaps) {
                if (sitemap.loc && sitemap.loc[0]) {
                    const subSitemapUrl = new NodeURL(sitemap.loc[0], currentSitemapUrl).toString();
                    await fetchAndParseSitemap(subSitemapUrl, depth + 1, visitedSitemaps, allFoundUrls);
                }
            }
        } else if (result.urlset && result.urlset.url) {
            addLog(`[SitemapUtil] Parsed URL set: ${currentSitemapUrl}. Found ${result.urlset.url.length} URLs.`);
            const urls: UrlEntry[] = result.urlset.url;
            urls.forEach(urlEntry => {
                if (urlEntry.loc && urlEntry.loc[0]) {
                    try {
                        const resolvedUrl = new NodeURL(urlEntry.loc[0], currentSitemapUrl).toString();
                        allFoundUrls.add(resolvedUrl);
                    } catch (e) {
                        logError(e, "[SitemapUtil] Invalid URL in sitemap", { urlStr: urlEntry.loc[0], sitemap: currentSitemapUrl });
                    }
                }
            });
        } else if (result.rss && result.rss.channel && result.rss.channel[0] && result.rss.channel[0].item) {
            const items = result.rss.channel[0].item;
            addLog(`[SitemapUtil] Parsed RSS feed: ${currentSitemapUrl}. Found ${items.length} items.`);
            items.forEach((item: any) => {
                if (item.link && item.link[0]) {
                     try {
                        const resolvedUrl = new NodeURL(item.link[0], currentSitemapUrl).toString();
                        allFoundUrls.add(resolvedUrl);
                    } catch (e) {
                         logError(e, "[SitemapUtil] Invalid URL in RSS item", { urlStr: item.link[0], sitemap: currentSitemapUrl });
                    }
                }
            });
        } else if (result.feed && result.feed.entry) { // Atom feed
            const entries = result.feed.entry;
            addLog(`[SitemapUtil] Parsed Atom feed: ${currentSitemapUrl}. Found ${entries.length} entries.`);
            entries.forEach((entry: any) => {
                if (entry.link && Array.isArray(entry.link)) {
                    const hrefAttr = entry.link.find((l: any) => l.rel === 'alternate' || !l.rel)?.href;
                    if (hrefAttr && typeof hrefAttr === 'string') {
                         try {
                            const resolvedUrl = new NodeURL(hrefAttr, currentSitemapUrl).toString();
                            allFoundUrls.add(resolvedUrl);
                        } catch (e) {
                            logError(e, "[SitemapUtil] Invalid URL in Atom entry link", { urlStr: hrefAttr, sitemap: currentSitemapUrl });
                        }
                    }
                } else if (entry.id && typeof entry.id[0] === 'string' && entry.id[0].startsWith('http')) { // Fallback to ID if it's a URL
                     try {
                        const resolvedUrl = new NodeURL(entry.id[0], currentSitemapUrl).toString();
                        allFoundUrls.add(resolvedUrl);
                    } catch (e) {
                        logError(e, "[SitemapUtil] Invalid URL in Atom entry ID", { urlStr: entry.id[0], sitemap: currentSitemapUrl });
                    }
                }
            });
        } else {
            addLog(`[SitemapUtil] Unknown sitemap format or empty sitemap: ${currentSitemapUrl}`, { level: 'warn', dataPreview: xmlData.substring(0, 200) });
        }
    } catch (error: any) {
        logError(error, `[SitemapUtil] Error processing sitemap ${currentSitemapUrl}`, {
            errorMessage: error.message,
            stack: error.stack?.substring(0, 300),
            isAxiosError: axios.isAxiosError(error),
            responseStatus: error.response?.status,
            responseDataSample: typeof error.response?.data === 'string' ? error.response.data.substring(0, 200) : undefined
        });
    }

    if (depth === 0) {
        addLog(`[SitemapUtil] Finished parsing. Total unique URLs found: ${allFoundUrls.size}`);
        return Array.from(allFoundUrls);
    }
    return []; // For recursive calls, the main collection is handled by allFoundUrls reference
}


// --- ANA VERİ ÇIKARMA FONKSİYONU ---
export async function extractBaseDataFromHtml(
    htmlContent: string,
    pageUrl: string
): Promise<Partial<ScrapedPageData>> {
  const $ = cheerio.load(htmlContent);
  const data: Partial<ScrapedPageData> = {
    url: pageUrl,
    images: [],
    jsonLdData: [],
    features: [],
    blogCategories: [],
    schemaOrgTypes: [], // Initialized
    headings: { h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], all: [] }, // Initialized
    allLinks: [], // Initialized
    internalLinks: [], // Initialized
    externalLinks: [], // Initialized
    navigationLinks: [], // Initialized
    footerLinks: [], // Initialized
    breadcrumbs: [], // Initialized
  };
  let siteHostname = '';
  try { siteHostname = new NodeURL(pageUrl).hostname; }
  catch (e) { console.warn(`Invalid pageUrl for hostname extraction: ${pageUrl}`, e); }

  const siteSelectors = siteHostname ? await getStoredSiteSelectors(siteHostname) : null;
  if (siteSelectors) {
      addLog(`[ScraperUtils] Using specific selectors for ${siteHostname}`, {pageUrl});
      data.siteSelectorsUsed = true;
  } else {
      addLog(`[ScraperUtils] No specific selectors for ${siteHostname}. Using GENERAL_SELECTORS.`, {pageUrl});
      data.siteSelectorsUsed = false;
  }

  // 1. Temel Metadatalar
  data.title = getElementText($, siteSelectors?.title, GENERAL_SELECTORS.title) || sanitizeText($('h1').first().text()) || pageUrl.split('/').pop()?.replace(/-/g, ' ')?.replace(/_/g, ' ') || 'Başlık Yok';
  try {
    const currentUrlObj = new NodeURL(pageUrl);
    if (data.title === pageUrl || data.title?.toLowerCase().includes(currentUrlObj.hostname.toLowerCase())) {
        data.title = sanitizeText($('h1').first().text()) || sanitizeText($('title').text()) || 'Başlık Yok';
    }
  } catch(e) { /* no-op if pageUrl is invalid */ }
  
  data.metaDescription = getElementText($, siteSelectors?.metaDescription, GENERAL_SELECTORS.metaDescription); 
  const keywordsString = getElementText($, siteSelectors?.keywords, GENERAL_SELECTORS.keywords);
  data.keywords = keywordsString ? keywordsString.split(',').map(k => sanitizeText(k)).filter((k): k is string => k !== null && k.length > 1) : undefined;
  if (data.keywords?.length === 0) data.keywords = undefined;

  data.ogType = sanitizeText($('meta[property="og:type"]').attr('content'));
  data.ogTitle = sanitizeText($('meta[property="og:title"]').attr('content')) || data.title;
  data.ogDescription = sanitizeText($('meta[property="og:description"]').attr('content')) || data.metaDescription;
  data.ogImage = resolveUrl(getElementText($, siteSelectors?.ogImage, GENERAL_SELECTORS.ogImage, 'content'), pageUrl);
  data.canonicalUrl = resolveUrl(getElementText($, siteSelectors?.canonicalUrl, GENERAL_SELECTORS.canonicalUrl, 'href'), pageUrl);
  data.htmlLang = sanitizeText($('html').attr('lang'));
  data.metaRobots = getElementText($, [{selector: 'meta[name="robots"]', attr: 'content'}]);

  // 2. JSON-LD
  const schemaOrgTypesFromLd: string[] = [];
  let mainProductSchema: any = null, mainBlogSchema: any = null, mainCategorySchema: any = null;
  
  const tempJsonLdData: any[] = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const scriptContent = $(el).html();
      if (scriptContent) {
        const parsedJson = JSON.parse(scriptContent);
        const itemsToPush = Array.isArray(parsedJson) ? parsedJson : [parsedJson];
        itemsToPush.forEach(item => {
          if (typeof item === 'object' && item !== null) {
            tempJsonLdData.push(item);
            const type = item['@type'];
            const currentTypes = Array.isArray(type) ? type.map(t => String(t).toLowerCase()) : (type ? [String(type).toLowerCase()] : []);
            if (currentTypes.some(t => t === 'product')) { if (!mainProductSchema) mainProductSchema = item; }
            if (currentTypes.some(t => t === 'blogposting' || t === 'article' || t === 'newsarticle')) { if (!mainBlogSchema) mainBlogSchema = item; }
            if (currentTypes.some(t => t === 'collectionpage' || t === 'itemlist' || t === 'productgroup' || t === 'categorycodelist')) { if (!mainCategorySchema) mainCategorySchema = item; }
            currentTypes.forEach(t => schemaOrgTypesFromLd.push(t));
          }
        });
      }
    } catch (e) { console.warn(`Error parsing JSON-LD from ${pageUrl}: ${e instanceof Error ? e.message : String(e)}`); }
  });
  data.jsonLdData = tempJsonLdData.length > 0 ? tempJsonLdData : null;
  data.schemaOrgTypes = schemaOrgTypesFromLd.length > 0 ? [...new Set(schemaOrgTypesFromLd)] : undefined;

  // 3. SAYFA TÜRÜ TAHMİNİ
  let pageTypeGuess: ScrapedPageData['pageTypeGuess'] = 'unknown';
  if (mainProductSchema) pageTypeGuess = 'product';
  else if (mainBlogSchema) pageTypeGuess = 'blog'; 
  else if (mainCategorySchema) pageTypeGuess = 'category'; 

  if (pageTypeGuess === 'unknown' && data.ogType) {
    const ogTypeLower = data.ogType.toLowerCase();
    if (ogTypeLower.includes('product')) pageTypeGuess = 'product';
    else if (ogTypeLower.includes('article') || ogTypeLower.includes('blog') || ogTypeLower.includes('news')) pageTypeGuess = 'blog'; 
  }
  
  // HTML içeriğinden tahmin
  if (pageTypeGuess === 'unknown') {
      const priceSelectorsToJoin = (siteSelectors?.price || []).concat(GENERAL_SELECTORS.price || []);
      const priceSelStr = priceSelectorsToJoin.map(s => s.selector).join(', ');
      const hasPrice = priceSelStr ? $(priceSelStr).length > 0 : false;
      const hasAddToCart = $('form[action*="cart"] button, button[name*="add-to-cart"], .add-to-cart-button, input[name*="add-to-cart"]').length > 0;
      
      // Assuming GENERAL_SELECTORS.stockStatus exists in config as per prompt
      const stockSelectorsToJoin = (siteSelectors?.stockStatus || []).concat(GENERAL_SELECTORS.stockStatus || []); 
      const stockSelStr = stockSelectorsToJoin.map(s => s.selector).join(', ');
      const hasStockInfo = stockSelStr ? $(stockSelStr).length > 0 : false;

      if (hasPrice && (hasAddToCart || hasStockInfo)) {
          pageTypeGuess = 'product';
      }
      else if ($('.product-item, .product-list-item, .prd-list-item, [class*="product_item"]').length > 2 || 
               $('.category-products, .product-grid, .product_list').length > 0) {
          pageTypeGuess = 'category'; 
      }
      else if ($('article.post, .blog-post, .entry-content, [itemtype*="BlogPosting"]').length > 0 || 
               $('#comments, .comment-list, .post-comments').length > 0) {
          pageTypeGuess = 'blog'; 
      }
  }
  
  // URL deseninden tahmin (config'den gelen GENERAL_URL_PATTERNS kullanılacak)
  if (pageTypeGuess === 'unknown') {
    try {
        const path = new NodeURL(pageUrl).pathname.toLowerCase();
        const query = new NodeURL(pageUrl).search.toLowerCase();

        if (GENERAL_URL_PATTERNS.product.some(p => path.includes(p))) pageTypeGuess = 'product';
        else if (GENERAL_URL_PATTERNS.blog.some(p => path.includes(p))) pageTypeGuess = 'blog'; 
        else if (GENERAL_URL_PATTERNS.category.some(p => path.includes(p))) pageTypeGuess = 'category'; 
        else if (GENERAL_URL_PATTERNS.collection && GENERAL_URL_PATTERNS.collection.some(p => path.includes(p))) pageTypeGuess = 'collection';
        else if (GENERAL_URL_PATTERNS.forum && GENERAL_URL_PATTERNS.forum.some(p => path.includes(p))) pageTypeGuess = 'forum';
        else if (GENERAL_URL_PATTERNS.search && (GENERAL_URL_PATTERNS.search.some(p => path.includes(p)) || query.includes('q=') || query.includes('query=') || query.includes('search='))) pageTypeGuess = 'search';
        else if (GENERAL_URL_PATTERNS.error && GENERAL_URL_PATTERNS.error.some(p => path.includes(p))) pageTypeGuess = 'error';
        else if (path === '/sitemap.xml' || path.endsWith('/sitemap.xml') || path.includes('sitemap_index.xml')) pageTypeGuess = 'sitemap';
        else if (path === '/robots.txt') pageTypeGuess = 'robots';
        else if (path === '/feed' || path === '/rss' || (path.endsWith('.xml') && (htmlContent.includes('<rss') || htmlContent.includes('<feed')))) pageTypeGuess = 'feed';
        else if (path === '/' || (GENERAL_URL_PATTERNS.staticPageKeywords && GENERAL_URL_PATTERNS.staticPageKeywords.some(k => path.includes(k)))) pageTypeGuess = 'page';
    } catch (e) { /* invalid URL, pageTypeGuess remains unknown */ }
  }
  data.pageTypeGuess = pageTypeGuess;

  // 4. JSON-LD'DEN DETAYLI VERİ ÇIKARMA
  const jsonLdImages: ImageItem[] = [];
  if (mainProductSchema) {
    data.title = sanitizeText(mainProductSchema.name) || data.title;
    data.metaDescription = sanitizeText(mainProductSchema.description) || data.metaDescription;
    if (mainProductSchema.image) {
        const images = (Array.isArray(mainProductSchema.image) ? mainProductSchema.image : [mainProductSchema.image]);
        images.forEach((imgObj: any) => {
          let imgUrl = null;
          if (typeof imgObj === 'string') imgUrl = imgObj;
          else if (imgObj && typeof imgObj === 'object') imgUrl = imgObj.url || imgObj.contentUrl;
          const absSrc = resolveUrl(imgUrl, pageUrl);
          if (absSrc) {
              jsonLdImages.push({ 
                  src: absSrc, 
                  alt: sanitizeText(mainProductSchema.name || imgObj?.caption || imgObj?.name) || 'Product Image', 
                  hasAlt: !!(mainProductSchema.name || imgObj?.caption || imgObj?.name),
                  width: sanitizeText(imgObj?.width?.toString()),
                  height: sanitizeText(imgObj?.height?.toString()),
              });
          }
        });
    }
    if (mainProductSchema.offers) {
      const offer = Array.isArray(mainProductSchema.offers) ? (mainProductSchema.offers[0] || mainProductSchema.offers) : mainProductSchema.offers;
      if (offer && typeof offer === 'object') {
        data.price = sanitizeText(offer.price?.toString() || offer.lowPrice?.toString() || offer.highPrice?.toString())?.replace(',', '.');
        data.currencySymbol = sanitizeText(offer.priceCurrency); 
        const availability = sanitizeText(offer.availability)?.toLowerCase();
        if (availability) {
          if (availability.includes('instock') || availability.includes('onbackorder') || 
              availability.includes('preorder') || availability.includes('limitedavailability')) {
            data.stockStatus = 'Mevcut';
          } else if (availability.includes('outofstock') || availability.includes('soldout') || 
                    availability.includes('discontinued')) {
            data.stockStatus = 'Tükendi';
          } else {
            data.stockStatus = sanitizeText(offer.availability);
          }
        }
      }
    }
    data.category = sanitizeText(mainProductSchema.category || mainProductSchema.brand?.name); 
    if (mainProductSchema.additionalProperty && Array.isArray(mainProductSchema.additionalProperty)) {
      data.features = mainProductSchema.additionalProperty
        .filter((prop: any) => typeof prop === 'object' && prop.name && prop.value)
        .map((prop: any) => `${sanitizeText(prop.name)}: ${sanitizeText(prop.value)}`)
        .filter((f): f is string => f.length > 3);
        if (data.features?.length === 0) data.features = undefined;
    }
    data.aiProductSku = sanitizeText(mainProductSchema.sku || mainProductSchema.mpn || mainProductSchema.gtin13 || mainProductSchema.gtin14 || mainProductSchema.gtin8 || mainProductSchema.productID);
    data.aiProductBrand = sanitizeText(mainProductSchema.brand?.name);
  }
  else if (mainBlogSchema) {
    data.title = sanitizeText(mainBlogSchema.headline || mainBlogSchema.name) || data.title;
    data.metaDescription = sanitizeText(mainBlogSchema.description || mainBlogSchema.articleBody?.substring(0,300)) || data.metaDescription;
    data.publishDate = sanitizeText(mainBlogSchema.datePublished || mainBlogSchema.dateCreated); 
    if (data.publishDate && data.publishDate.includes('T')) data.publishDate = data.publishDate.split('T')[0];
    
    if (mainBlogSchema.articleSection) {
      data.blogCategories = (Array.isArray(mainBlogSchema.articleSection) ? 
                            mainBlogSchema.articleSection : [mainBlogSchema.articleSection])
                            .map(s => typeof s === 'string' ? sanitizeText(s) : (s?.name ? sanitizeText(s.name) : null))
                            .filter((s): s is string => s !== null && s.length > 1);
      if (data.blogCategories?.length === 0) data.blogCategories = undefined;
    }
    data.aiBlogAuthor = sanitizeText(mainBlogSchema.author?.name || (Array.isArray(mainBlogSchema.author) && mainBlogSchema.author[0]?.name));
    data.blogContentSample = sanitizeText(mainBlogSchema.articleBody?.substring(0, 500) || $('article p').first().text());

    if (mainBlogSchema.image) {
      const images = (Array.isArray(mainBlogSchema.image) ? mainBlogSchema.image : [mainBlogSchema.image]);
      images.forEach((imgObj: any) => {
        let imgUrl = null;
        if (typeof imgObj === 'string') imgUrl = imgObj;
        else if (imgObj && typeof imgObj === 'object') imgUrl = imgObj.url || imgObj.contentUrl;
        const absSrc = resolveUrl(imgUrl, pageUrl);
        if (absSrc) {
            jsonLdImages.push({ 
                src: absSrc, 
                alt: sanitizeText(mainBlogSchema.headline || imgObj?.caption || imgObj?.name) || 'Blog Image', 
                hasAlt: !!(mainBlogSchema.headline || imgObj?.caption || imgObj?.name),
                width: sanitizeText(imgObj?.width?.toString()),
                height: sanitizeText(imgObj?.height?.toString()),
            });
        }
      });
    }
  }
  else if (mainCategorySchema) {
    data.title = sanitizeText(mainCategorySchema.name || mainCategorySchema.headline) || data.title;
    data.category = data.title; 
    data.metaDescription = sanitizeText(mainCategorySchema.description) || data.metaDescription;
  }
  data.images = [...(data.images || []), ...jsonLdImages];


  // 5. CHEERIO SEÇICİLERİ İLE EKSİKLERİ TAMAMLAMA
  if (pageTypeGuess === 'product') {
    if (!data.price) {
        data.price = getElementText($, siteSelectors?.price, GENERAL_SELECTORS.price);
        if (data.price && !data.currencySymbol) {
          const priceMatch = data.price.match(/([^\d,.\s](?:\s*\d|\d))?([\d,.\s]+)([^\d,.\s](?:\s*\d|\d))?/);
          if (priceMatch) {
            data.price = sanitizeText(priceMatch[2])?.replace(/\.(?=\d{3}(?:,|$))/g, '').replace(',', '.');
            const symbol1 = sanitizeText(priceMatch[1]);
            const symbol3 = sanitizeText(priceMatch[3]);
            if (symbol1 && /[$€₺£¥]/.test(symbol1)) data.currencySymbol = symbol1;
            else if (symbol3 && /[$€₺£¥]/.test(symbol3)) data.currencySymbol = symbol3;
            else data.currencySymbol = symbol1 || symbol3;
          } else {
             data.price = data.price.replace(/[^\d,.]/g, '').replace(/\.(?=\d{3}(?:,|$))/g, '').replace(',', '.');
          }
        }
    }
    if (!data.stockStatus) {
        // MODIFIED: Use GENERAL_SELECTORS.stockStatus and default to "Bilinmiyor"
        data.stockStatus = getElementText($, siteSelectors?.stockStatus, GENERAL_SELECTORS.stockStatus); 
        if (data.stockStatus) {
            const stockLower = data.stockStatus.toLowerCase();
            if (stockLower.includes('out of stock') || stockLower.includes('tükendi') || stockLower.includes('yok') || stockLower.includes('stokta yok')) {
                data.stockStatus = 'Tükendi';
            } else if (stockLower.includes('in stock') || stockLower.includes('mevcut') || stockLower.includes('var') || stockLower.includes('stokta var')) {
                data.stockStatus = 'Mevcut';
            }
        } else {
            data.stockStatus = "Bilinmiyor"; // Default if not found
        }
    }
    // MODIFIED: Condition for features
    if ((!data.features || data.features.length === 0)) { 
        data.features = getAllElementTexts($, (siteSelectors?.features || []).concat(GENERAL_SELECTORS.features || []));
    }
    if (!data.category) data.category = getElementText($, siteSelectors?.productCategory, GENERAL_SELECTORS.productCategory);
  }
  else if (pageTypeGuess === 'blog') {
    if (!data.publishDate) data.publishDate = getElementText($, siteSelectors?.publishDate, GENERAL_SELECTORS.publishDate);
    if (data.publishDate && data.publishDate.includes('T')) data.publishDate = data.publishDate.split('T')[0];
    if (!data.blogCategories?.length) data.blogCategories = getAllElementTexts($, (siteSelectors?.blogPageCategories || []).concat(GENERAL_SELECTORS.blogCategories || []));
    if (data.blogCategories) data.blogCategories = [...new Set(data.blogCategories.filter(c => c.length > 1))];
    if (!data.blogContentSample) data.blogContentSample = getElementText($, siteSelectors?.blogContentSample, GENERAL_SELECTORS.blogContentSample);
    if (data.blogContentSample) data.blogContentSample = data.blogContentSample.slice(0,300) + (data.blogContentSample.length > 300 ? '...' : '');
  }
  else if (pageTypeGuess === 'category' && !data.category) {
      data.category = data.title || getElementText($, siteSelectors?.categoryName, GENERAL_SELECTORS.title); 
  }

  // 6. GENEL YAPISAL ELEMANLAR
  const productImagesSelectors = (siteSelectors?.productImages || []).concat(GENERAL_SELECTORS.productImages || []);
  const allExtractedImages = extractImagesFromSelectors($, pageUrl, productImagesSelectors, 'article img, main img, .content img');
  data.images = [...(data.images || []), ...allExtractedImages];
  
  if (data.ogImage && !(data.images || []).some(img => img.src === data.ogImage)) {
    (data.images || []).push({ src: data.ogImage, alt: 'OG Image', hasAlt: true, width: null, height: null });
  }

  const uniqueImageMap = new Map<string, ImageItem>();
  (data.images || []).forEach(img => { if(img?.src && !uniqueImageMap.has(img.src)) uniqueImageMap.set(img.src, img); }); 
  data.images = Array.from(uniqueImageMap.values());
  if (data.images.length === 0) data.images = null;
  
  if (!data.ogImage && data.images && data.images.length > 0) {
      const firstGoodImage = data.images.find(img => img.src && !/logo|icon|avatar|banner|placeholder|favicon|svg/i.test(img.src) && (img.width ? parseInt(img.width) > 100 : true) && (img.height ? parseInt(img.height) > 100 : true));
      if (firstGoodImage) data.ogImage = firstGoodImage.src;
      else if (data.images[0]?.src) data.ogImage = data.images[0].src;
  }

  data.headings = extractHeadingsCheerio($);
  data.breadcrumbs = extractBreadcrumbsCheerio($, pageUrl);
  // Breadcrumb'dan kategori çıkarımı (existing logic)
  if (data.breadcrumbs && data.breadcrumbs.length > 0) {
    if (pageTypeGuess === 'product' && !data.category && data.breadcrumbs.length > 1) {
        data.category = data.breadcrumbs[data.breadcrumbs.length - 2]?.text;
    } else if (pageTypeGuess === 'blog' && (!data.blogCategories || data.blogCategories?.length === 0) && data.breadcrumbs.length > 1) {
        const categoryFromBreadcrumb = data.breadcrumbs[data.breadcrumbs.length - 2]?.text;
        if (categoryFromBreadcrumb) data.blogCategories = [categoryFromBreadcrumb];
    } else if (pageTypeGuess === 'category' && !data.category) {
        data.category = data.breadcrumbs[data.breadcrumbs.length - 1]?.text;
    }
  }
  if (pageTypeGuess === 'category' && !data.category && data.title) {
      data.category = data.title;
  }

  const navLinkContainerSelectors = (siteSelectors?.navigationLinksContainers || []).concat(GENERAL_SELECTORS.navigationLinksContainers || []);
  data.navigationLinks = extractSpecificLinks($, navLinkContainerSelectors, pageUrl);
  if (data.navigationLinks.length === 0) data.navigationLinks = null;

  const footerLinkContainerSelectors = (siteSelectors?.footerLinksContainers || []).concat(GENERAL_SELECTORS.footerLinksContainers || []);
  data.footerLinks = extractSpecificLinks($, footerLinkContainerSelectors, pageUrl);
  if (data.footerLinks.length === 0) data.footerLinks = null;
  
  const linksData = extractPageLinks($, pageUrl);
  data.allLinks = linksData.allLinks.length > 0 ? linksData.allLinks : null;
  data.internalLinks = linksData.internalLinks.length > 0 ? linksData.internalLinks : null;
  data.externalLinks = linksData.externalLinks.length > 0 ? linksData.externalLinks : null;

  // 7. AI İÇİN ANA METİN
  // Mevcut mainTextContent çıkarma mantığı (cloning and cleaning)
  const $contentClone = $('body').clone();
  $contentClone.find(`
    header, footer, nav, aside, script, style, noscript, form, button, input, svg, iframe,
    .sidebar, [class*="related"], [class*="comment"], [class*="banner"], [class*="popup"], [class*="modal"],
    [id*="header"], [id*="footer"], [class*="header"], [class*="footer"], [class*="advert"],
    [class*="navigation"], .breadcrumb, .breadcrumbs, .pagination, .pager, [aria-hidden="true"], 
    [style*="display:none"], [style*="visibility:hidden"], link[rel="stylesheet"],
    *[data-nosnippet], .no-extract, .hidden, .visually-hidden
  `).remove();
  
  $contentClone.find('div, section, li, p').each((i, el) => {
    const element = $(el);
    const text = element.text().trim();
    const linksCount = element.find('a').length;
    const childElements = element.children().length;

    if (text.length < 100 && linksCount > 2 && (text.length / (linksCount + 1)) < 20) {
      element.remove();
    }
    if (text.length === 0 && childElements === 0 && !element.is('img')) {
        element.remove();
    }
  });
  
  // MODIFIED: Selectors for mainText
  let mainText = $contentClone.find('main').text() || 
                 $contentClone.find('article').text() || 
                 $contentClone.find('.content').text() || 
                 $contentClone.find('#content, #main, #Content, #Main').text() || 
                 $contentClone.text(); 
  
  data.mainTextContent = sanitizeText(mainText)?.replace(/\s{2,}/g, ' ').slice(0, 15000) || "";


  // Fallback title/description from main text (existing logic)
  if ((!data.title || data.title === 'Başlık Yok') && data.mainTextContent && data.mainTextContent.length > 10) {
    data.title = data.mainTextContent.substring(0, 70).split('\n')[0].trim();
    if (data.title.length > 65) data.title = data.title.substring(0, data.title.lastIndexOf(' ') > 0 ? data.title.lastIndexOf(' ') : 65);
    if (data.mainTextContent.length > 70 && data.title.length < 70) data.title += '...';
  }
  if (!data.metaDescription && data.mainTextContent && data.mainTextContent.length > 20) {
    data.metaDescription = data.mainTextContent.substring(0, 160).split('\n')[0].trim();
    if (data.metaDescription.length > 155) data.metaDescription = data.metaDescription.substring(0, data.metaDescription.lastIndexOf(' ') > 0 ? data.metaDescription.lastIndexOf(' ') : 155);
    if (data.mainTextContent.length > 160 && data.metaDescription.length < 160) data.metaDescription += '...';
  }

  return data;
}