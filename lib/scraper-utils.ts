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
   scrapeId?: string | null; // scrapeId'yi buraya ekleyin
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
// BU FONKSİYONU EKLEYİN VE EXPORT EDİN
export function mapCurrencySymbolToCode(symbol?: string | null): string | null {
  if (!symbol) return null;
  const map: Record<string, string> = {
    '₺': 'TRY',
    'tl': 'TRY',
    '$': 'USD',
    'usd': 'USD',
    '€': 'EUR',
    'eur': 'EUR',
    '£': 'GBP',
    'gbp': 'GBP',
    '¥': 'JPY',
    'cny': 'CNY', // Chinese Yuan için ekleme
    '₹': 'INR',
    '₽': 'RUB',
    '₩': 'KRW',
    'cad': 'CAD',
    'aud': 'AUD',
    // İhtiyaç duyulabilecek diğer yaygın semboller ve kısaltmalar eklenebilir
  };
  const trimmedSymbol = symbol.trim().toLowerCase();

  // Önce tam eşleşmeleri kontrol et (örn: "usd")
  if (map[trimmedSymbol]) {
    return map[trimmedSymbol];
  }

  // Sonra sembolün içinde geçip geçmediğini kontrol et (örn: "100₺" için "₺")
  for (const key in map) {
    if (trimmedSymbol.includes(key.toLowerCase())) {
      return map[key];
    }
  }

  // Eğer direkt eşleşme yoksa ve 3 harfli bir kodsa onu döndür
  if (trimmedSymbol.length === 3 && /^[a-z]+$/.test(trimmedSymbol)) {
    return trimmedSymbol.toUpperCase();
  }
  return null;
}

function sanitizeText(text: string | undefined | null): string | null {
  if (typeof text !== 'string') return null;
  return text.replace(/\s\s+/g, ' ').replace(/\u00A0/g, ' ').trim() || null; // Replaces non-breaking spaces too
}

