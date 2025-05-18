// app/api/discover-site-selectors/route.ts
import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { geminiParentInstance } from '@/lib/ai'; // Gemini'yi import et
import { storeSiteSelectors, SelectorKey, SiteSpecificSelectors, URL_PATTERNS, SelectorConfigItem } from '@/lib/config'; // Added SelectorConfigItem
import { addLog, logError } from '@/lib/logger';
import { withCors } from '@/lib/cors';
import { URL as NodeURL } from 'url'; // For new NodeURL()
// Sitemap parser'ı import et
import { fetchAndParseSitemap } from '@/lib/scraper-utils';
// extractBaseDataFromHtml is not directly used in this file, but ScrapedPageData type is
// import { extractBaseDataFromHtml } from '@/lib/scraper-utils'; // Not strictly needed here for the fix

// --- YARDIMCI FONKSİYONLAR ---

// ScrapedPageData tipi (basitleştirilmiş)
type ScrapedPageData = {
    pageTypeGuess?: 'product' | 'blog' | 'category' | 'page' | 'unknown';
};

// Helper function for delays
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const AI_REQUEST_DELAY_DISCOVERY = 20000; // Seçici keşfi için AI çağrıları arası bekleme (ms) - Gemini için 4 RPM ise 15sn, güvenlik için 20sn

function sanitizeText(text: string | undefined | null): string | null {
  if (typeof text !== 'string') return null;
  return text.replace(/\s\s+/g, ' ').trim() || null;
}

const TARGET_SELECTOR_KEYS: { key: SelectorKey, description: string, expectedAttr?: string, multiple?: boolean, relevantPageTypes?: ScrapedPageData['pageTypeGuess'][] }[] = [
    { key: 'title', description: "ana başlık", multiple: false, relevantPageTypes: ['product', 'blog', 'page', 'category'] },
    { key: 'price', description: "ürün fiyatı", multiple: false, relevantPageTypes: ['product'] },
    { key: 'stockStatus', description: "stok durumu", multiple: false, relevantPageTypes: ['product'] },
    { key: 'productImages', description: "ana ürün görselleri (galeri veya büyük resim)", expectedAttr: 'src', multiple: true, relevantPageTypes: ['product'] },
    { key: 'description', description: "detaylı açıklama (ürün detayı, blog içeriği, sayfa içeriği)", multiple: false, relevantPageTypes: ['product', 'blog', 'page', 'category'] },
    { key: 'features', description: "ürün özellikleri (liste veya tablo)", multiple: true, relevantPageTypes: ['product'] },
    { key: 'productCategory', description: "ürünün ait olduğu kategori metni", multiple: false, relevantPageTypes: ['product'] },
    { key: 'publishDate', description: "blog yazısının yayın tarihi", multiple: false, relevantPageTypes: ['blog'] },
    { key: 'blogPageCategories', description: "blog yazısının kendi içindeki kategorileri/etiketleri", multiple: true, relevantPageTypes: ['blog'] },
    { key: 'navigationLinksContainers', description: "ana navigasyon menüsünü içeren HTML konteyneri", multiple: false, relevantPageTypes: ['product', 'blog', 'page', 'category'] },
    { key: 'footerLinksContainers', description: "footer linklerini içeren ana HTML konteyneri", multiple: false, relevantPageTypes: ['product', 'blog', 'page', 'category'] },
    { key: 'breadcrumbsContainers', description: "breadcrumb navigasyonunu içeren ana HTML konteyneri", multiple: false, relevantPageTypes: ['product', 'blog', 'page', 'category'] },
];

