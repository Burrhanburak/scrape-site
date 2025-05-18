// app/api/scrape-ai/route.ts

import { NextRequest, NextResponse } from 'next/server';
import axios, { AxiosError } from 'axios'; // AxiosError eklendi
import { openai, geminiParentInstance, defaultSafetySettings } from '@/lib/ai';
import { addLog, logError } from '@/lib/logger';
import { withCors } from '@/lib/cors';
import { extractBaseDataFromHtml, ScrapedPageData, ImageItem, LinkItem } from '@/lib/scraper-utils'; // LinkItem eklendi
import { getSiteSpecificSelectors, storeSiteSelectors } from '@/lib/config';
import { URL as NodeURL } from 'url';
import { Browser } from 'playwright-core';

async function callAI(prompt: string, modelPreference: 'gemini' | 'openai' | string, requestId: string, url: string) {
  let aiResponseJson: any = null;
  const actualModel = modelPreference === 'gemini' ? 'gemini' : (modelPreference === 'openai' ? 'openai' : 'gemini');
  addLog(`Using AI model: ${actualModel} for URL: ${url}`, { context: 'ai-call', data: { requestId, model: actualModel } });

  try {
    if (actualModel === 'gemini') {
      const modelInstance = geminiParentInstance.getGenerativeModel({
        model: "gemini-1.5-flash-latest",
      });
      const result = await modelInstance.generateContent(prompt);
      const response = result.response;
      const textContent = await response.text();
      const jsonMatch = textContent.match(/```json\s*([\s\S]*?)\s*```|({[\s\S]*})/);
      if (jsonMatch && (jsonMatch[1] || jsonMatch[2])) {
        try {
            aiResponseJson = JSON.parse(jsonMatch[1] || jsonMatch[2]);
        } catch (parseError: any) {
            logError(parseError, 'ai-call-gemini-json-parse-error', { data: { requestId, url, rawText: textContent.slice(0,500) } });
            aiResponseJson = { detectedPageType: 'unknown', error: 'Gemini response JSON parsing failed.', partialResponse: textContent.slice(0, 500) };
        }
      } else {
        logError(new Error('No JSON block found in Gemini response'), 'ai-call-gemini-no-json-block', { data: { requestId, url, preview: textContent.slice(0, 500) } });
        aiResponseJson = { detectedPageType: 'unknown', error: 'Gemini response did not contain a recognizable JSON block.', partialResponse: textContent.slice(0, 500) };
      }
    } else { 
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini', 
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        response_format: { type: "json_object" },
      });
      const content = completion.choices[0].message.content;
      if (content) {
        try {
          aiResponseJson = JSON.parse(content);
        } catch (e) {
          logError(e as Error, 'ai-call-openai-json', { data: { requestId, url, rawResponse: content.slice(0,500) } });
          aiResponseJson = { detectedPageType: 'unknown', error: 'OpenAI response JSON parsing failed despite JSON mode.', rawContent: content.slice(0,500) };
        }
      } else {
        aiResponseJson = { detectedPageType: 'unknown', error: 'OpenAI response was empty.' };
      }
    }
  } catch (err: any) {
    logError(err, `ai-call-${actualModel}-api-error`, { data: { requestId, url, message: err.message, stack: err.stack?.substring(0, 1000) } });
    aiResponseJson = { detectedPageType: 'unknown', error: `AI API Error (${actualModel}): ${err.message}` };
  }
  return aiResponseJson;
}

function mapCurrencySymbolToCode(symbol?: string | null): string | null {
  if (!symbol) return null;
  const map: Record<string, string> = {
    '₺': 'TRY', '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₽': 'RUB', '₩': 'KRW', 'TL': 'TRY',
    'eur': 'EUR', 'usd': 'USD', 'gbp': 'GBP', 'try': 'TRY', 'cad': 'CAD', 'aud': 'AUD',
  };
  const trimmedSymbol = symbol.trim().toLowerCase();
  for (const key in map) {
    if (trimmedSymbol.includes(key.toLowerCase())) {
        return map[key];
    }
  }
  if (trimmedSymbol.length === 3 && /^[a-z]+$/.test(trimmedSymbol)) {
    return trimmedSymbol.toUpperCase();
  }
  return null;
}

function resolveUrlHelper(url: string | undefined | null, baseUrl: string): string | null {
  if (!url) return null;
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol) return url;
  } catch (_) {
    // relative URL
  }
  try {
    const base = new URL(baseUrl);
    if (url.startsWith('//')) return base.protocol + url;
    return new URL(url, base).toString();
  } catch (e) {
    return null;
  }
}
async function runAutoSelectorDiscoveryIfNeeded(siteUrl: string, hostname: string, requestId: string): Promise<void> {
  addLog(`[API] Auto-selector discovery check for ${hostname}`, { context: 'auto-selector', data: { requestId, siteUrl } });
  try {
    const existingSelectors = await getSiteSpecificSelectors(hostname);
    if (!existingSelectors || Object.keys(existingSelectors).length < 5) {
      addLog(`[API] Triggering auto-selector discovery for ${hostname} as few/no selectors found. (Placeholder - actual discovery logic needed)`, { context: 'auto-selector', data: { requestId, hostname } });
      // Gerçek discover-site-selectors çağrısı burada olmalı (eğer frontend'den ayrıca çağrılmıyorsa)
    } else {
      addLog(`[API] Sufficient selectors likely exist for ${hostname}. Skipping auto-discovery.`, { context: 'auto-selector', data: { requestId, hostname } });
    }
  } catch (e: any) {
    logError(e, 'auto-selector-discovery-error', { context: 'auto-selector', data: { hostname, requestId, message: e.message } });
  }
}