export function resolveUrl(relativeUrl: string | undefined | null, baseUrl: string): string | null {
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
  let siteHostname = '';
  try { siteHostname = new NodeURL(pageUrl).hostname; } catch (e) { console.warn(`Invalid pageUrl for hostname extraction: ${pageUrl}`, e); }

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

  const siteSelectors = siteHostname ? await getStoredSiteSelectors(siteHostname) : null;
  data.siteSelectorsUsed = !!siteSelectors;

  // --- 1. Temel Metadatalar (ÖNCELİKLE BUNLAR OKUNMALI) ---
  data.title = sanitizeText($('title').text()) || 
               sanitizeText($('meta[property="og:title"]').attr('content')) || 
               sanitizeText($('h1').first().text()) || 
               pageUrl.split('/').pop()?.replace(/-/g, ' ')?.replace(/_/g, ' ') || 
               'Başlık Yok';

  // AÇIKLAMA (META DESCRIPTION) ÇIKARMA
  const metaDescTag = $('meta[name="description"]').attr('content');
  const ogDescTag = $('meta[property="og:description"]').attr('content');
  data.metaDescription = sanitizeText(metaDescTag || ogDescTag); // Öncelik meta desc, sonra og:desc

  data.ogType = sanitizeText($('meta[property="og:type"]').attr('content'));
  // og:title ve og:description'ı, data.title ve data.metaDescription'dan sonra,
  // eğer spesifik olarak ayarlanmışlarsa kullanmak daha iyi olabilir.
  data.ogTitle = sanitizeText($('meta[property="og:title"]').attr('content')) || data.title;
  data.ogDescription = sanitizeText($('meta[property="og:description"]').attr('content')) || data.metaDescription;
  
  data.ogImage = resolveUrl(getElementText($, siteSelectors?.ogImage, GENERAL_SELECTORS.ogImage, 'content'), pageUrl);
  data.canonicalUrl = resolveUrl(getElementText($, siteSelectors?.canonicalUrl, GENERAL_SELECTORS.canonicalUrl, 'href'), pageUrl);
  data.htmlLang = sanitizeText($('html').attr('lang'));
  data.metaRobots = getElementText($, [{selector: 'meta[name="robots"]', attr: 'content'}]);
  data.keywords = (getElementText($, siteSelectors?.keywords, GENERAL_SELECTORS.keywords) || "").split(',').map(k => sanitizeText(k)).filter((k): k is string => k !== null && k.length > 1);
  if (data.keywords?.length === 0) data.keywords = undefined;


  // --- 2. JSON-LD Verilerini Çekme ve Temel Alanları Doldurma ---
  const schemaOrgTypesFromLd: string[] = [];
  let mainProductSchema: any = null;
  let mainBlogSchema: any = null;
  let mainCategorySchema: any = null; // CollectionPage veya SearchResultsPage için
  const tempJsonLdData: any[] = [];

  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const scriptContent = $(el).html();
      if (scriptContent) {
        const jsonData = JSON.parse(scriptContent);
        const itemsToProcess = Array.isArray(jsonData) ? jsonData : [jsonData];
        
        for (const item of itemsToProcess) {
          if (typeof item !== 'object' || item === null) continue;
          tempJsonLdData.push(item);
          const type = item['@type'];
          if (type) {
            const typesArray = Array.isArray(type) ? type.map(t => String(t).toLowerCase()) : [String(type).toLowerCase()];
            typesArray.forEach((t: string) => schemaOrgTypesFromLd.push(t));

            if (typesArray.includes('product') && !mainProductSchema) mainProductSchema = item;
            if ((typesArray.includes('blogposting') || typesArray.includes('article') || typesArray.includes('newsarticle')) && !mainBlogSchema) mainBlogSchema = item;
            if ((typesArray.includes('collectionpage') || typesArray.includes('itemlist') || typesArray.includes('searchresultspage')) && !mainCategorySchema) mainCategorySchema = item;
          }
        }
      }
    } catch (e) { addLog(`[ScraperUtils] Error parsing JSON-LD: ${(e as Error).message}`, { level: 'warn' }); }
  });
  data.jsonLdData = tempJsonLdData.length > 0 ? tempJsonLdData : null;
  data.schemaOrgTypes = schemaOrgTypesFromLd.length > 0 ? [...new Set(schemaOrgTypesFromLd)] : undefined;

  // JSON-LD'den temel alanları önceden doldur (LLM için iyi bir başlangıç)
  if (mainProductSchema) {
    data.title = sanitizeText(mainProductSchema.name) || data.title;
    data.metaDescription = sanitizeText(mainProductSchema.description) || data.metaDescription;
    if (mainProductSchema.image) {
        const pImages = Array.isArray(mainProductSchema.image) ? mainProductSchema.image : [mainProductSchema.image];
        pImages.forEach((img: string | { url?: string; contentUrl?: string; thumbnailUrl?: string }) => {
            let pImgSrc: string | undefined | null = typeof img === 'string' ? img : (img?.url || img?.contentUrl || img?.thumbnailUrl);
            const resolvedImg = resolveUrl(pImgSrc, pageUrl);
            if (resolvedImg && !(data.images || []).some(i => i.src === resolvedImg)) {
                (data.images = data.images || []).push({ src: resolvedImg, alt: data.title || 'Product Image', hasAlt: !!data.title, width: null, height: null });
            }
        });
    }
    if (mainProductSchema.offers) {
        const offer = Array.isArray(mainProductSchema.offers) ? mainProductSchema.offers[0] : mainProductSchema.offers;
        if (offer) {
            data.price = sanitizeText(offer.price?.toString() || offer.lowPrice?.toString()) || data.price;
            data.currencyCode = sanitizeText(offer.priceCurrency) || data.currencyCode; // Genellikle kod olur
            if (offer.availability) {
                const availability = sanitizeText(offer.availability.toLowerCase())?.replace('http://schema.org/', '');
                if (availability?.includes('instock')) data.stockStatus = 'Mevcut';
                else if (availability?.includes('outofstock')) data.stockStatus = 'Tükendi';
                else if (availability?.includes('preorder')) data.stockStatus = 'Ön Sipariş';
                else data.stockStatus = sanitizeText(offer.availability) || data.stockStatus;
            }
        }
    }
    data.aiProductBrand = sanitizeText(mainProductSchema.brand?.name) || data.aiProductBrand;
    data.aiProductSku = sanitizeText(mainProductSchema.sku || mainProductSchema.mpn) || data.aiProductSku;
    if (mainProductSchema.category) {
        const catString = Array.isArray(mainProductSchema.category) ? mainProductSchema.category.join('; ') : mainProductSchema.category;
        data.category = sanitizeText(catString) || data.category; // Genel kategori için
        (data as any).productCategory = sanitizeText(catString) || (data as any).productCategory; // Ürün kategorisi için
    }
     if (mainProductSchema.additionalProperty) {
        const pFeatures: string[] = [];
        const addProps = Array.isArray(mainProductSchema.additionalProperty) ? mainProductSchema.additionalProperty : [mainProductSchema.additionalProperty];
        addProps.forEach((prop: { name?: string; value?: string; propertyID?: string }) => {
            if (prop.name && prop.value) pFeatures.push(`${sanitizeText(prop.name)}: ${sanitizeText(prop.value)}`);
            else if (prop.value && prop.propertyID) pFeatures.push(`${sanitizeText(prop.propertyID)}: ${sanitizeText(prop.value)}`);
            else if (prop.value) pFeatures.push(sanitizeText(prop.value)!);
        });
        if (pFeatures.length > 0) data.features = [...new Set([...(data.features || []), ...pFeatures.filter(f => f)])];
    }
  }
  if (mainBlogSchema) {
    data.title = sanitizeText(mainBlogSchema.headline || mainBlogSchema.name) || data.title;
    data.metaDescription = sanitizeText(mainBlogSchema.description || mainBlogSchema.articleBody?.substring(0,160)) || data.metaDescription;
    data.publishDate = sanitizeText(mainBlogSchema.datePublished || mainBlogSchema.dateCreated)?.split('T')[0] || data.publishDate;
    data.aiBlogAuthor = sanitizeText(mainBlogSchema.author?.name || (Array.isArray(mainBlogSchema.author) ? mainBlogSchema.author[0]?.name : null)) || data.aiBlogAuthor;
    if (mainBlogSchema.articleSection) {
        const bCats = (Array.isArray(mainBlogSchema.articleSection) ? mainBlogSchema.articleSection : [mainBlogSchema.articleSection])
                      .map(s => typeof s === 'string' ? sanitizeText(s) : (s?.name ? sanitizeText(s.name) : null))
                      .filter((s): s is string => s !== null && s.length > 1);
        if (bCats.length > 0) data.blogCategories = [...new Set([...(data.blogCategories || []), ...bCats])];
    }
    // Blog görselleri de eklenebilir
  }

  // --- 3. Sayfa Türü Tahmini (JSON-LD, URL ve HTML ipuçlarıyla) ---
  let pageTypeGuess: ScrapedPageData['pageTypeGuess'] = 'unknown';
  // Öncelik JSON-LD tiplerine
  if (data.schemaOrgTypes?.some(t => t === 'product')) pageTypeGuess = 'product';
  else if (data.schemaOrgTypes?.some(t => t === 'blogposting' || t === 'article' || t === 'newsarticle')) pageTypeGuess = 'blog'; // Daha spesifik
  else if (data.schemaOrgTypes?.some(t => t === 'collectionpage' || t === 'itemlist' || t === 'searchresultspage')) pageTypeGuess = 'category';
  else if (data.schemaOrgTypes?.some(t => t === 'webpage' || t === 'aboutpage' || t === 'contactpage')) pageTypeGuess = 'page';

  // Sonra OG:Type
  if (pageTypeGuess === 'unknown' && data.ogType) {
    const ogTypeLower = data.ogType.toLowerCase();
    if (ogTypeLower.includes('product')) pageTypeGuess = 'product';
    else if (ogTypeLower.includes('article')) pageTypeGuess = 'blog';
  }

  // Sonra URL Yolu
  if (pageTypeGuess === 'unknown') {
    try {
        const parsedPageUrl = new NodeURL(pageUrl);
        const path = parsedPageUrl.pathname.toLowerCase();
        if (path === '/' && !parsedPageUrl.search && !parsedPageUrl.hash) {
            pageTypeGuess = 'page'; // Özel tip homepage yerine page
        } else if (GENERAL_URL_PATTERNS.staticPageKeywords?.some(k => path.includes(k))) {
            pageTypeGuess = 'page';
        } else if (GENERAL_URL_PATTERNS.product?.some(p => (typeof p === 'string' ? path.includes(p) : p.test(path)))) pageTypeGuess = 'product';
        else if (GENERAL_URL_PATTERNS.blog?.some(p => (typeof p === 'string' ? path.includes(p) : p.test(path)))) pageTypeGuess = 'blog';
        else if (GENERAL_URL_PATTERNS.category?.some(p => (typeof p === 'string' ? path.includes(p) : p.test(path)))) pageTypeGuess = 'category';
        // ... diğer URL desenleri
    } catch(e) { /* no-op */ }
  }
  
  // Son olarak HTML içeriğinden ipuçları (eğer hala unknown ise)
  if (pageTypeGuess === 'unknown') {
    if (getElementText($, siteSelectors?.price, GENERAL_SELECTORS.price) || $('[itemprop="price"]').length > 0 || $('[class*="price"]').length > 0) {
        pageTypeGuess = 'product';
    } else if ($('article.post, .blog-post, .entry-content, [class*="blog-content"]').length > 0) {
        pageTypeGuess = 'blog';
    } else if ($('.products, .product-list, .category-products, [class*="product-grid"]').length > 0) {
        pageTypeGuess = 'category';
    }
  }
  data.pageTypeGuess = pageTypeGuess;

  // --- 4. Cheerio Seçicileri ile Eksik Kalan Temel Alanları Doldurma ---
  // (Bu kısım, JSON-LD'den sonra çalışarak eksikleri tamamlar veya üzerine yazar - önceliklendirme önemli)
  if (!data.title || data.title === 'Başlık Yok') data.title = getElementText($, siteSelectors?.title, GENERAL_SELECTORS.title) || data.title;
  if (!data.metaDescription) data.metaDescription = getElementText($, siteSelectors?.metaDescription, GENERAL_SELECTORS.metaDescription) || data.metaDescription;
  
  if (pageTypeGuess === 'product') {
    if (!data.price) {
        data.price = getElementText($, siteSelectors?.price, GENERAL_SELECTORS.price);
    }
    if (data.price && !data.currencySymbol && !data.currencyCode) { 
        const priceMatch = data.price.match(/([^\d,.\s](?:\s*\d|\d))?([\d,.\s]+)([^\d,.\s](?:\s*\d|\d))?/);
        if (priceMatch) {
            data.price = sanitizeText(priceMatch[2])?.replace(/\.(?=\d{3}(?:,|$))/g, '').replace(',', '.');
            const symbol1 = sanitizeText(priceMatch[1]);
            const symbol3 = sanitizeText(priceMatch[3]);
            data.currencySymbol = symbol1 || symbol3; // Take first available
            if (data.currencySymbol) data.currencyCode = mapCurrencySymbolToCode(data.currencySymbol);
        } else {
            data.price = data.price.replace(/[^\d,.]/g, '').replace(/\.(?=\d{3}(?:,|$))/g, '').replace(',', '.');
        }
    }
    if (!data.stockStatus || data.stockStatus === "Bilinmiyor") {
        data.stockStatus = getElementText($, siteSelectors?.stockStatus, GENERAL_SELECTORS.stockStatus) || data.stockStatus;
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
    if (!data.category) data.category = getElementText($, siteSelectors?.productCategory, GENERAL_SELECTORS.productCategory);
    if (!data.features || data.features.length === 0) data.features = getAllElementTexts($, (siteSelectors?.features || []).concat(GENERAL_SELECTORS.features || []));
  } else if (pageTypeGuess === 'blog') {
    if (!data.publishDate) data.publishDate = getElementText($, siteSelectors?.publishDate, GENERAL_SELECTORS.publishDate)?.split('T')[0];
    if (!data.blogCategories || data.blogCategories.length === 0) {
        data.blogCategories = getAllElementTexts($, (siteSelectors?.blogPageCategories || []).concat(GENERAL_SELECTORS.blogCategories || []));
        if (data.blogCategories) data.blogCategories = [...new Set(data.blogCategories.filter(c => c.length > 1))];
    }
    if (!data.blogContentSample) data.blogContentSample = getElementText($, siteSelectors?.blogContentSample, GENERAL_SELECTORS.blogContentSample)?.slice(0,500);
  }


  // --- 5. Diğer Yapısal Elemanlar (Breadcrumbs, Linkler, Görseller) ---
  data.headings = extractHeadingsCheerio($);
  data.breadcrumbs = extractBreadcrumbsCheerio($, pageUrl);
  // Breadcrumb'dan Kategori Çıkarımı (Eğer hala eksikse)
  if (data.breadcrumbs && data.breadcrumbs.length > 0) {
    if (pageTypeGuess === 'product' && !data.category) {
        if (data.breadcrumbs.length > 1) data.category = data.breadcrumbs[data.breadcrumbs.length - 2]?.text;
        else if (data.breadcrumbs[0]?.text.toLowerCase() !== 'anasayfa' && data.breadcrumbs[0]?.text.toLowerCase() !== 'home') data.category = data.breadcrumbs[0]?.text;
        if (data.category) (data as any).productCategory = data.breadcrumbs.map(b => b.text).join(' > '); 
    } else if (pageTypeGuess === 'category' && !data.category) {
        data.category = data.breadcrumbs[data.breadcrumbs.length - 1]?.text;
    } else if (pageTypeGuess === 'blog' && (!data.blogCategories || data.blogCategories.length === 0)) {
        if (data.breadcrumbs.length > 1) {
            const bcCat = data.breadcrumbs[data.breadcrumbs.length - 2]?.text;
            if (bcCat && bcCat.toLowerCase() !== 'anasayfa' && bcCat.toLowerCase() !== 'home') data.blogCategories = [bcCat];
        } else if (data.breadcrumbs.length === 1 && data.breadcrumbs[0]?.text && data.breadcrumbs[0]?.text.toLowerCase() !== 'anasayfa' && data.breadcrumbs[0]?.text.toLowerCase() !== 'home') {
            data.blogCategories = [data.breadcrumbs[0].text];
        }
    }
  }
  // Eğer hala kategori yoksa ve başlıkta ipucu varsa (product için)
  if (pageTypeGuess === 'product' && !data.category && data.title?.includes('|')) {
      const parts = data.title.split('|');
      if (parts.length > 1) data.category = parts[1]?.trim();
  }
  if (pageTypeGuess === 'category' && !data.category && data.title) {
      data.category = data.title;
  }


  const imageSelectors = (siteSelectors?.productImages || []).concat(GENERAL_SELECTORS.productImages || []);
  const extractedImages = extractImagesFromSelectors($, pageUrl, imageSelectors, 'article img, main img, .content img, figure img');
  
  let currentImages = data.images || [];
  currentImages = [...currentImages, ...extractedImages];

  if (data.ogImage && !currentImages.some(img => img.src === data.ogImage)) {
    currentImages.push({ src: data.ogImage, alt: 'OG Image', hasAlt: true, width: null, height: null });
  }
  
  const uniqueImageMap = new Map<string, ImageItem>();
  currentImages.forEach(img => { if(img?.src && !uniqueImageMap.has(img.src)) uniqueImageMap.set(img.src, img); }); 
  data.images = Array.from(uniqueImageMap.values());
  if (data.images.length === 0) data.images = null;

  if (!data.ogImage && data.images && data.images.length > 0) {
      const firstGoodImage = data.images.find(img => img.src && !/logo|icon|avatar|banner|placeholder|favicon|svg|spinner|loader|dummy|ads|1x1|pixel|feed|badge|rating|captcha|thumb|pattern|background|bg|spacer|shield|overlay/i.test(img.src) && (img.width ? parseInt(img.width) > 100 : true) && (img.height ? parseInt(img.height) > 100 : true));
      if (firstGoodImage) data.ogImage = firstGoodImage.src;
      else if (data.images[0]?.src) data.ogImage = data.images[0].src; // Fallback to first image if no "good" one
  }
  
  // Navigasyon ve Footer Linkleri
  data.navigationLinks = extractSpecificLinks($, (siteSelectors?.navigationLinksContainers || []).concat(GENERAL_SELECTORS.navigationLinksContainers || []), pageUrl) || null;
  data.footerLinks = extractSpecificLinks($, (siteSelectors?.footerLinksContainers || []).concat(GENERAL_SELECTORS.footerLinksContainers || []), pageUrl) || null;
  
  const linksData = extractPageLinks($, pageUrl);
  data.allLinks = linksData.allLinks.length > 0 ? linksData.allLinks : null;
  data.internalLinks = linksData.internalLinks.length > 0 ? linksData.internalLinks : null;
  data.externalLinks = linksData.externalLinks.length > 0 ? linksData.externalLinks : null;

  // --- 6. AI İçin Ana Metin ---
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
    // const childElements = element.children().length; // Bu satır kullanılmıyor gibi

    if (text.length < 100 && linksCount > 2 && (text.length / (linksCount + 1)) < 20) {
      element.remove();
    }
    // if (text.length === 0 && childElements === 0 && !element.is('img')) { // Bu da kullanılmıyor
    //     element.remove();
    // }
  });
  
  let mainText = $contentClone.find('main').text() || 
                 $contentClone.find('article').text() || 
                 $contentClone.find('.content, #content, #main, .entry-content').text() || // Daha genel içerik seçicileri
                 $contentClone.text(); 
  
  data.mainTextContent = sanitizeText(mainText)?.replace(/\s{2,}/g, ' ').slice(0, 15000) || "";
  data.rawHtmlLength = htmlContent.length;

  // Fallback meta description from main text (eğer hala yoksa)
  if (!data.metaDescription && data.mainTextContent && data.mainTextContent.length > 20) {
    data.metaDescription = data.mainTextContent.substring(0, 160).split('\n')[0].trim();
    if (data.metaDescription.length > 155) data.metaDescription = data.metaDescription.substring(0, data.metaDescription.lastIndexOf(' ') > 0 ? data.metaDescription.lastIndexOf(' ') : 155);
    if (data.mainTextContent.length > 160 && data.metaDescription.length < 160 && !data.metaDescription.endsWith('...')) data.metaDescription += '...';
  }
  // Fallback title from main text (eğer hala yoksa veya "Başlık Yok" ise)
  if ((!data.title || data.title === 'Başlık Yok') && data.mainTextContent && data.mainTextContent.length > 10) {
    data.title = data.mainTextContent.substring(0, 70).split('\n')[0].trim();
    if (data.title.length > 65) data.title = data.title.substring(0, data.title.lastIndexOf(' ') > 0 ? data.title.lastIndexOf(' ') : 65);
    if (data.mainTextContent.length > 70 && data.title.length < 70) data.title += '...';
  }

  return data;
}