// ----- GEMINI KULLANACAK ŞEKİLDE GÜNCELLENDİ (askAiForSelectorCandidates)-----
// This function might be for a different purpose or a previous approach. It's not the one causing the error.
// We'll keep it as is for now.
async function askAiForSelectorCandidates(
    htmlExtract: string,
    elementTypeDesc: string,
    targetAttr?: string,
    findMultiple: boolean = false,
    requestId?: string // Loglama için
): Promise<string[]> {
    const prompt = `
        Aşağıdaki HTML parçasını analiz et.
        Bu HTML'den "${elementTypeDesc}" bilgisini çekmek için kullanılabilecek en olası ve güvenilir 1-3 adet CSS seçicisini bul.
        Seçiciler, sayfa yapısındaki değişikliklere karşı mümkün olduğunca dayanıklı olmalı (örn: ID yerine anlamlı class'lar, data attribute'ları, itemprop).
        Eğer bir attribute'dan veri alınacaksa (örn: bir resim için 'src' attribute'u), bunu belirt. Hedef attribute: ${targetAttr || 'textContent'}.
        Eğer birden fazla eleman bulunması bekleniyorsa (örn: özellik listesi), bunu dikkate al. Birden fazla eleman mı: ${findMultiple}.

        HTML ÖRNEĞİ (ilk 6000 karakter):
        \`\`\`html
        ${htmlExtract.substring(0, 6000)}
        \`\`\`

        ÇOK ÖNEMLİ: Yanıtın SADECE ve SADECE aşağıdaki formatta geçerli bir JSON nesnesi olmalı. Başka hiçbir metin, açıklama veya markdown (\`\`\`json) KULLANMA:
        {
          "selectors": ["css_selector_1", ".class_selector > child_tag", "#id_selector"]
        }
    `;
    try {
        const modelInstance = geminiParentInstance.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
        addLog('[AutoSelector] Sending request to Gemini for selector candidates...', {elementTypeDesc, requestId});
        const result = await modelInstance.generateContent(prompt);
        const response = result.response;
        const textContent = await response.text();
        addLog('[AutoSelector] Gemini response received.', {elementTypeDesc, preview: textContent.substring(0,100), requestId});

        const jsonMatch = textContent.match(/```json\s*([\s\S]*?)\s*```|({[\s\S]*})/);
        let parsedContent: any = null;

        if (jsonMatch && (jsonMatch[1] || jsonMatch[2])) {
            try {
                parsedContent = JSON.parse(jsonMatch[1] || jsonMatch[2]);
            } catch (e) {
                logError(e, '[AutoSelector] Gemini JSON block parsing failed', { elementTypeDesc, rawText: textContent.slice(0,500), requestId });
                return [];
            }
        } else {
            try {
                parsedContent = JSON.parse(textContent);
            } catch (e) {
                logError(new Error('Gemini response is not a JSON block and not direct JSON.'), '[AutoSelector] Gemini no valid JSON', { elementTypeDesc, preview: textContent.slice(0,500), requestId });
                return [];
            }
        }

        if (parsedContent && Array.isArray(parsedContent.selectors)) {
            return parsedContent.selectors.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
        } else {
            logError(new Error('Gemini response parsed, but "selectors" array not found or invalid.'), '[AutoSelector] Gemini invalid JSON structure', {elementTypeDesc, parsedContent, requestId});
            return [];
        }
    } catch (e: any) {
        logError(e, '[AutoSelector] AI API call failed for selector suggestion', { elementTypeDesc, errorMessage: e.message, stack: e.stack?.substring(0,500), requestId });
        if (e.message?.includes('429')) { 
            addLog(`[AutoSelector] Rate limit hit. Waiting for ${AI_REQUEST_DELAY_DISCOVERY * 2 / 1000}s before next AI call.`, {requestId, level: 'warn'});
            await delay(AI_REQUEST_DELAY_DISCOVERY * 2);
        }
        return [];
    }
}
// ----- GEMINI KULLANACAK ŞEKİLDE GÜNCELLENDİ (SON) -----

// +++ START OF ADDED/MODIFIED CODE +++

// Define the type for the expected AI response for a single selector object
interface AiSelectorCandidate {
    selector: string;
    attr?: string | null; // Attribute to extract, null or undefined for textContent
}

// Define the type for the overall AI response from askAiForAllTargetSelectors
// It maps a SelectorKey to an array of AiSelectorCandidate objects
type AiAllSelectorsResponse = Partial<Record<SelectorKey, AiSelectorCandidate[]>>;


/**
 * Asks the AI to propose CSS selectors for ALL target elements defined in TARGET_SELECTOR_KEYS
 * based on a sample HTML extract. This is designed to make a single, more complex AI call
 * for efficiency.
 */