function safeParseFloat(value: string | undefined | null): number | null {
    if (value === null || value === undefined || typeof value !== 'string') {
        return null;
    }
    const cleanedValue = value.replace(',', '.').replace(/[^\d.-]/g, '');
    const num = parseFloat(cleanedValue);
    return isNaN(num) ? null : num;
}


export const POST = withCors(async function POST(req: NextRequest) {
  const requestId = Math.random().toString(36).substring(2, 10);
  let playwrightBrowser: Browser | null = null;
  let operationStage = 'init';
  let requestUrlForError = 'unknown_url'; // Hata durumunda URL'yi loglamak için

  try {
    operationStage = 'loading-playwright-modules';
    let browserModule;
    let playwrightInstance;

    if (process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL_ENV === 'production') {
        addLog('[API] Loading playwright-aws-lambda for Vercel/Lambda environment.', { context: 'scrape-ai-post-setup', data: { requestId } });
        browserModule = await import('playwright-aws-lambda');
        playwrightInstance = browserModule.chromium;
    } else {
        addLog('[API] Loading playwright for local environment.', { context: 'scrape-ai-post-setup', data: { requestId } });
        browserModule = await import('playwright');
        playwrightInstance = browserModule.chromium;
    }

    operationStage = 'parsing-request-json';
    const {
      url,
      model: preferredAiModel = 'gemini',
      useHeadlessOverride = false,
      autoDiscoverSelectors = false
    } = await req.json();
    requestUrlForError = url || 'unknown_url_from_request';


    if (!url) {
      addLog('[API] Missing URL parameter', { level: 'error', context: 'scrape-ai-post', data: { requestId } });
      return NextResponse.json({ error: 'URL gerekli', pageTypeGuess: 'client_error', aiDetectedType: 'client_error', url: requestUrlForError }, { status: 400 });
    }
    addLog(`[API] Processing URL: ${url}`, { context: 'scrape-ai-post', data: { requestId, url, model: preferredAiModel, useHeadlessOverride, autoDiscoverSelectors } });

    operationStage = 'hostname-extraction';
    const siteHostname = new NodeURL(url).hostname;

    if (autoDiscoverSelectors && siteHostname) {
      operationStage = 'auto-selector-discovery';
      await runAutoSelectorDiscoveryIfNeeded(url, siteHostname, requestId);
    }

    let htmlContent: string | null = null;
    let fetchMethod = 'axios_pending';
    let axiosFetchError: string | null = null;

    operationStage = 'axios-fetch-attempt';
    try {
      addLog(`[API] Attempting Axios fetch for ${url}`, {context: 'axios-fetch', data: {requestId}});
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 SIT-Scraper/1.2', // Güncel bir UA
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
          'Referer': `https://${siteHostname}/` // Referer eklemek önemli olabilir
         },
        timeout: 15000,
      });
      if (response.data && typeof response.data === 'string' && response.data.trim().length > 0 && response.status === 200) {
          htmlContent = response.data;
          fetchMethod = 'axios_success';
          addLog(`[API] Axios fetch successful for ${url}. Status: ${response.status}, HTML length: ${htmlContent.length}`, {context: 'axios-fetch', data: {requestId, status: response.status}});
      } else {
          axiosFetchError = `Axios returned status ${response.status || 'N/A'} or empty/invalid data. Length: ${response.data?.length || 0}`;
          addLog(`[API] Axios fetch for ${url} problematic. ${axiosFetchError}`, {context: 'axios-fetch', data: {requestId, status: response.status}, level: 'warn'});
          fetchMethod = 'axios_failed_empty_or_bad_status';
      }
    } catch (error: any) {
      const err = error as AxiosError; // Tip ataması
      axiosFetchError = err.message;
      if (err.response) {
        axiosFetchError += ` (Status: ${err.response.status})`;
        const errorResponseDataPreview = err.response.data ? (typeof err.response.data === 'string' ? err.response.data.substring(0,200) : JSON.stringify(err.response.data).substring(0,200)) : 'N/A';
        addLog(`[API] Axios error response data preview: ${errorResponseDataPreview}`, {context: 'axios-fetch-error-debug', data: {requestId}});
      }
      logError(err, 'axios-fetch-error', {context: 'axios-fetch', data: {requestId, url, message: axiosFetchError}});
      addLog(`[API] Axios fetch FAILED for ${url}. Error: ${axiosFetchError}`, {context: 'axios-fetch', data: {requestId}, level:'warn'});
      fetchMethod = 'axios_failed_exception';
    }

    operationStage = 'initial-cheerio-parse';
    let baseData: Partial<ScrapedPageData> = { url, error: axiosFetchError, message: axiosFetchError ? axiosFetchError.substring(0,150) : null };
    if (htmlContent) {
        baseData = await extractBaseDataFromHtml(htmlContent, url); // Artık async
        baseData.url = url; // extractBaseDataFromHtml'in url'yi koruduğundan emin olalım
    } else {
        baseData.pageTypeGuess = 'error';
        baseData.message = axiosFetchError || 'No HTML content from Axios.';
        addLog(`[API] No HTML from Axios for Cheerio analysis of ${url}. Error: ${baseData.message}`, {context: 'cheerio-parse', data: {requestId}, level: 'warn'});
    }

    operationStage = 'headless-decision';
    let useEffectiveHeadless = useHeadlessOverride;
    const cheerioContentLength = baseData.mainTextContent?.length || 0;
    const cheerioFoundTitle = !!baseData.title && baseData.title !== 'Başlık Yok' && baseData.title.trim() !== '' && !baseData.title.startsWith(url);
    const cheerioFoundPriceForProduct = baseData.pageTypeGuess === 'product' && !!baseData.price && parseFloat(String(baseData.price).replace(/[^0-9.,]/g, '').replace(',', '.')) > 0;

    if (!useEffectiveHeadless) {
      if (fetchMethod.startsWith('axios_failed')) {
          addLog(`[API] Axios failed, attempting Headless for ${url} as a fallback.`, {context: 'headless-decision', data: {requestId}});
          useEffectiveHeadless = true;
      } else if (htmlContent) {
          if (!baseData.title || baseData.title === "Başlık Yok" || baseData.title === url || cheerioContentLength < 300) {
              addLog(`[API] Cheerio found generic title or very little content (${cheerioContentLength} chars, Title: "${baseData.title}") for ${url}. Will try Headless.`, {context: 'headless-decision', data: {requestId, pageType: baseData.pageTypeGuess}});
              useEffectiveHeadless = true;
          } else if (baseData.pageTypeGuess === 'product' && (!cheerioFoundTitle || !cheerioFoundPriceForProduct)) {
              addLog(`[API] Cheerio missed essential product data (title: ${cheerioFoundTitle}, price: ${cheerioFoundPriceForProduct}) for ${url}. Will try Headless.`, {context: 'headless-decision', data: {requestId}});
              useEffectiveHeadless = true;
          } else if (baseData.pageTypeGuess === 'unknown' && cheerioContentLength < 800) {
               addLog(`[API] Cheerio guessed 'unknown' with little content (${cheerioContentLength} chars) for ${url}. Will try Headless.`, {context: 'headless-decision', data: {requestId}});
              useEffectiveHeadless = true;
          }
      } else if (!htmlContent) {
          addLog(`[API] No HTML content from Axios, MUST attempt Headless for ${url}.`, {context: 'headless-decision', data: {requestId}});
          useEffectiveHeadless = true;
      }
    }

    let headlessErrorDetail: string | null = null;
    if (useEffectiveHeadless) {
      operationStage = 'headless-fetch-attempt';
      try {
        addLog(`[Headless] Launching browser for: ${url}`, {context: 'headless-fetch', data: {requestId}});
        playwrightBrowser = await playwrightInstance.launch({ headless: true });
        
        if (!playwrightBrowser) { throw new Error('Failed to launch Playwright browser instance.'); }

        const context = await playwrightBrowser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 SIT-Scraper-Playwright/1.2',
            javaScriptEnabled: true,
            ignoreHTTPSErrors: true,
            viewport: { width: 1366, height: 768 }
        });
        const page = await context.newPage();
        
        await page.route('**/*', (route, request) => {
            const resourceType = request.resourceType();
            const requestUrl = request.url().toLowerCase();
            if (['image', 'stylesheet', 'font', 'media', 'other'].includes(resourceType) &&
                !requestUrl.includes('sitemap') && // sitemap.xml gibi dosyaları engelleme
                !requestUrl.endsWith('.js') && // JS dosyalarını engelleme (render için önemli olabilir)
                !requestUrl.includes('json') // API çağrılarını engelleme
            ) {
                 route.abort();
            } else {
                 route.continue();
            }
        });
        
        addLog(`[Headless] Navigating to ${url}`, {context: 'headless-fetch', data: {requestId}});
        const pwResponse = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
        
        if (!pwResponse) { throw new Error('Playwright page.goto returned null response.'); }
        addLog(`[Headless] Navigation response status: ${pwResponse.status()} for ${url}`, {context: 'headless-fetch', data: {requestId}});

        if (pwResponse.status() !== 200) {
            const bodyForError = await page.content();
            addLog(`[Headless] Non-200 HTML Preview (first 300 chars): ${bodyForError.substring(0,300)}`, {context: 'headless-fetch-error-debug', data: {requestId}});
            throw new Error(`Playwright navigation failed with status: ${pwResponse.status()}`);
        }

        await page.waitForTimeout(2500 + Math.random() * 2000);

        const newHtmlContent = await page.content();
        addLog(`[Headless] Playwright HTML Preview (first 300 chars): ${newHtmlContent.substring(0,300)}`, {context: 'headless-fetch-debug', data: {requestId}});

        if (newHtmlContent && (newHtmlContent.length > (htmlContent?.length || 0) + 200 || !htmlContent) ) {
          htmlContent = newHtmlContent;
          baseData = await extractBaseDataFromHtml(htmlContent, url);
          baseData.url = url; // Tekrar ata
          fetchMethod = 'headless_success_reparsed';
          baseData.error = null; 
          baseData.message = null;
          addLog(`[Headless] Successfully fetched and reparsed with Headless for ${url}. New HTML length: ${htmlContent.length}`, {context: 'headless-fetch', data: {requestId}});
        } else {
          fetchMethod = htmlContent ? 'headless_no_significant_change' : 'headless_empty_content';
          addLog(`[Headless] Fetched with Headless for ${url}, but content not significantly changed or still short. Headless length: ${newHtmlContent?.length || 0}. Using previous Cheerio parse.`, {context: 'headless-fetch', data: {requestId}, level:'info'});
        }
      } catch (headlessError: any) {
        headlessErrorDetail = headlessError.message;
        logError(headlessError, 'headless-browser-error', {context: 'headless-fetch', data: {requestId, url, message: headlessErrorDetail}});
        addLog(`[Headless] Browser fetch/parse FAILED for ${url}. Error: ${headlessErrorDetail}. Using previous data (if any).`, {context: 'headless-fetch', data: {requestId}, level:'error'});
        fetchMethod = 'headless_failed';
        if (!baseData.error) { 
            baseData.error = `Headless fetch failed: ${headlessErrorDetail}`;
            baseData.message = `Headless: ${headlessErrorDetail.substring(0,120)}`;
            baseData.pageTypeGuess = 'error';
        }
      } finally {
        operationStage = 'headless-closing';
        if (playwrightBrowser) {
          await playwrightBrowser.close();
          playwrightBrowser = null;
          addLog('[Headless] Browser closed for ' + url, {context: 'headless-fetch', data: {requestId}});
        }
      }
    }
    
    operationStage = 'final-data-assembly';
    if (!baseData.url) baseData.url = url;

    let finalData: ScrapedPageData = {
        url: baseData.url || url,
        pageTypeGuess: baseData.pageTypeGuess || (baseData.error ? 'error' : 'unknown'),
        title: baseData.title,
        metaDescription: baseData.metaDescription,
        keywords: baseData.keywords,
        ogType: baseData.ogType,
        ogTitle: baseData.ogTitle,
        ogDescription: baseData.ogDescription,
        ogImage: baseData.ogImage,
        mainTextContent: baseData.mainTextContent,
        headings: baseData.headings,
        images: baseData.images || [],
        allLinks: baseData.allLinks,
        internalLinks: baseData.internalLinks,
        externalLinks: baseData.externalLinks,
        price: baseData.price,
        currencySymbol: baseData.currencySymbol,
        currencyCode: baseData.currencyCode,
        stockStatus: baseData.stockStatus,
        category: baseData.category,
        breadcrumbs: baseData.breadcrumbs,
        jsonLdData: baseData.jsonLdData,
        schemaOrgTypes: baseData.schemaOrgTypes,
        features: baseData.features,
        date: baseData.date,
        publishDate: baseData.publishDate,
        author: baseData.author,
        blogCategories: baseData.blogCategories,
        blogTags: baseData.blogTags,
        blogContentSample: baseData.blogContentSample,
        productBrand: baseData.productBrand,
        productSku: baseData.productSku,
        productAvailability: baseData.productAvailability,
        productCondition: baseData.productCondition,
        productGtin: baseData.productGtin,
        productMpn: baseData.productMpn,
        productColor: baseData.productColor,
        productSize: baseData.productSize,
        productMaterial: baseData.productMaterial,
        productRatingValue: safeParseFloat(baseData.productRatingValue as any),
        productReviewCount: safeParseFloat(baseData.productReviewCount as any),
        productOffers: baseData.productOffers,
        socialLinks: baseData.socialLinks,
        contactInfo: baseData.contactInfo,
        language: baseData.language,
        favicon: baseData.favicon,
        canonicalUrl: baseData.canonicalUrl,
        ampUrl: baseData.ampUrl,
        videoUrls: baseData.videoUrls,
        audioUrls: baseData.audioUrls,
        formFields: baseData.formFields,
        tableData: baseData.tableData,
        rawHtmlLength: baseData.rawHtmlLength ?? htmlContent?.length ?? 0,
        cleanedTextLength: baseData.mainTextContent?.length || 0,
        fetchTimestamp: new Date().toISOString(),
        processingTimeMs: 0, // This can be calculated later
        htmlLang: baseData.htmlLang,
        metaRobots: baseData.metaRobots,
        
        // JSON-LD specific fields from baseData
        jsonLdProductOffers: baseData.jsonLdProductOffers,
        jsonLdAuthor: baseData.jsonLdAuthor,
        jsonLdPublisher: baseData.jsonLdPublisher,
        jsonLdRating: baseData.jsonLdRating,
        jsonLdReviews: baseData.jsonLdReviews,
        jsonLdItemCondition: baseData.jsonLdItemCondition,
        jsonLdAvailability: baseData.jsonLdAvailability,
        jsonLdColor: baseData.jsonLdColor,
        jsonLdSize: baseData.jsonLdSize,
        jsonLdMaterial: baseData.jsonLdMaterial,
        jsonLdGtin: baseData.jsonLdGtin,
        jsonLdMpn: baseData.jsonLdMpn,
        jsonLdBrand: baseData.jsonLdBrand,
        jsonLdSku: baseData.jsonLdSku,
        jsonLdCategories: baseData.jsonLdCategories,
        jsonLdBreadcrumbs: baseData.jsonLdBreadcrumbs,
        jsonLdImage: baseData.jsonLdImage,
        jsonLdDescription: baseData.jsonLdDescription,
        jsonLdName: baseData.jsonLdName,
        jsonLdUrl: baseData.jsonLdUrl,
        jsonLdPrice: baseData.jsonLdPrice,
        jsonLdPriceCurrency: baseData.jsonLdPriceCurrency,
        jsonLdInLanguage: baseData.jsonLdInLanguage,
        jsonLdDatePublished: baseData.jsonLdDatePublished,
        jsonLdDateModified: baseData.jsonLdDateModified,
        jsonLdHeadline: baseData.jsonLdHeadline,
        jsonLdKeywords: baseData.jsonLdKeywords,
        jsonLdArticleBody: baseData.jsonLdArticleBody,
        jsonLdArticleSection: baseData.jsonLdArticleSection,
        jsonLdWordCount: baseData.jsonLdWordCount,
        jsonLdMainEntityOfPage: baseData.jsonLdMainEntityOfPage,
        jsonLdIsPartOf: baseData.jsonLdIsPartOf,
        jsonLdAbout: baseData.jsonLdAbout,
        jsonLdMentions: baseData.jsonLdMentions,
        jsonLdAudience: baseData.jsonLdAudience,
        jsonLdCreator: baseData.jsonLdCreator,
        jsonLdContributor: baseData.jsonLdContributor,
        jsonLdEditor: baseData.jsonLdEditor,
        jsonLdProvider: baseData.jsonLdProvider,
        jsonLdSourceOrganization: baseData.jsonLdSourceOrganization,
        jsonLdCopyrightHolder: baseData.jsonLdCopyrightHolder,
        jsonLdCopyrightYear: baseData.jsonLdCopyrightYear,
        jsonLdVersion: baseData.jsonLdVersion,
        jsonLdLicense: baseData.jsonLdLicense,
        jsonLdExpires: baseData.jsonLdExpires,
        jsonLdIsAccessibleForFree: baseData.jsonLdIsAccessibleForFree,
        jsonLdHasPart: baseData.jsonLdHasPart,
        jsonLdExampleOfWork: baseData.jsonLdExampleOfWork,
        jsonLdLearningResourceType: baseData.jsonLdLearningResourceType,
        jsonLdEducationalUse: baseData.jsonLdEducationalUse,
        jsonLdTypicalAgeRange: baseData.jsonLdTypicalAgeRange,
        jsonLdInteractivityType: baseData.jsonLdInteractivityType,
        jsonLdAccessMode: baseData.jsonLdAccessMode,
        jsonLdAccessModeSufficient: baseData.jsonLdAccessModeSufficient,
        jsonLdAccessibilityFeature: baseData.jsonLdAccessibilityFeature,
        jsonLdAccessibilityHazard: baseData.jsonLdAccessibilityHazard,
        jsonLdAccessibilitySummary: baseData.jsonLdAccessibilitySummary,
        jsonLdAccessibilityAPI: baseData.jsonLdAccessibilityAPI,
        jsonLdAccessibilityControl: baseData.jsonLdAccessibilityControl,
        jsonLdAdditionalType: baseData.jsonLdAdditionalType,
        jsonLdAlternateName: baseData.jsonLdAlternateName,
        jsonLdDisambiguatingDescription: baseData.jsonLdDisambiguatingDescription,
        jsonLdIdentifier: baseData.jsonLdIdentifier,
        jsonLdSameAs: baseData.jsonLdSameAs,
        jsonLdSubjectOf: baseData.jsonLdSubjectOf,
        jsonLdPotentialAction: baseData.jsonLdPotentialAction,
        
        navigationLinks: baseData.navigationLinks,
        footerLinks: baseData.footerLinks,

        aiProductBrand: baseData.aiProductBrand, // Carries over if baseData has it
        aiProductSku: baseData.aiProductSku,
        aiBlogAuthor: baseData.aiBlogAuthor,
        aiBlogTags: baseData.aiBlogTags,
        siteSelectorsUsed: baseData.siteSelectorsUsed,

        aiDetectedType: undefined,
        aiExtractedData: undefined,
        error: baseData.error || (fetchMethod.includes('failed') ? (headlessErrorDetail || axiosFetchError || 'Fetch failed') : null),
        message: baseData.message || (fetchMethod.includes('failed') ? (headlessErrorDetail || axiosFetchError || 'Fetch failed').substring(0,150) : null),
        fetchMethod: fetchMethod,
    };

    if (finalData.error && (!finalData.title || finalData.title === 'Başlık Yok' || finalData.title === url)) {
        finalData.aiDetectedType = 'client_error';
        finalData.pageTypeGuess = 'error';
        addLog(`[API] Fetch ultimately failed for ${url}. Error: ${finalData.error}. Returning error state.`, {context:'final-error-check', data: {requestId}, level: 'error'});
        return NextResponse.json(finalData);
    }

    operationStage = 'ai-analysis-decision';
    let perform_AI_analysis = false;
    let ai_task_description = "";
    const currentBestPageTypeFromFinalData = finalData.pageTypeGuess;

    if (!currentBestPageTypeFromFinalData || currentBestPageTypeFromFinalData === 'unknown' || currentBestPageTypeFromFinalData === 'error') {
      if (finalData.mainTextContent && finalData.mainTextContent.length > 150) {
        perform_AI_analysis = true;
        ai_task_description = "Bu sayfanın TÜRÜNÜ (product, blogPost, categoryPage, staticPage, unknown) KESİNLEŞTİR ve bu türe uygun TEMEL BİLGİLERİ (başlık, meta açıklama, varsa fiyat/kategori/tarih gibi) çıkar.";
      }
    } else if (currentBestPageTypeFromFinalData === 'product') {
      let missingForProductMsg = "Bu ÜRÜN sayfası için Cheerio/JSON-LD/Headless ile bulunanları doğrula/geliştir ve ŞU EKSİK BİLGİLERİ metinden çıkar: ";
      let productMissingFields: string[] = [];
      if (!finalData.features || finalData.features.length < 1) productMissingFields.push("ürün özellikleri (en az 1-2 adet)");
      if (!finalData.price) productMissingFields.push("fiyat");
      if (!finalData.stockStatus) productMissingFields.push("stok durumu");
      if (!finalData.images || finalData.images.length === 0) productMissingFields.push("en az 1 ana ürün görseli");
      if (!finalData.category) productMissingFields.push("ürün kategorisi");
      if (productMissingFields.length > 0) {
        perform_AI_analysis = true;
        ai_task_description = missingForProductMsg + productMissingFields.join(', ') + ".";
      }
       if (!finalData.currencyCode && finalData.currencySymbol) {
          perform_AI_analysis = true; 
          const currencyTask = ` Para birimi sembolü '${finalData.currencySymbol}' için doğru ISO kodunu (TRY, USD, EUR vb.) belirle.`;
          if (ai_task_description) ai_task_description += currencyTask;
          else ai_task_description = "Bu ÜRÜN sayfası için" + currencyTask;
      }
    } else if (currentBestPageTypeFromFinalData === 'blog') {
      let missingForBlogMsg = "Bu BLOG yazısı için Cheerio/JSON-LD/Headless ile bulunanları doğrula/geliştir ve ŞU EKSİK BİLGİLERİ metinden çıkar: ";
      let blogMissingFields: string[] = [];
      if (!finalData.publishDate) blogMissingFields.push("yayın tarihi");
      if (!finalData.blogContentSample || finalData.blogContentSample.length < 50) blogMissingFields.push("yazı özeti (en az 50 karakter)");
      if ((!finalData.blogCategories || finalData.blogCategories.length === 0) && (!finalData.aiBlogTags || finalData.aiBlogTags.length === 0)) blogMissingFields.push("blog kategorileri veya etiketleri");
      if (blogMissingFields.length > 0) {
        perform_AI_analysis = true;
        ai_task_description = missingForBlogMsg + blogMissingFields.join(', ') + ".";
      }
    } else if (currentBestPageTypeFromFinalData === 'category') {
       if (!finalData.metaDescription || finalData.metaDescription.length < 30) {
            perform_AI_analysis = true;
            ai_task_description = "Bu KATEGORİ sayfası için kategori adını kesinleştir ve metinden bir kategori açıklaması çıkar.";
        }
    }

    if (perform_AI_analysis && (!finalData.mainTextContent || finalData.mainTextContent.length <= 50)) {
      perform_AI_analysis = false; 
      addLog(`[API] AI Analysis triggered but overridden due to insufficient content (${finalData.mainTextContent?.length || 0} chars) for ${url}. Using prior data only.`, { level: 'info', context: 'ai-analysis-skip-override', data: { requestId, url }});
    }
    
    if (perform_AI_analysis && finalData.mainTextContent && finalData.mainTextContent.length > 50) {
      operationStage = 'ai-call';
      addLog(`[API] AI Analysis triggered for ${url}: ${ai_task_description}`, {context: 'ai-analysis', data: {requestId}});
      
      let cheerioSummary = `CHEERIO/JSON-LD/HEADLESS BULGULARI ÖZETİ (Fetch Yöntemi: ${finalData.fetchMethod}):
  - Tahmini Sayfa Türü: ${finalData.pageTypeGuess || 'Bilinmiyor'}
  - Başlık: ${finalData.title || 'Yok'}
  - Meta Açıklama: ${finalData.metaDescription || 'Yok'}
  - Fiyat: ${finalData.price ? (finalData.price + (finalData.currencySymbol || '') + (finalData.currencyCode || '')) : 'Yok'}
  - Stok: ${finalData.stockStatus || 'Yok'}
  - Kategori (Cheerio): ${finalData.category || 'Yok'}
  - Yayın Tarihi (Cheerio): ${finalData.publishDate || finalData.date || 'Yok'}
  - Görsel Sayısı (Cheerio/Headless): ${finalData.images?.length || 0} (OG: ${finalData.ogImage ? 'Var' : 'Yok'})
  - H1 Başlıkları: ${(finalData.headings?.h1 || []).slice(0,1).join(' | ') || 'Yok'}
  ${finalData.jsonLdData && finalData.jsonLdData.length > 0 ? `\n- ÖNEMLİ JSON-LD VERİLERİ (ilk şema örneği):\n${JSON.stringify(finalData.jsonLdData[0], null, 1).substring(0, 300)}...\n` : ''}
  `;

      const promptContext = `VERİLEN URL: ${url}\n${cheerioSummary}`;
      const aiPrompt = `
        ${promptContext}
        YUKARIDAKİ URL'DEN ÇEKİLEN TEMİZLENMİŞ ANA METİN (en fazla 10000 karakter):
        ${finalData.mainTextContent?.slice(0,10000) || 'Ana metin bulunamadı veya çok kısa.'}

        GÖREVİN:
        ${ai_task_description}
        Aşağıdaki JSON formatını DİKKATLİCE ve EKSİKSİZ doldur. Cheerio/Headless ile bulunan bilgileri KULLAN, DOĞRULA, DÜZELT ve EKSİKLERİ TAMAMLA. Ana metinden çıkarım yapmaya öncelik ver.
        ÖNEMLİ: "images" alanı için, sayfa türüne uygun (ürün/blog için 1-3 ana görsel, kategori/statik sayfa için 1-2 temsili görsel) en alakalı, yüksek kaliteli görsellerin TAM URL'lerini bul.
        ÖNEMLİ: "currency" için sadece uluslararası para birimi KODUNU (örn: TRY, USD, EUR) döndür.
        SADECE ve SADECE aşağıda istenen formatta GEÇERLİ bir JSON nesnesi döndür. Öncesinde veya sonrasında kesinlikle ek metin, yorum veya markdown (\`\`\`json ... \`\`\`) KULLANMA.

        İSTENEN JSON ÇIKTISI:
        {
          "detectedPageType": "product | blogPost | categoryPage | staticPage | unknown",
          "pageTitle": "Sayfanın ana, en doğru ve kullanıcı dostu başlığı",
          "metaDescription": "Sayfanın SEO uyumlu, kısa ve öz meta açıklaması (maks. 160 karakter)",
          "productInfo": {
            "productName": "Ürünün tam ve doğru adı",
            "price": "123.99" | null,
            "currency": "TRY" | "USD" | "EUR" | null,
            "stockStatus": "Mevcut" | "Tükendi" | "Ön Sipariş" | null,
            "brand": "Marka Adı" | null,
            "sku": "SKU veya Ürün Kodu" | null,
            "shortDescription": "Ürünü tanıtan kısa ve çarpıcı bir açıklama (2-3 cümle)" | null,
            "detailedDescription": "Ürünün ana metinden çıkarılan kapsamlı ve detaylı açıklaması" | null,
            "images": ["https://example.com/ana-gorsel1.jpg"] | [],
            "features": ["Özellik Adı 1: Özellik Değeri 1"] | [],
            "categoriesFromPage": ["Ana Kategori", "Alt Kategori"] | []
          },
          "blogPostInfo": {
            "postTitle": "Blog yazısının tam ve dikkat çekici başlığı",
            "author": "Yazar Adı" | null,
            "publishDate": "YYYY-MM-DD" | null,
            "summary": "Yazının ana fikrini veren kısa ve etkili bir özet" | null,
            "categoriesFromPage": ["Blog Kategorisi 1"] | [],
            "tags": ["etiket1", "etiket2"] | [],
            "images": ["https://example.com/blog-gorsel1.jpg"] | []
          },
          "categoryPageInfo": {
            "categoryName": "Kategori sayfasının net adı",
            "description": "Kategori hakkında kısa bir açıklama" | null,
            "images": ["https://example.com/category-banner.jpg"] | []
          },
          "staticPageInfo": {
            "pagePurpose": "Sayfanın temel amacı" | null,
            "images": ["https://example.com/static-page-image.jpg"] | []
          }
        }`;

      const aiResult = await callAI(aiPrompt, preferredAiModel, requestId, url);

      if (aiResult && !aiResult.error && aiResult.detectedPageType && aiResult.detectedPageType !== 'unknown') {
        finalData.aiDetectedType = aiResult.detectedPageType;
        finalData.aiExtractedData = aiResult;
        
        finalData.title = aiResult.pageTitle || finalData.title;
        finalData.metaDescription = aiResult.metaDescription || finalData.metaDescription;

        const processAiImageUrls = (urls: string[] | undefined | null, altTextBase: string | undefined | null, pageUrl: string): ImageItem[] => {
            if (!urls || urls.length === 0) return [];
            return urls.map((srcStr: unknown) => {
                if (typeof srcStr === 'string' && srcStr.trim() !== '') {
                    const resolved = resolveUrlHelper(srcStr, pageUrl);
                    const altText = altTextBase || finalData.title || 'Image';
                    return resolved ? { src: resolved, alt: altText, width: undefined, height: undefined, hasAlt: !!altText } : null;
                }
                return null;
            }).filter((img): img is ImageItem => img !== null);
        };
        let newAiImages: ImageItem[] = [];

        if (aiResult.productInfo) {
            finalData.price = aiResult.productInfo.price || finalData.price;
            finalData.currencyCode = aiResult.productInfo.currency || finalData.currencyCode || mapCurrencySymbolToCode(finalData.currencySymbol);
            finalData.stockStatus = aiResult.productInfo.stockStatus || finalData.stockStatus;
            if (aiResult.productInfo.images) newAiImages.push(...processAiImageUrls(aiResult.productInfo.images, aiResult.productInfo.productName || finalData.title, url));
            finalData.features = aiResult.productInfo.features?.length ? aiResult.productInfo.features : finalData.features;
            finalData.category = aiResult.productInfo.categoriesFromPage?.join('; ') || finalData.category;
            finalData.aiProductBrand = aiResult.productInfo.brand || finalData.aiProductBrand;
            finalData.aiProductSku = aiResult.productInfo.sku || finalData.aiProductSku;
        }
        if (aiResult.blogPostInfo) {
            finalData.publishDate = aiResult.blogPostInfo.publishDate || finalData.publishDate || finalData.date;
            finalData.blogCategories = aiResult.blogPostInfo.categoriesFromPage?.length ? aiResult.blogPostInfo.categoriesFromPage : finalData.blogCategories;
            finalData.blogContentSample = aiResult.blogPostInfo.summary || finalData.blogContentSample;
            if (aiResult.blogPostInfo.images) newAiImages.push(...processAiImageUrls(aiResult.blogPostInfo.images, aiResult.blogPostInfo.postTitle || finalData.title, url));
            finalData.aiBlogAuthor = aiResult.blogPostInfo.author || finalData.aiBlogAuthor;
            finalData.aiBlogTags = (aiResult.blogPostInfo.tags?.length ? aiResult.blogPostInfo.tags : undefined) || finalData.aiBlogTags;
        }
        if (aiResult.categoryPageInfo) {
            finalData.category = aiResult.categoryPageInfo.categoryName || finalData.category || finalData.title;
            if (aiResult.categoryPageInfo.images) newAiImages.push(...processAiImageUrls(aiResult.categoryPageInfo.images, aiResult.categoryPageInfo.categoryName || finalData.title, url));
        }
        if (aiResult.staticPageInfo) {
            if (aiResult.staticPageInfo.images) newAiImages.push(...processAiImageUrls(aiResult.staticPageInfo.images, finalData.title, url));
        }

        if (newAiImages.length > 0) {
          const existingImageSrcs = new Set((finalData.images || []).map(img => img.src));
          const uniqueNewAiImages = newAiImages.filter(img => img.src && !existingImageSrcs.has(img.src));
          finalData.images = [...(finalData.images || []), ...uniqueNewAiImages];
        }
        
        addLog(`[API] AI successfully enhanced data for ${url}`, { context: 'ai-analysis-success', data: { requestId, type: finalData.aiDetectedType }});
      } else {
        finalData.aiDetectedType = finalData.pageTypeGuess || 'ai_error';
        finalData.aiExtractedData = { detectedPageType: finalData.aiDetectedType || 'unknown', error: aiResult?.error || 'AI analysis failed or type unknown.', ...aiResult };
        addLog('[API] AI result error or unknown type. Relying on prior data.', { level: 'warn', context: 'ai-analysis-fail', data: { requestId, url, aiError: aiResult?.error, resultPreview: JSON.stringify(aiResult || {}).substring(0,200) }});
      }
    } else {
      finalData.aiDetectedType = finalData.pageTypeGuess;
      finalData.aiExtractedData = { detectedPageType: finalData.aiDetectedType || 'unknown', pageTitle: finalData.title, metaDescription: finalData.metaDescription };
      const reason = (!finalData.mainTextContent || finalData.mainTextContent.length <= 50) ? "insufficient content" : "AI analysis not triggered by logic";
      addLog(`[API] AI analysis SKIPPED for ${url} (${reason}). Using prior data only.`, { level: 'info', context: 'ai-analysis-skip', data: { requestId, url }});
    }

    operationStage = 'final-currency-mapping';
    if (!finalData.currencyCode && finalData.currencySymbol) {
      finalData.currencyCode = mapCurrencySymbolToCode(finalData.currencySymbol);
    }
    if (finalData.currencySymbol && finalData.currencyCode && finalData.currencySymbol.toUpperCase() === finalData.currencyCode.toUpperCase()) {
      finalData.currencySymbol = null; 
    }

    if (fetchMethod.includes('failed') && !finalData.error) {
        const specificError = headlessErrorDetail || axiosFetchError || 'Content fetch failed';
        finalData.error = specificError;
        finalData.message = specificError.substring(0, 150);
        finalData.pageTypeGuess = 'error';
        finalData.aiDetectedType = 'client_error';
    } else if (finalData.error && (finalData.pageTypeGuess !== 'error' || finalData.aiDetectedType !== 'client_error')) {
        // Eğer bir hata mesajı varsa ama tip error/client_error değilse, bunu zorla.
        finalData.pageTypeGuess = 'error';
        finalData.aiDetectedType = 'client_error';
    }
    
    addLog(`[API] Final data for URL ${url}: Fetch: ${finalData.fetchMethod}, Cheerio/HeadlessType: ${finalData.pageTypeGuess}, AIType: ${finalData.aiDetectedType}, Nav: ${finalData.navigationLinks?.length || 0}, Ftr: ${finalData.footerLinks?.length || 0}`, {context:'process-url-complete', data: {requestId}});
    return NextResponse.json(finalData);

  } catch (error: any) { 
    logError(error, 'scrape-ai-post-global-error', { context: 'scrape-ai-post-global', data: { requestId, url: requestUrlForError, operationStage, message: error.message, stack: error.stack?.substring(0,500) } });
    const errorResponse: Partial<ScrapedPageData> = { // Use Partial as not all fields are mandatory for an error response
        url: requestUrlForError,
        error: `Global error in POST handler: ${error.message}`,
        message: `Error at stage ${operationStage}: ${error.message.substring(0,150)}`,
        pageTypeGuess: 'error',
        aiDetectedType: 'client_error',
        title: 'N/A', 
        metaDescription: 'N/A', 
        images: [], 
        // features: [], // Not strictly needed for error response
        // breadcrumbs: [], 
        // navigationLinks: [], 
        // footerLinks: [],
        fetchMethod: fetchMethod || 'unknown_error_state',
        fetchTimestamp: new Date().toISOString(),
    };
    return NextResponse.json(errorResponse, { status: 500 });
  } finally { 
    operationStage = 'global-finally-close-browser';
    if (playwrightBrowser) {
      await playwrightBrowser.close();
      addLog('[API] Playwright browser closed in global finally block.', { context: 'scrape-ai-post', data: { requestId } });
    }
  }
});