async function askAiForAllTargetSelectors(
    htmlExtract: string,
    targets: typeof TARGET_SELECTOR_KEYS,
    requestId?: string
): Promise<AiAllSelectorsResponse> {
    const targetDescriptions = targets.map(target => {
        let desc = `- For key "${target.key}" ("${target.description}"):`;
        if (target.expectedAttr) {
            desc += ` Extract the '${target.expectedAttr}' attribute.`;
        } else {
            desc += ` Extract its text content.`;
        }
        if (target.multiple) {
            desc += ` Multiple elements are expected.`;
        } else {
            desc += ` A single element is expected.`;
        }
        if (target.relevantPageTypes && target.relevantPageTypes.length > 0) {
             desc += ` Most relevant for page types: ${target.relevantPageTypes.join(', ')}.`;
        }
        return desc;
    }).join('\n        '); // Indentation for readability in the prompt

    const prompt = `
        Analyze the following HTML content (first 10000 characters).
        Your task is to identify robust CSS selectors for extracting specific data points.
        For each data point listed below, provide 1 to 3 candidate CSS selectors.
        Selectors should be resilient to minor HTML structure changes (e.g., prefer classes, data attributes, itemprop over brittle IDs or positional selectors if possible).

        Data points to find selectors for:
        ${targetDescriptions}

        HTML CONTENT (first 10000 characters):
        \`\`\`html
        ${htmlExtract.substring(0, 10000)}
        \`\`\`

        VERY IMPORTANT:
        Your response MUST be a SINGLE, VALID JSON object. Do NOT include any text, explanations, or markdown like \`\`\`json before or after the JSON object.
        The JSON object should have keys corresponding to the "key" values from the list above (e.g., "title", "price", "productImages").
        Each key's value should be an array of objects. Each object in the array must have:
        1. A "selector" property (string): The CSS selector.
        2. An optional "attr" property (string or null): The attribute to extract (e.g., "src", "href"). If extracting text content, set this to null or omit the "attr" property entirely.

        Example of the EXACT JSON output format:
        {
          "title": [
            { "selector": "h1.product-title" }, // attr omitted for textContent
            { "selector": ".page-heading > span", "attr": null } // attr: null for textContent
          ],
          "price": [
            { "selector": ".price-value" }
          ],
          "productImages": [
            { "selector": ".product-gallery img.main", "attr": "src" },
            { "selector": "div[data-main-image] > img", "attr": "data-src" }
          ]
          // ... and so on for all requested keys
        }
    `;

    try {
        const modelInstance = geminiParentInstance.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
        addLog('[AutoSelector] Sending request to Gemini for ALL target selectors...', { numTargets: targets.length, requestId });
        
        const result = await modelInstance.generateContent(prompt);
        const response = result.response;
        const textContent = await response.text();
        addLog('[AutoSelector] Gemini response received for ALL target selectors.', { preview: textContent.substring(0, 150), requestId });

        let parsedContent: any = null;
        const jsonMatch = textContent.match(/```json\s*([\s\S]*?)\s*```|({[\s\S]*})/);

        if (jsonMatch && (jsonMatch[1] || jsonMatch[2])) {
            try {
                parsedContent = JSON.parse(jsonMatch[1] || jsonMatch[2]);
            } catch (e) {
                logError(e, '[AutoSelector] Gemini (all targets) JSON block parsing failed', { rawText: textContent.slice(0, 500), requestId });
                return {}; 
            }
        } else {
            try {
                parsedContent = JSON.parse(textContent); 
            } catch (e) {
                 logError(new Error('Gemini (all targets) response is not a JSON block and not direct JSON.'), '[AutoSelector] Gemini (all targets) no valid JSON', { preview: textContent.slice(0,500), requestId });
                return {}; 
            }
        }
        
        if (parsedContent && typeof parsedContent === 'object' && !Array.isArray(parsedContent)) {
            const validatedSelectors: AiAllSelectorsResponse = {};
            let foundValidKeys = 0;
            for (const target of targets) {
                const key = target.key;
                if (parsedContent.hasOwnProperty(key) && Array.isArray(parsedContent[key])) {
                    const candidates: AiSelectorCandidate[] = [];
                    for (const cand of parsedContent[key]) {
                        if (cand && typeof cand.selector === 'string' && cand.selector.trim() !== '') {
                            candidates.push({
                                selector: cand.selector.trim(),
                                attr: (typeof cand.attr === 'string' && cand.attr.trim() !== '') ? cand.attr.trim() : undefined
                            });
                        } else {
                            addLog(`[AutoSelector] Invalid candidate structure for key ${key}: ${JSON.stringify(cand)}`, {requestId, level: 'debug'});
                        }
                    }
                    if (candidates.length > 0) {
                        validatedSelectors[key] = candidates;
                        foundValidKeys++;
                    } else {
                         addLog(`[AutoSelector] No valid candidates found for key ${key} in AI response, though key was present.`, {requestId, level: 'debug'});
                    }
                } else {
                    addLog(`[AutoSelector] Gemini response missing or has invalid format for target key: ${key}`, {requestId, level: 'debug'});
                }
            }

            if (foundValidKeys > 0) {
                 addLog(`[AutoSelector] Gemini successfully provided valid selectors for ${foundValidKeys}/${targets.length} keys.`, {requestId, foundKeys: Object.keys(validatedSelectors)});
                return validatedSelectors;
            } else {
                logError(new Error('Gemini response parsed, but no valid target keys or selectors found.'), '[AutoSelector] Gemini (all targets) invalid JSON structure or empty/invalid selectors', {parsedContentPreview: JSON.stringify(parsedContent).substring(0,300), requestId});
                return {};
            }
        } else {
            logError(new Error('Gemini response parsed, but not a valid object for selectors.'), '[AutoSelector] Gemini (all targets) parsed content not an object', {parsedContentPreview: JSON.stringify(parsedContent).substring(0,300), requestId});
            return {};
        }

    } catch (e: any) {
        logError(e, '[AutoSelector] AI API call failed for ALL target selectors suggestion', { errorMessage: e.message, stack: e.stack?.substring(0,500), requestId });
        if (e.message?.includes('429')) { 
            addLog(`[AutoSelector] Rate limit hit (all targets). Waiting for ${AI_REQUEST_DELAY_DISCOVERY * 2 / 1000}s.`, {requestId, level: 'warn'});
            await delay(AI_REQUEST_DELAY_DISCOVERY * 2); 
        }
        return {}; 
    }
}

// +++ END OF ADDED/MODIFIED CODE +++


// Aday seçicileri test etme fonksiyonu (orijinal dosyadan alındı ve sanitizeText kullanıyor)
function testSelectors(
    $: cheerio.CheerioAPI,
    selectors: string[],
    targetAttr?: string,
    expectMultiple: boolean = false
): { selector: string, score: number, foundCount: number, sampleValue?: string }[] {
    const scoredSelectors: { selector: string, score: number, foundCount: number, sampleValue?: string }[] = [];
    selectors.forEach(selector => {
        try {
            const elements = $(selector);
            let score = 0;
            let sampleValue = "";
            if (elements.length > 0) {
                score += 5; // Bulundu
                if (expectMultiple && elements.length > 1) score += 3; // Birden fazla bekleniyordu ve bulundu
                if (!expectMultiple && elements.length === 1) score += 3; // Tek bekleniyordu ve tek bulundu

                const firstEl = elements.first();
                const val = targetAttr ? firstEl.attr(targetAttr) : firstEl.text();
                const sanitizedVal = sanitizeText(val);
                if (sanitizedVal) {
                    score += 2;
                    sampleValue = sanitizedVal.substring(0, 50);
                }
                scoredSelectors.push({ selector, score, foundCount: elements.length, sampleValue });
            } else {
                scoredSelectors.push({ selector, score: 0, foundCount: 0 });
            }
        } catch (e) {
            // console.warn(`Invalid selector for testing: ${selector}`);
            scoredSelectors.push({ selector, score: 0, foundCount: 0 });
        }
    });
    return scoredSelectors.sort((a, b) => b.score - a.score); // En yüksek skorlu başa
}

// Sayfa türünü URL ve basit HTML ipuçlarından tahmin etme (AI'a sormadan önce)
function quickPageTypeGuess(pageUrl: string, $: cheerio.CheerioAPI): NonNullable<ScrapedPageData['pageTypeGuess']> {
    const url = new NodeURL(pageUrl);
    const path = url.pathname.toLowerCase();
    const search = url.search.toLowerCase();

    // Check for common patterns from config
    if (URL_PATTERNS.product && URL_PATTERNS.product.some(p => path.includes(p) || search.includes(p))) return 'product';
    if (URL_PATTERNS.blog && URL_PATTERNS.blog.some(p => path.includes(p) || search.includes(p))) return 'blog';
    if (URL_PATTERNS.category && URL_PATTERNS.category.some(p => path.includes(p) || search.includes(p))) return 'category';
    if (path === '/' || (URL_PATTERNS.staticPageKeywords && URL_PATTERNS.staticPageKeywords.some(k => path.includes(k)))) return 'page';

    // Basit içerik ipuçları
    if ($('[itemprop="price"]').length > 0 || $('form[action*="cart"]').length > 0 || $('[class*="product-detail"]').length > 0 || $('[id*="product-detail"]').length > 0) return 'product';
    if ($('article.post').length > 0 || $('[itemtype*="BlogPosting"]').length > 0 || $('[class*="blog-post"]').length > 0) return 'blog';
    if (($('[class*="product-list"]').length > 0 || $('[class*="category-page"]').length > 0) && $('[class*="product-item"]').length > 2) return 'category';
    if ($('.pagination').length > 0 && ($('[class*="product-item"]').length > 2 || $('[class*="post-item"]').length > 2)) return 'category'; // More generic for paginated lists

    return 'unknown';
}


export const POST = withCors(async function POST(req: NextRequest) {
    const requestId = Math.random().toString(36).substring(2, 10);
    const { siteUrl } = await req.json();

    if (!siteUrl) {
        return NextResponse.json({ error: 'siteUrl gereklidir' }, { status: 400 });
    }
    addLog(`[AutoSelector] Starting for: ${siteUrl}`, {requestId});

    let siteHostname = '';
    try { siteHostname = new NodeURL(siteUrl).hostname; }
    catch (e) { return NextResponse.json({ error: 'Geçersiz siteUrl' }, { status: 400 }); }

    const finalDiscoveredSelectors: SiteSpecificSelectors = {}; 
    const samplePageUrls = new Set<string>();
    samplePageUrls.add(siteUrl);

    const MAX_SAMPLE_PAGES_FOR_DISCOVERY = 3; 

    try {
        const sitemapUrls = await fetchAndParseSitemap(siteUrl);
        if (sitemapUrls && sitemapUrls.length > 0) {
            const productSamples = URL_PATTERNS.product ? sitemapUrls.filter(u => URL_PATTERNS.product!.some(p => u.includes(p))).slice(0, MAX_SAMPLE_PAGES_FOR_DISCOVERY) : [];
            const blogSamples = URL_PATTERNS.blog ? sitemapUrls.filter(u => URL_PATTERNS.blog!.some(p => u.includes(p))).slice(0, MAX_SAMPLE_PAGES_FOR_DISCOVERY) : [];
            const categorySamples = URL_PATTERNS.category ? sitemapUrls.filter(u => URL_PATTERNS.category!.some(p => u.includes(p))).slice(0, MAX_SAMPLE_PAGES_FOR_DISCOVERY) : [];
            
            productSamples.forEach(u => samplePageUrls.add(u));
            blogSamples.forEach(u => samplePageUrls.add(u));
            categorySamples.forEach(u => samplePageUrls.add(u));
            
            let i = 0;
            while(samplePageUrls.size < MAX_SAMPLE_PAGES_FOR_DISCOVERY && i < sitemapUrls.length) {
                if (!Array.from(samplePageUrls).includes(sitemapUrls[i])) {
                    samplePageUrls.add(sitemapUrls[i]);
                }
                i++;
            }
        }
    } catch (e: any) {
        addLog(`[AutoSelector] Error fetching/parsing sitemap for ${siteUrl}: ${e.message}. Using homepage only.`, {requestId, level: 'warn'});
    }
    if (samplePageUrls.size === 0) samplePageUrls.add(siteUrl);

    const htmlSamples: {url: string, html: string, typeGuess: NonNullable<ScrapedPageData['pageTypeGuess']>}[] = [];
    for (const sampleUrl of Array.from(samplePageUrls).slice(0, MAX_SAMPLE_PAGES_FOR_DISCOVERY)) {
        try {
            addLog(`[AutoSelector] Fetching sample: ${sampleUrl}`, {requestId});
            const response = await axios.get(sampleUrl, { 
                timeout: 12000, 
                headers: {
                    'User-Agent': 'SelectorDiscoveryBot/1.0 Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5'
                } 
            });
            if (response.data && typeof response.data === 'string') {
                const $ = cheerio.load(response.data);
                const typeGuess = quickPageTypeGuess(sampleUrl, $);
                htmlSamples.push({ url: sampleUrl, html: response.data, typeGuess });
                addLog(`[AutoSelector] Sample ${sampleUrl} fetched. Type guess: ${typeGuess}`, {requestId});
            }
        } catch (e:any) { addLog(`[AutoSelector] Failed to fetch sample ${sampleUrl}: ${e.message}`, {requestId, level: 'warn'}); }
    }

    if (htmlSamples.length === 0) {
        addLog(`[AutoSelector] No HTML samples could be fetched for ${siteUrl}. Aborting.`, {requestId, level: 'error'});
        return NextResponse.json({ error: 'Örnek sayfalar çekilemedi, seçici tespiti yapılamıyor.' }, { status: 500 });
    }
    addLog(`[AutoSelector] Fetched ${htmlSamples.length} HTML samples. Starting AI query for all targets...`, {requestId});

    let representativeSampleHtml: string | null = null;
    let representativeSampleUrl = "";

    const productSample = htmlSamples.find(s => s.typeGuess === 'product');
    const blogSample = htmlSamples.find(s => s.typeGuess === 'blog' && s !== productSample);
    const categorySample = htmlSamples.find(s => s.typeGuess === 'category' && s !== productSample && s !== blogSample);

    if (productSample) {
        representativeSampleHtml = productSample.html;
        representativeSampleUrl = productSample.url;
    } else if (blogSample) {
        representativeSampleHtml = blogSample.html;
        representativeSampleUrl = blogSample.url;
    } else if (categorySample) {
        representativeSampleHtml = categorySample.html;
        representativeSampleUrl = categorySample.url;
    } else {
        representativeSampleHtml = htmlSamples[0].html;
        representativeSampleUrl = htmlSamples[0].url;
    }
    addLog(`[AutoSelector] Selected representative sample for AI: ${representativeSampleUrl}`, {requestId});

    // This is the line that caused the error. Now askAiForAllTargetSelectors is defined.
    const initialAiSelectors: AiAllSelectorsResponse = await askAiForAllTargetSelectors(representativeSampleHtml, TARGET_SELECTOR_KEYS, requestId);
    addLog(`[AutoSelector] AI proposed initial selectors for ${Object.keys(initialAiSelectors).length} keys based on ${representativeSampleUrl}.`, {requestId, keys: Object.keys(initialAiSelectors)});

    for (const target of TARGET_SELECTOR_KEYS) {
        const aiCandidatesForTarget = initialAiSelectors[target.key];

        if (!aiCandidatesForTarget || aiCandidatesForTarget.length === 0) {
            addLog(`[AutoSelector] No AI candidates from initial call for ${target.key}.`, {requestId, level: 'info'});
            continue;
        }

        let bestSelectorDetails: { selector: string, score: number, attr?: string, foundInSamplesCount: number, totalSamplesConsidered: number } | null = null;

        for (const candidate of aiCandidatesForTarget) { // candidate is AiSelectorCandidate {selector: string, attr?: string}
            let cumulativeScore = 0;
            let foundInRelevantSamplesCount = 0;

            const relevantSamples = htmlSamples.filter(s =>
                !target.relevantPageTypes || target.relevantPageTypes.length === 0 ||
                target.relevantPageTypes.includes(s.typeGuess) || s.typeGuess === 'unknown'
            );
            
            const samplesToScoreAgainst = relevantSamples.length > 0 ? relevantSamples : htmlSamples;

            if (samplesToScoreAgainst.length === 0) { 
                 addLog(`[AutoSelector] No samples to score against for target ${target.key}, candidate ${candidate.selector}. Skipping candidate.`, {requestId, level:'warn'});
                 continue;
            }

            for (const sample of samplesToScoreAgainst) {
                const $sampleCheerio = cheerio.load(sample.html);
                const testResult = testSelectors(
                    $sampleCheerio,
                    [candidate.selector],
                    candidate.attr || undefined, // Pass AI suggested attribute, or undefined for textContent
                    target.multiple
                );
                if (testResult[0]) {
                    cumulativeScore += testResult[0].score;
                    if (testResult[0].foundCount > 0) {
                        foundInRelevantSamplesCount++;
                    }
                }
            }

            if (samplesToScoreAgainst.length > 0) {
                const averageScorePerSample = cumulativeScore / samplesToScoreAgainst.length;
                const foundRatio = foundInRelevantSamplesCount / samplesToScoreAgainst.length;
                const finalCandidateScore = averageScorePerSample * (foundRatio > 0 ? Math.pow(foundRatio, 0.5) : 0.01);


                if (!bestSelectorDetails || finalCandidateScore > bestSelectorDetails.score) {
                    bestSelectorDetails = {
                        selector: candidate.selector,
                        score: finalCandidateScore,
                        attr: candidate.attr || undefined, // Store the attr from AI candidate
                        foundInSamplesCount: foundInRelevantSamplesCount,
                        totalSamplesConsidered: samplesToScoreAgainst.length
                    };
                }
            }
        }

        const scoreThreshold = 3.0;
        if (bestSelectorDetails && bestSelectorDetails.score > scoreThreshold) {
            addLog(`[AutoSelector] Best for ${target.key} on ${siteHostname}: ${bestSelectorDetails.selector}` +
                   `${bestSelectorDetails.attr ? ` (attr: ${bestSelectorDetails.attr})` : ''}` +
                   ` (Score: ${bestSelectorDetails.score.toFixed(2)}, Found in ${bestSelectorDetails.foundInSamplesCount}/${bestSelectorDetails.totalSamplesConsidered} samples)`, {requestId});
            
            const selectorConfig: SelectorConfigItem = { selector: bestSelectorDetails.selector };
            if (bestSelectorDetails.attr) {
                selectorConfig.attr = bestSelectorDetails.attr;
            }
            finalDiscoveredSelectors[target.key as SelectorKey] = [selectorConfig];

        } else {
            addLog(`[AutoSelector] No reliable selector found for ${target.key} after testing AI candidates (best score: ${bestSelectorDetails?.score.toFixed(2)}).`, {requestId, level: 'warn'});
        }
    }

    if (Object.keys(finalDiscoveredSelectors).length > 0) {
        await storeSiteSelectors(siteHostname, finalDiscoveredSelectors);
        addLog(`[AutoSelector] Successfully discovered and stored selectors for ${siteHostname}`, {requestId, discoveredCount: Object.keys(finalDiscoveredSelectors).length});
        return NextResponse.json({
            message: `Seçiciler ${siteHostname} için tespit edildi ve kaydedildi.`,
            hostname: siteHostname,
            selectors: finalDiscoveredSelectors
        });
    } else {
        logError(new Error("No selectors discovered by AI and subsequent testing."), '[AutoSelector] No selectors discovered', {requestId, siteUrl, siteHostname});
        return NextResponse.json({
            message: `Otomatik seçici bulunamadı: ${siteHostname}. Genel seçiciler kullanılacak veya manuel giriş gerekebilir.`,
            hostname: siteHostname,
            selectors: {}
        }, { status: 200 }); // Status 200 as it's not a server error, but a "not found" result
    }
});