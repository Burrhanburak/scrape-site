// /app/api/scrape-ai/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import LLMScraper from 'llm-scraper';
import { google, LanguageModel } from '@ai-sdk/google';
import playwrightAwsLambda from 'playwright-aws-lambda'; // For Vercel/Lambda
import { chromium as playwrightChromiumLocal, Browser as PlaywrightBrowserType, Page as PlaywrightPageType } from 'playwright'; // For Local

import { addLog, logError } from '@/lib/logger';
import { withCors } from '@/lib/cors';
import {
  ScrapedPageData,
  ImageItem,
  LinkItem,
  extractBaseDataFromHtml, // Bu fonksiyon async olmalı ve JSON-LD'yi iyi işlemeli
  mapCurrencySymbolToCode, // Bu fonksiyonun scraper-utils'de export edildiğinden emin olun
  resolveUrl, // Eğer resim URL'lerini resolve etmek için kullanılacaksa
} from '@/lib/scraper-utils';
import { URL as NodeURL } from 'url'; // siteHostname için


// --- API Anahtarı ve LLM İstemcileri ---
if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) { // @ai-sdk/google bu değişkeni arar
  addLog('GOOGLE_GENERATIVE_AI_API_KEY is not set. LLM functionality might be impaired.', {level: 'warn', context: 'api-setup'});
}

// LLM Instance (Gemini)
const geminiLlmInstance: LanguageModel = google('models/gemini-1.5-flash-latest'); // Model adını güncel tutun

// LLMScraper Instance
let llmScraper: LLMScraper | null = null;
try {
    // LLMScraper constructor'ı @ai-sdk/google'dan gelen LanguageModel'i kabul etmeli.
    llmScraper = new LLMScraper(geminiLlmInstance);
    addLog('LLMScraper initialized successfully with Google Gemini instance.', { context: 'api-setup' });
} catch (e: any) {
    logError(e, 'llm-scraper-init-error', { context: 'api-setup', message: "Failed to initialize LLMScraper." });
}

// Zod şeması (LLMScraper için)
// /app/api/scrape-ai/route.ts
// ... diğer importlar

const zodSchemaForLLM = z.object({
  pageTitle: z.string().optional().describe(
    "Sayfanın ana, kullanıcı dostu ve en doğru başlığını çıkar. " +
    "Öncelikle `<title>` etiketine, sonra `<meta property=\"og:title\">` etiketine, sonra sayfadaki ana `<h1>` etiketine bak. " +
    "Bulamazsan, URL'den anlamlı bir başlık türetmeye çalış. Çok uzunsa kısalt."
  ),
  metaDescription: z.string().optional().describe(
    "Sayfanın SEO uyumlu, bilgilendirici ve öz meta açıklamasını (yaklaşık 150-160 karakter) çıkar. " +
    "1. Öncelik: `<meta name=\"description\" content=\"...\">` etiketinin içeriği. " +
    "2. Öncelik: `<meta property=\"og:description\" content=\"...\">` etiketinin içeriği. " +
    "Eğer bu etiketler yoksa veya içerikleri yetersizse (çok kısa, genel bir mesaj vb.), sayfanın ana içeriğinin ilk 1-2 anlamlı paragrafından uygun bir özet oluştur. " +
    "Eğer hiç uygun açıklama bulunamazsa bu alanı boş bırak (null döndür)."
  ),
  detectedPageType: z.string().optional().describe(
    "Sayfanın türünü belirle: 'product' (tek bir ürün detayı), 'blogPost' (tek bir makale/haber), " +
    "'categoryPage' (birden fazla ürün veya makalenin listelendiği kategori/arşiv sayfası), " +
    "'staticPage' (hakkımızda, iletişim, KVKK gibi sabit içerikli sayfa), 'homepage' (sitenin ana sayfası, genellikle '/' yolu), " +
    "veya 'unknown' (diğerleri). Sayfadaki ipuçlarına (URL, başlık, içerik yapısı, JSON-LD @type) göre karar ver."
  ),

  // --- Ürün Sayfası İçin Alanlar ---
  productName: z.string().optional().describe(
    "Eğer sayfa bir 'product' ise, ürünün tam ve doğru adını çıkar. Genellikle `<h1>` içinde veya belirgin bir ürün başlığı alanında bulunur."
  ),
  price: z.string().optional().describe(
    "Eğer sayfa bir 'product' ise, ürünün fiyatını sayısal bir string olarak (örn: \"123.99\", \"1500.00\") çıkar. " +
    "Para birimi sembolünü veya kodunu dahil etme, onu 'currency' alanına yaz. Ondalık ayracı olarak nokta (.) kullan."
  ),
  currency: z.string().optional().describe(
    "Eğer sayfa bir 'product' ise ve fiyat bulunduysa, fiyatın para birimi kodunu (örn: \"TRY\", \"USD\", \"EUR\") çıkar. " +
    "Sayfadaki sembollerden (₺, $, €) veya metinlerden (TL, Dolar, Euro) bunu belirle."
  ),
  stockStatus: z.string().optional().describe(
    "Eğer sayfa bir 'product' ise, stok durumunu belirle. " +
    "Sayfada 'Stokta Var', 'Mevcut', 'Tükendi', 'Stokta Yok', 'Ön Sipariş', 'Yakında Gelecek', 'Sepete Ekle' gibi ifadeler/butonlar ara. " +
    "Bulunan duruma göre 'Mevcut', 'Tükendi', 'Ön Sipariş' gibi standart bir değer döndür. " +
    "Eğer 'Sepete Ekle' butonu aktif ve başka bir bilgi yoksa 'Mevcut' kabul et. Bilgi bulunamazsa null bırak."
  ),
  productBrand: z.string().optional().describe(
    "Eğer sayfa bir 'product' ise, ürünün markasını (üretici veya satıcı marka) çıkar. Genellikle ürün adı yakınında veya ürün detaylarında belirtilir."
  ),
  productSku: z.string().optional().describe(
    "Eğer sayfa bir 'product' ise, ürünün SKU (Stok Kodu Birimi), MPN (Üretici Parça Numarası) veya benzersiz ürün kodunu çıkar."
  ),
  productFeatures: z.array(z.string()).optional().describe(
    "Eğer sayfa bir 'product' ise, ürünün temel özelliklerini bir liste olarak çıkar. " +
    "Her bir özellik 'Özellik Adı: Değer' formatında (örn: 'Renk: Kırmızı', 'Malzeme: Pamuk') veya sadece özellik metni olabilir. " +
    "Genellikle 'Ürün Özellikleri', 'Teknik Detaylar' gibi başlıklar altında listelenir."
  ),
  productCategories: z.array(z.string()).optional().describe(
    "Eğer sayfa bir 'product' ise, ürünün ait olduğu kategorileri bir liste olarak çıkar. " +
    "Genellikle breadcrumb (sayfa yolu) navigasyonundan (örn: 'Anasayfa > Giyim > Kadın > Elbise' ise ['Giyim', 'Kadın', 'Elbise'] gibi) veya ürün başlığına yakın belirtilen kategorilerden al. En spesifik kategoriden en genele doğru sırala."
  ),
  productImages: z.array(z.string()).optional().describe(
    "Eğer sayfa bir 'product' ise, ürünün ana ve en iyi kalitedeki 1 ila 3 adet görselinin TAM ve GEÇERLİ URL'lerini çıkar. " +
    "Bunlar http:// veya https:// ile başlamalıdır. Küçük thumbnail'ler yerine ana ürün görsellerini tercih et."
  ),

  // --- Blog Yazısı İçin Alanlar ---
  postTitle: z.string().optional().describe(
    "Eğer sayfa bir 'blogPost' (makale/haber) ise, yazının tam ve dikkat çekici başlığını çıkar."
  ),
  author: z.string().optional().describe(
    "Eğer sayfa bir 'blogPost' ise ve belirtilmişse, yazının yazarının adını çıkar."
  ),
  publishDate: z.string().optional().describe(
    "Eğer sayfa bir 'blogPost' ise, yazının yayın tarihini 'YYYY-MM-DD' formatında çıkar. " +
    "Sayfadaki tarih bilgisini bu formata dönüştürmeye çalış."
  ),
  blogSummary: z.string().optional().describe(
    "Eğer sayfa bir 'blogPost' ise, yazının ana fikrini veren, yaklaşık 2-4 cümlelik kısa ve etkili bir özetini oluştur. " +
    "Yazının giriş paragraflarından veya en önemli kısımlarından faydalan."
  ),
  blogCategories: z.array(z.string()).optional().describe(
    "Eğer sayfa bir 'blogPost' ise, yazının ait olduğu kategorileri bir liste olarak çıkar. " +
    "Genellikle yazı başında veya sonunda belirtilir."
  ),
  blogTags: z.array(z.string()).optional().describe(
    "Eğer sayfa bir 'blogPost' ise, yazıya atanmış etiketleri (keywords) bir liste olarak çıkar."
  ),
  blogImages: z.array(z.string()).optional().describe(
    "Eğer sayfa bir 'blogPost' ise, yazı içeriğiyle en alakalı 1-2 adet ana görselin TAM ve GEÇERLİ URL'lerini çıkar. " +
    "Bunlar http:// veya https:// ile başlamalıdır."
  ),

  // --- Kategori Sayfası İçin Alanlar ---
  categoryName: z.string().optional().describe(
    "Eğer sayfa bir 'categoryPage' (ürün/makale listeleme sayfası) ise, bu kategorinin adını çıkar. Genellikle sayfa başlığında (H1) belirtilir."
  ),
  categoryDescription: z.string().optional().describe(
    "Eğer sayfa bir 'categoryPage' ise ve varsa, kategori hakkında genel bilgi veren kısa bir açıklama metni çıkar."
  ),
// /api/scrape-ai/route.ts -> zodSchemaForLLM içinde
detectedPageType: z.string().optional().describe(
  "Sayfanın türünü belirle: 'product' (tek bir ürün detayı), 'blogPost' (tek bir makale/haber), " +
  "'categoryPage' (birden fazla ürün veya makalenin listelendiği kategori/arşiv sayfası), " +
  "'staticPage' (hakkımızda, iletişim, KVKK gibi sabit içerikli sayfa), " +
  "'homepage' (sitenin ana sayfası, genellikle URL yolu sadece '/' olur), " + // homepage eklendi
  "veya 'unknown' (diğerleri). Sayfadaki ipuçlarına (URL, başlık, içerik yapısı, JSON-LD @type) göre karar ver."
),
  // --- Statik Sayfa İçin Alanlar ---
  // (staticPage için Zod şemasına özel alanlar eklenebilir veya pageTitle/metaDescription yeterli olabilir)
  // staticPagePurpose: z.string().optional().describe("Eğer 'staticPage' ise, sayfanın amacını kısaca belirt (örn: 'Şirket tanıtımı', 'Kullanıcı sözleşmesi', 'İletişim bilgileri').")

}).catchall(z.any()); // Şemada olmayan ama LLM'in bulduğu diğer alanları da al (opsiyonel)

// --- Kendi AI Çağrı Fonksiyonunuz (Gemini için) ---
async function callCustomGeminiAI(prompt: string, requestId: string, urlForLog: string): Promise<any | null> {
  addLog(`[CustomAI] Attempting to call Gemini for URL: ${urlForLog}`, { context: 'custom-ai-call', data: { requestId, promptLength: prompt.length } });
  try {
    const { response } = await geminiModelForCustomAI.generate({ prompt });
    const textResponse = response.candidates?.[0]?.content?.parts?.[0]?.text;

    if (textResponse) {
      addLog(`[CustomAI] Gemini raw response received for ${urlForLog}. Length: ${textResponse.length}`, { context: 'custom-ai-call', data: { requestId } });
      // Yanıtın JSON formatında olup olmadığını kontrol et
      let jsonData = null;
      try {
        // Temizleme: Başı ve sonundaki ```json ... ``` işaretlerini kaldır
        const cleanedResponse = textResponse.replace(/^```json\s*|```\s*$/g, '').trim();
        jsonData = JSON.parse(cleanedResponse);
        addLog(`[CustomAI] Gemini response parsed successfully for ${urlForLog}`, { context: 'custom-ai-call', data: { requestId, parsedDataPreview: JSON.stringify(jsonData).substring(0, 200) } });
        return jsonData;
      } catch (parseError: any) {
        logError(parseError, 'custom-ai-json-parse-error', {
          context: 'custom-ai-call',
          data: { requestId, url: urlForLog, rawResponse: textResponse.substring(0, 500), message: parseError.message }
        });
        // JSON parse hatası durumunda, ham metni veya bir hata objesini döndürebiliriz.
        // Şimdilik, AI'nın düzgün formatta yanıt vermediğini belirten bir hata objesi döndürelim.
        return { error: "AI response was not valid JSON.", rawResponse: textResponse.substring(0, 1000) };
      }
    } else {
      addLog(`[CustomAI] Gemini returned no text response for ${urlForLog}`, { context: 'custom-ai-call', data: { requestId }, level: 'warn' });
      return { error: "AI returned no text response." };
    }
  } catch (error: any) {
    logError(error, 'custom-ai-gemini-call-exception', {
      context: 'custom-ai-call',
      data: { requestId, url: urlForLog, message: error.message, stack: error.stack?.substring(0, 300) }
    });
    return { error: `Custom AI (Gemini) call failed: ${error.message}` };
  }
}

// --- Veritabanı Kayıt Fonksiyonu ---
async function mapAndSaveScrapedData(data: ScrapedPageData, scrapeIdParam: string, requestId: string): Promise<void> {
    // operationStage'i burada tanımlamıyoruz, çünkü bu fonksiyon POST handler'ın context'inde çağrılıyor
    // ve operationStage orada yönetiliyor. Eğer bu fonksiyon bağımsız çalışacaksa, kendi operationStage'i olmalı.
    const publishDateObj = data.publishDate ? new Date(data.publishDate) : null;
    let aiPublishDateObj: Date | null = null;
    if (data.aiExtractedData?.blogPostInfo?.publishDate) {
        const parsedDate = new Date(data.aiExtractedData.blogPostInfo.publishDate);
        if (!isNaN(parsedDate.getTime())) {
            aiPublishDateObj = parsedDate;
        }
    }

    const toPrismaPageType = (typeStr?: string | null): PrismaScrapedPageType | null => {
        if (!typeStr) return PrismaScrapedPageType.UNKNOWN; // veya null, modelinize bağlı
        const upperType = typeStr.toUpperCase().replace(/-/g, '_').replace(/ /g, '_');
        if (Object.values(PrismaScrapedPageType).includes(upperType as PrismaScrapedPageType)) {
            return upperType as PrismaScrapedPageType;
        }
        // Daha esnek eşleme
        if (upperType.includes('PRODUCT')) return PrismaScrapedPageType.PRODUCT;
        if (upperType.includes('BLOG') || upperType.includes('ARTICLE') || upperType.includes('POST')) return PrismaScrapedPageType.BLOG_POST;
        if (upperType.includes('CATEGORY') || upperType.includes('LISTING')) return PrismaScrapedPageType.CATEGORY_PAGE;
        if (upperType.includes('STATIC') || upperType.includes('PAGE')) return PrismaScrapedPageType.STATIC_PAGE; // 'PAGE' -> STATIC_PAGE
        if (upperType.includes('HOME')) return PrismaScrapedPageType.HOMEPAGE;
        
        addLog(`[DB Save] Unknown page type string for Prisma: '${typeStr}', mapped to UNKNOWN.`, { context: 'db-save-mapping', data: { requestId, originalType: typeStr }, level: 'warn' });
        return PrismaScrapedPageType.UNKNOWN;
    };

    const prismaData = {
        scrapeId: scrapeIdParam,
        url: data.url!,
        
        pageTypeGuess: toPrismaPageType(data.pageTypeGuess),
        title: data.title?.substring(0, 255),
        metaDescription: data.metaDescription?.substring(0, 500),
        keywords: data.keywords || [],
        ogType: data.ogType?.substring(0, 100),
        ogTitle: data.ogTitle?.substring(0, 255),
        ogDescription: data.ogDescription?.substring(0, 500),
        ogImage: data.ogImage?.substring(0, 1024),
        canonicalUrl: data.canonicalUrl?.substring(0, 1024),
        htmlLang: data.htmlLang?.substring(0, 20),
        metaRobots: data.metaRobots?.substring(0, 255),
        price: data.price, // Decimal type in Prisma
        currencySymbol: data.currencySymbol?.substring(0, 10),
        stockStatus: data.stockStatus?.substring(0, 50),
        productCategory: data.productCategory?.substring(0, 255),
        publishDate: (publishDateObj && !isNaN(publishDateObj.getTime())) ? publishDateObj : null,
        features: data.features || [],
        blogPageCategories: data.blogCategories || [],
        blogContentSample: data.blogContentSample?.substring(0, 1000),
        mainTextContent: data.mainTextContent, // Text type in Prisma
        
        jsonLdDataJson: data.jsonLdData || null, // JSON type in Prisma
        schemaOrgTypesJson: data.schemaOrgTypes ? JSON.stringify(data.schemaOrgTypes) : null,
        imagesJson: data.images || null, // JSON type in Prisma
        headingsJson: data.headings || null, // JSON type in Prisma
        allLinksJson: data.allLinks || null, // JSON type in Prisma
        internalLinksJson: data.internalLinks || null, // JSON type in Prisma
        externalLinksJson: data.externalLinks || null, // JSON type in Prisma
        navigationLinksJson: data.navigationLinks || null, // JSON type in Prisma
        footerLinksJson: data.footerLinks || null, // JSON type in Prisma
        breadcrumbsJson: data.breadcrumbs || null, // JSON type in Prisma

        aiDetectedType: toPrismaPageType(data.aiDetectedType),
        aiPageTitle: data.aiExtractedData?.pageTitle?.substring(0, 255) || data.title?.substring(0,255),
        aiMetaDescription: data.aiExtractedData?.metaDescription?.substring(0, 500) || data.metaDescription?.substring(0,500),
        aiProductName: data.aiExtractedData?.productInfo?.productName?.substring(0, 255),
        aiPrice: data.aiExtractedData?.productInfo?.price, // Decimal
        aiCurrencyCode: data.aiExtractedData?.productInfo?.currency?.substring(0,10) || data.currencyCode?.substring(0,10),
        aiStockStatus: data.aiExtractedData?.productInfo?.stockStatus?.substring(0,50) || data.stockStatus?.substring(0,50),
        aiBrand: data.aiExtractedData?.productInfo?.brand?.substring(0,100) || data.aiProductBrand?.substring(0,100),
        aiSku: data.aiExtractedData?.productInfo?.sku?.substring(0,100) || data.aiProductSku?.substring(0,100),
        aiShortDescription: data.aiExtractedData?.productInfo?.shortDescription?.substring(0, 500), // Assuming a field exists
        aiDetailedDescription: data.aiExtractedData?.productInfo?.detailedDescription, // Text type
        aiFeatures: data.aiExtractedData?.productInfo?.features || [],
        aiCategories: data.aiExtractedData?.productInfo?.categoriesFromPage || data.aiExtractedData?.blogPostInfo?.categoriesFromPage || [],
        aiBlogAuthor: data.aiExtractedData?.blogPostInfo?.author?.substring(0,100) || data.author?.substring(0,100),
        aiBlogPublishDate: (aiPublishDateObj && !isNaN(aiPublishDateObj.getTime())) ? aiPublishDateObj : ((publishDateObj && !isNaN(publishDateObj.getTime())) ? publishDateObj : null),
        aiBlogSummary: data.aiExtractedData?.blogPostInfo?.summary, // Text type
        aiBlogTags: data.aiExtractedData?.blogPostInfo?.tags || data.blogTags || [],
        aiCategoryName: data.aiExtractedData?.categoryPageInfo?.categoryName?.substring(0, 255),
        aiCategoryDescription: data.aiExtractedData?.categoryPageInfo?.description, // Text type
        aiListedItemUrls: (data.aiExtractedData?.categoryPageInfo as any)?.listedItemUrls || [],
        aiStaticPagePurpose: data.aiExtractedData?.staticPageInfo?.pagePurpose?.substring(0, 500),

        fetchMethod: data.fetchMethod?.substring(0,50),
        siteSelectorsUsed: data.siteSelectorsUsed, // JSON type
        errorMessage: data.error?.substring(0,1000) || data.message?.substring(0,1000),
        lastCheckedAt: new Date(),
    };
    
    // operationStage = 'prisma-upsert-scrapedpage'; // Set by caller
    await prisma.scrapedPage.upsert({
        where: { scrapeId_url: { scrapeId: scrapeIdParam, url: data.url! } },
        create: prismaData,
        update: { ...prismaData, updatedAt: new Date() },
    });

    // operationStage = 'prisma-update-scrape-session'; // Set by caller
    await prisma.scrape.update({
        where: { id: scrapeIdParam },
        data: {
            processedUrls: { increment: 1 },
            updatedAt: new Date(),
            status: 'PROCESSING', // Keep status as processing until all URLs are done
        },
    });
    addLog(`[API] ScrapedPage data saved/updated in DB for URL: ${data.url}, ScrapeID: ${scrapeIdParam}`, { context: 'db-save', data: { requestId }});
}


// --- MAIN POST HANDLER ---
export const POST = withCors(async function POST(req: NextRequest) {
  const requestId = Math.random().toString(36).substring(2, 10);
  let operationStage = 'init'; 
  let requestUrlForError = 'unknown_url';
  let browser: PlaywrightBrowserType | null = null;
  let pwPage: PlaywrightPageType | null = null;
  let htmlContentForCheerio: string | null = null; 
  let fetchMethod = 'playwright_pending';
  let fetchErrorDetail: string | null = null;
  let scrapeIdFromRequest: string | null = null;


  try {
    operationStage = 'parsing-request-json';
    const { url, scrapeId } = await req.json();
    scrapeIdFromRequest = scrapeId; // Store for global error handler
    requestUrlForError = url || 'unknown_url_from_request';

    if (!url) {
      addLog('[API] Missing URL parameter', { level: 'error', data: { requestId } });
      return NextResponse.json({ url: requestUrlForError, scrapeId, error: 'URL gerekli', pageTypeGuess: 'client_error', aiDetectedType: 'client_error', title: 'N/A' } as ScrapedPageData, { status: 400 });
    }
    if (!scrapeId) {
      addLog('[API] Missing scrapeId parameter', { level: 'error', data: { requestId, url } });
      return NextResponse.json({ url, scrapeId: null, error: 'scrapeId gerekli', pageTypeGuess: 'client_error', aiDetectedType: 'client_error', title: 'N/A' } as ScrapedPageData, { status: 400 });
    }
    addLog(`[API] Processing URL: ${url} for Scrape ID: ${scrapeId} (CustomAI Main)`, { context: 'scrape-ai-post', data: { requestId, url, scrapeId } });

    // Adım 1: Playwright ile Sayfa Alma
    operationStage = 'playwright-launch-navigate';
    try {
        let launchOptions: Parameters<typeof playwrightChromiumLocal.launch>[0] = { headless: true };
        let browserContextImpl: typeof playwrightChromiumLocal | typeof playwrightAwsLambda = playwrightChromiumLocal;

        if (process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL_ENV === 'production') {
            addLog('[API] Initializing Playwright for Vercel/Lambda environment.', { context: 'playwright-setup', data: { requestId } });
            browserContextImpl = playwrightAwsLambda;
            // const executablePath = await playwrightAwsLambda.executablePath();
            // if (executablePath) launchOptions.executablePath = executablePath;
        } else {
            addLog('[API] Initializing Playwright for local environment.', { context: 'playwright-setup', data: { requestId } });
        }
        
        if (typeof browserContextImpl.launch !== 'function') {
            logError(new Error('Selected Playwright context does not have a launch function.'), 'playwright-launch-method-missing', {
                context: 'playwright-setup',
                isLambda: !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL_ENV === 'production')
            });
            throw new Error('Playwright launch method not found in the selected context.');
        }
        
        addLog('[API] Launching browser...', { context: 'playwright-setup', data: { launchOptions } });
        browser = await browserContextImpl.launch(launchOptions);
        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 SIT-Scraper/2.3',
            javaScriptEnabled: true,
            ignoreHTTPSErrors: true,
            viewport: { width: 1280, height: 800 },
        });
        pwPage = await context.newPage();
        
        addLog(`[API] Playwright navigating to ${url}`, {context: 'playwright-fetch', data: {requestId}});
        const pwResponse = await pwPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

        if (pwResponse && pwResponse.ok()) {
            htmlContentForCheerio = await pwPage.content();
            fetchMethod = 'playwright_success_page_ready';
            addLog(`[API] Playwright page ready. HTML Length: ${htmlContentForCheerio?.length}`, {context: 'playwright-fetch', data: {requestId}});
        } else {
            const status = pwResponse?.status();
            fetchErrorDetail = `Playwright navigation failed with status: ${status || 'unknown'}`;
            addLog(`[API] Playwright navigation FAILED. Status: ${status}`, {context: 'playwright-fetch', data: {requestId, status}, level: 'warn'});
            fetchMethod = 'playwright_failed_navigation';
        }
    } catch (error: any) {
        fetchErrorDetail = error.message;
        logError(error, 'playwright-launch-navigate-exception', { context: 'playwright-fetch', data: { requestId, url, message: error.message, stack: error.stack?.substring(0, 500) } });
        fetchMethod = 'playwright_failed_exception';
    }
    // pwPage açık kalabilir eğer AI onu kullanacaksa, ama bizim custom AI HTML alıyor.
    // Bu yüzden burada kapatabiliriz veya AI sonrası. Şimdilik açık bırakalım, AI sonrası kapatalım.

    // Adım 2: Cheerio ile Temel Veri Çıkarma (JSON-LD dahil)
    operationStage = 'cheerio-base-extraction';
    let baseData: Partial<ScrapedPageData> = {
      url,
      scrapeId,
      fetchMethod,
      error: fetchErrorDetail,
      message: fetchErrorDetail ? fetchErrorDetail.substring(0, 150) : null,
      images: [], navigationLinks: [], footerLinks: [], breadcrumbs: [], jsonLdData: [], schemaOrgTypes: [],
    };

    if (htmlContentForCheerio && !fetchErrorDetail) {
      try {
        const cheerioData = await extractBaseDataFromHtml(htmlContentForCheerio, url!);
        baseData = { ...baseData, ...cheerioData };
        baseData.url = url; // Ensure URL is still set
        baseData.scrapeId = scrapeId; // Ensure scrapeId is still set
        if (baseData.error && !fetchErrorDetail) { // If Cheerio found an error not caught by Playwright
            fetchErrorDetail = baseData.error as string;
            baseData.message = baseData.message || (typeof baseData.error === 'string' ? baseData.error.substring(0,150) : "Cheerio error");
        }
        if (baseData.jsonLdData && baseData.jsonLdData.length > 0) {
            addLog(`[API] JSON-LD data found by Cheerio: ${baseData.jsonLdData.length} items.`, { context: 'cheerio-extraction', data: { requestId } });
        }
      } catch (cheerioError: any) {
        logError(cheerioError, 'cheerio-extraction-exception', { context: 'cheerio-base-extraction', data: { requestId, url, message: cheerioError.message } });
        baseData.error = baseData.error || `Cheerio extraction failed: ${cheerioError.message}`;
        baseData.message = baseData.message || `Cheerio: ${cheerioError.message.substring(0,120)}`;
      }
    } else {
      baseData.pageTypeGuess = baseData.pageTypeGuess || (fetchErrorDetail ? 'error' : 'unknown');
      baseData.title = baseData.title || (fetchErrorDetail ? "İçerik Alınamadı" : "Başlık Yok");
      if (!baseData.error && !htmlContentForCheerio) {
        baseData.error = "No HTML content obtained from Playwright for Cheerio processing.";
        baseData.message = "No HTML for Cheerio.";
      }
    }

    // Adım 3: Kendi Gemini AI Çağrınız ile Veri Zenginleştirme
    let customAiExtractedData: any = null;
    let aiDetectedTypeByCustomAI: ScrapedPageData['aiDetectedType'] = baseData.pageTypeGuess as ScrapedPageData['aiDetectedType']; // Başlangıçta Cheerio'dan
    
    const canRunCustomAI = htmlContentForCheerio && !baseData.error && 
                           (baseData.mainTextContent && baseData.mainTextContent.length > 100 || htmlContentForCheerio.length > 500);

    if (canRunCustomAI) {
        operationStage = 'custom-ai-extraction-prompt-prepare';
        // AI için prompt oluşturma
        // Zod şemasındaki tanımları kullanarak bir prompt oluşturabiliriz.
        // Örnek: "Aşağıdaki HTML içeriğinden şu bilgileri JSON formatında çıkar: sayfa başlığı, meta açıklama, sayfa türü (product, blogPost, categoryPage, staticPage, homepage, unknown)..."
        // Daha iyi sonuçlar için, HTML'in tamamı yerine önemli kısımlarını (örn. <head>, ana içerik alanı) gönderebilirsiniz.
        // Şimdilik basitleştirilmiş bir prompt:
        const simplifiedHtmlForPrompt = htmlContentForCheerio!.substring(0, 25000); // Gemini limitlerini göz önünde bulundurun
        const aiPrompt = `
          Analyze the following HTML content from the URL ${url} and extract the specified information in JSON format.
          Focus on accuracy and completeness based on the content.
          
          HTML Content (partial):
          \`\`\`html
          ${simplifiedHtmlForPrompt}
          \`\`\`

          JSON Output Structure:
          {
            "pageTitle": "string (The main, user-friendly title. Prioritize <title>, then og:title, then H1. If very long, shorten it.)",
            "metaDescription": "string (SEO-friendly meta description, ~150-160 chars. Prioritize <meta description>, then og:description. If not found or insufficient, summarize from main content. Null if no suitable description.)",
            "detectedPageType": "string ('product', 'blogPost', 'categoryPage', 'staticPage', 'homepage', 'unknown'. Decide based on URL, title, content structure, JSON-LD @type.)",
            "productInfo": {
              "productName": "string (If 'product', the full product name.)",
              "price": "string (If 'product', numeric price string, e.g., '123.99'. No currency symbol/code.)",
              "currency": "string (If 'product' and price found, currency code, e.g., 'TRY', 'USD'.)",
              "stockStatus": "string (If 'product', e.g., 'Mevcut', 'Tükendi', 'Ön Sipariş'. Null if not found.)",
              "brand": "string (If 'product', the brand name.)",
              "sku": "string (If 'product', SKU or MPN.)",
              "features": ["string (If 'product', list of key features, e.g., 'Color: Red' or just feature text.)"],
              "categoriesFromPage": ["string (If 'product', categories from breadcrumbs or near title. Specific to general.)"],
              "images": ["string (If 'product', 1-3 main, high-quality, FULL and VALID image URLs starting with http/https.)"],
              "shortDescription": "string (If 'product', a brief summary of the product, 1-2 sentences.)",
              "detailedDescription": "string (If 'product', more extensive description if available.)"
            },
            "blogPostInfo": {
              "postTitle": "string (If 'blogPost', the full title of the article.)",
              "author": "string (If 'blogPost', author's name.)",
              "publishDate": "string (If 'blogPost', publication date in 'YYYY-MM-DD' format.)",
              "summary": "string (If 'blogPost', a 2-4 sentence summary.)",
              "categoriesFromPage": ["string (If 'blogPost', categories the post belongs to.)"],
              "tags": ["string (If 'blogPost', tags or keywords.)"],
              "images": ["string (If 'blogPost', 1-2 relevant, FULL and VALID image URLs starting with http/https.)"]
            },
            "categoryPageInfo": {
              "categoryName": "string (If 'categoryPage', name of the category.)",
              "description": "string (If 'categoryPage', a short description of the category.)",
              "listedItemUrls": ["string (If 'categoryPage', list a few full URLs of items listed on this page, if easily identifiable.)"]
            },
            "staticPageInfo": {
              "pagePurpose": "string (If 'staticPage', briefly describe the page's purpose, e.g., 'Company information', 'Contact details'.)"
            }
          }
          If a field is not applicable or data cannot be found, omit the field or set its value to null where appropriate for strings, or an empty array for arrays.
          For 'productInfo', 'blogPostInfo', 'categoryPageInfo', 'staticPageInfo', only include the object if detectedPageType matches.
        `;
        
        operationStage = 'custom-ai-extraction-call';
        customAiExtractedData = await callCustomGeminiAI(aiPrompt, requestId, url);

        if (customAiExtractedData && !customAiExtractedData.error) {
          aiDetectedTypeByCustomAI = customAiExtractedData.detectedPageType || baseData.pageTypeGuess;
          addLog(`[API] CustomAI successfully extracted data. Type: ${aiDetectedTypeByCustomAI}`, { context: 'custom-ai-extraction', data: { requestId, extractedDataPreview: JSON.stringify(customAiExtractedData).substring(0,200) }});
        } else if (customAiExtractedData?.error) {
          addLog(`[API] CustomAI returned an error: ${customAiExtractedData.error}`, { context: 'custom-ai-extraction', data: { requestId, errorDetail: customAiExtractedData.rawResponse?.substring(0,300) }, level: 'warn' });
          // Don't overwrite baseData.error if AI fails, but log it.
        } else {
          addLog(`[API] CustomAI call returned no data or an unhandled error.`, { context: 'custom-ai-extraction', data: { requestId }, level: 'warn' });
        }
    } else {
        addLog(`[API] Skipping CustomAI for ${url} due to: ${!htmlContentForCheerio ? 'No HTML' : (baseData.error ? `previous error: ${baseData.error}` : 'insufficient content')}.`, { context: 'custom-ai-skip', data: { requestId, error: baseData.error } });
    }

    // Playwright sayfasını ve tarayıcıyı AI çağrısından sonra kapatabiliriz (eğer AI HTML kullanıyorsa)
    if (pwPage) { try { await pwPage.close(); pwPage = null; } catch (e) { addLog(`Error closing Playwright page post-AI: ${(e as Error).message}`, {level: 'warn', context: 'playwright-cleanup', data: {requestId}}) } }
    if (browser) { 
        try { await browser.close(); browser = null;
            addLog('[API] Playwright browser closed post-AI.', { context: 'playwright-cleanup', data: { requestId } }); 
        } catch (e) { 
            addLog(`Error closing Playwright browser post-AI: ${(e as Error).message}`, { level: 'warn', context: 'playwright-cleanup', data: { requestId } }); 
        }
    }


    // Adım 4: Verileri Birleştirme (Cheerio/JSON-LD + CustomAI)
    operationStage = 'final-data-assembly';
    // Öncelik: Custom AI > JSON-LD (baseData içinde) > Cheerio (baseData içinde)
    const finalAiDetectedTypeActual = customAiExtractedData?.detectedPageType || baseData.pageTypeGuess;

    let jsonLdProductInfo: any = null;
    let jsonLdBlogPostInfo: any = null;
    if (baseData.jsonLdData) {
        jsonLdProductInfo = baseData.jsonLdData.find(item => item['@type'] === 'Product' || (Array.isArray(item['@type']) && item['@type'].includes('Product')));
        jsonLdBlogPostInfo = baseData.jsonLdData.find(item => item['@type'] === 'BlogPosting' || (Array.isArray(item['@type']) && item['@type'].includes('BlogPosting')) || item['@type'] === 'Article');
    }
    
    let finalDetectedTypeForApiResponse = finalAiDetectedTypeActual; 
    if (finalDetectedTypeForApiResponse === 'staticPage') {
        finalDetectedTypeForApiResponse = 'page'; 
    }


    const finalData: ScrapedPageData = {
        url: baseData.url!,
        scrapeId: scrapeId,
        pageTypeGuess: baseData.pageTypeGuess, // Cheerio's initial guess
        title: customAiExtractedData?.pageTitle || baseData.title,
        metaDescription: (customAiExtractedData?.metaDescription && customAiExtractedData.metaDescription.toLowerCase() !== 'null' && customAiExtractedData.metaDescription.trim() !== "") 
                         ? customAiExtractedData.metaDescription 
                         : baseData.metaDescription,
        keywords: baseData.keywords,
        ogType: baseData.ogType,
        ogTitle: customAiExtractedData?.pageTitle || jsonLdProductInfo?.name || jsonLdBlogPostInfo?.headline || baseData.ogTitle,
        ogDescription: (customAiExtractedData?.metaDescription && customAiExtractedData.metaDescription.toLowerCase() !== 'null' && customAiExtractedData.metaDescription.trim() !== "")
                         ? customAiExtractedData.metaDescription
                         : (jsonLdProductInfo?.description || jsonLdBlogPostInfo?.description || baseData.ogDescription),
        ogImage: baseData.ogImage || (Array.isArray(jsonLdProductInfo?.image) ? jsonLdProductInfo.image[0]?.url || jsonLdProductInfo.image[0] : (jsonLdProductInfo?.image?.url || jsonLdProductInfo?.image)) || (Array.isArray(jsonLdBlogPostInfo?.image) ? jsonLdBlogPostInfo.image[0]?.url || jsonLdBlogPostInfo.image[0] : (jsonLdBlogPostInfo?.image?.url || jsonLdBlogPostInfo?.image)),
        canonicalUrl: baseData.canonicalUrl,
        htmlLang: baseData.htmlLang,
        metaRobots: baseData.metaRobots,
        jsonLdData: baseData.jsonLdData,
        schemaOrgTypes: baseData.schemaOrgTypes,
        headings: baseData.headings,
        allLinks: baseData.allLinks,
        internalLinks: baseData.internalLinks,
        externalLinks: baseData.externalLinks,
        navigationLinks: baseData.navigationLinks,
        footerLinks: baseData.footerLinks,
        breadcrumbs: baseData.breadcrumbs,
        mainTextContent: baseData.mainTextContent,
        siteSelectorsUsed: baseData.siteSelectorsUsed,
        fetchMethod: fetchMethod,
        error: baseData.error || customAiExtractedData?.error, // Prioritize base error, then AI error
        message: baseData.message || (customAiExtractedData?.error ? String(customAiExtractedData.error).substring(0,150) : null),
        rawHtmlLength: htmlContentForCheerio?.length || baseData.rawHtmlLength,
        aiDetectedType: finalDetectedTypeForApiResponse || (baseData.error ? 'error' : (customAiExtractedData?.error ? 'ai_error' : 'unknown')),
        aiExtractedData: customAiExtractedData && !customAiExtractedData.error ? {
            detectedPageType: finalDetectedTypeForApiResponse || 'unknown',
            pageTitle: customAiExtractedData.pageTitle,
            metaDescription: (customAiExtractedData.metaDescription === "null" || customAiExtractedData.metaDescription === "") ? null : customAiExtractedData.metaDescription,
            productInfo: (finalAiDetectedTypeActual === 'product' && customAiExtractedData.productInfo) ? customAiExtractedData.productInfo : null,
            blogPostInfo: (finalAiDetectedTypeActual === 'blogPost' && customAiExtractedData.blogPostInfo) ? customAiExtractedData.blogPostInfo : null,
            categoryPageInfo: (finalAiDetectedTypeActual === 'categoryPage' && customAiExtractedData.categoryPageInfo) ? customAiExtractedData.categoryPageInfo : null,
            staticPageInfo: (finalAiDetectedTypeActual === 'staticPage' && customAiExtractedData.staticPageInfo) ? customAiExtractedData.staticPageInfo : null,
        } : (baseData.error ? { detectedPageType: 'error', error: baseData.error as string } 
            : (customAiExtractedData?.error ? { detectedPageType: 'ai_error', error: String(customAiExtractedData.error) } 
            : (baseData.jsonLdData && (jsonLdProductInfo || jsonLdBlogPostInfo) ? { 
                detectedPageType: jsonLdProductInfo ? 'product' : (jsonLdBlogPostInfo ? 'blogPost' : 'unknown_jsonld'),
                pageTitle: jsonLdProductInfo?.name || jsonLdBlogPostInfo?.headline,
                metaDescription: jsonLdProductInfo?.description || jsonLdBlogPostInfo?.description,
            } : null))),
        
        price: customAiExtractedData?.productInfo?.price || jsonLdProductInfo?.offers?.[0]?.price || jsonLdProductInfo?.offers?.price || baseData.price,
        currencySymbol: baseData.currencySymbol,
        currencyCode: customAiExtractedData?.productInfo?.currency || jsonLdProductInfo?.offers?.[0]?.priceCurrency || jsonLdProductInfo?.offers?.priceCurrency || baseData.currencyCode,
        stockStatus: (customAiExtractedData?.productInfo?.stockStatus && customAiExtractedData.productInfo.stockStatus.toLowerCase() !== 'null' && customAiExtractedData.productInfo.stockStatus.trim() !== "")
                     ? customAiExtractedData.productInfo.stockStatus 
                     : jsonLdProductInfo?.offers?.[0]?.availability?.replace('http://schema.org/', '').replace('InStock', 'Mevcut').replace('OutOfStock', 'Tükendi') || 
                       jsonLdProductInfo?.offers?.availability?.replace('http://schema.org/', '').replace('InStock', 'Mevcut').replace('OutOfStock', 'Tükendi') || 
                       baseData.stockStatus,
        category: null, 
        productCategory: null, 
        publishDate: (finalAiDetectedTypeActual === 'blogPost' ? (customAiExtractedData?.blogPostInfo?.publishDate || jsonLdBlogPostInfo?.datePublished) : null) || baseData.publishDate || baseData.date,
        features: (finalAiDetectedTypeActual === 'product' ? (customAiExtractedData?.productInfo?.features || jsonLdProductInfo?.additionalProperty?.map((p:any) => `${p.name || p.propertyID || 'Özellik'}: ${p.value}`)) : null) || baseData.features,
        blogCategories: null, 
        blogPageCategories: null, 
        blogContentSample: (finalAiDetectedTypeActual === 'blogPost' ? (customAiExtractedData?.blogPostInfo?.summary || jsonLdBlogPostInfo?.description) : null) || baseData.blogContentSample,
        aiProductBrand: (finalAiDetectedTypeActual === 'product' ? (customAiExtractedData?.productInfo?.brand || jsonLdProductInfo?.brand?.name) : null) || baseData.aiProductBrand,
        aiProductSku: (finalAiDetectedTypeActual === 'product' ? (customAiExtractedData?.productInfo?.sku || jsonLdProductInfo?.sku || jsonLdProductInfo?.mpn) : null) || baseData.aiProductSku,
        aiBlogAuthor: (finalAiDetectedTypeActual === 'blogPost' ? (customAiExtractedData?.blogPostInfo?.author || jsonLdBlogPostInfo?.author?.name || (Array.isArray(jsonLdBlogPostInfo?.author) ? jsonLdBlogPostInfo.author[0]?.name : null)) : null) || baseData.author || baseData.aiBlogAuthor,
        aiBlogTags: (finalAiDetectedTypeActual === 'blogPost' ? (customAiExtractedData?.blogPostInfo?.tags || (Array.isArray(jsonLdBlogPostInfo?.keywords) ? jsonLdBlogPostInfo.keywords : (jsonLdBlogPostInfo?.keywords || '').split(',').map((k:string) => k.trim()).filter(Boolean))) : null) || baseData.blogTags || baseData.aiBlogTags,
        aiCategoryDescription: (finalAiDetectedTypeActual === 'categoryPage' ? (customAiExtractedData?.categoryPageInfo?.description) : null) || baseData.aiCategoryDescription,
        images: [...(baseData.images || [])],
      };

    // Kategori ve Ürün Kategorisi için birleştirme
    finalData.category = baseData.category || 
                         (customAiExtractedData?.productInfo?.categoriesFromPage && Array.isArray(customAiExtractedData.productInfo.categoriesFromPage) ? customAiExtractedData.productInfo.categoriesFromPage.join(', ') : null) ||
                         (customAiExtractedData?.blogPostInfo?.categoriesFromPage && Array.isArray(customAiExtractedData.blogPostInfo.categoriesFromPage) ? customAiExtractedData.blogPostInfo.categoriesFromPage.join(', ') : null);

    finalData.productCategory = (finalAiDetectedTypeActual === 'product' && customAiExtractedData?.productInfo?.categoriesFromPage && Array.isArray(customAiExtractedData.productInfo.categoriesFromPage) && customAiExtractedData.productInfo.categoriesFromPage.length > 0)
                                ? customAiExtractedData.productInfo.categoriesFromPage.join(' > ') 
                                : baseData.productCategory;

    const aiBlogCats = finalAiDetectedTypeActual === 'blogPost' ? customAiExtractedData?.blogPostInfo?.categoriesFromPage : null;
    const jsonLdBlogCatsRaw = jsonLdBlogPostInfo?.articleSection;
    const jsonLdBlogCats = Array.isArray(jsonLdBlogCatsRaw) ? jsonLdBlogCatsRaw : (jsonLdBlogCatsRaw ? [jsonLdBlogCatsRaw] : []);
    
    finalData.blogCategories = aiBlogCats && aiBlogCats.length > 0 ? aiBlogCats 
                              : (jsonLdBlogCats.length > 0 ? jsonLdBlogCats
                              : baseData.blogCategories);
    finalData.blogPageCategories = finalData.blogCategories;


    // Resim birleştirme
    const aiImagesRaw = (finalAiDetectedTypeActual === 'product' && customAiExtractedData?.productInfo?.images) ? customAiExtractedData.productInfo.images : 
                       ((finalAiDetectedTypeActual === 'blogPost' && customAiExtractedData?.blogPostInfo?.images) ? customAiExtractedData.blogPostInfo.images : []);
    
    if (Array.isArray(aiImagesRaw) && aiImagesRaw.length > 0) {
        const existingImageSrcsInFinal = new Set((finalData.images || []).map(img => img.src).filter(Boolean));
        aiImagesRaw.forEach((imgUrl: unknown) => {
            if (typeof imgUrl === 'string' && imgUrl.trim() !== '') {
                const resolvedImgUrl = resolveUrl(imgUrl, url!); 
                if (resolvedImgUrl && !existingImageSrcsInFinal.has(resolvedImgUrl)) {
                    (finalData.images = finalData.images || []).push({
                        src: resolvedImgUrl,
                        alt: finalData.title || 'AI Extracted Image', hasAlt: !!finalData.title, width: null, height: null
                    });
                    existingImageSrcsInFinal.add(resolvedImgUrl);
                } else if (!resolvedImgUrl && imgUrl.startsWith('http') && !existingImageSrcsInFinal.has(imgUrl)) {
                    (finalData.images = finalData.images || []).push({
                        src: imgUrl,
                        alt: finalData.title || 'AI Extracted Image (unresolved)', hasAlt: !!finalData.title, width: null, height: null
                    });
                    existingImageSrcsInFinal.add(imgUrl);
                }
            }
        });
    }
    if (finalData.images && finalData.images.length === 0) finalData.images = null;


    // Para birimi ve hata durumu son kontrolleri
    if (!finalData.currencyCode && finalData.currencySymbol) {
      finalData.currencyCode = mapCurrencySymbolToCode(finalData.currencySymbol);
    }
    if (finalData.currencySymbol && finalData.currencyCode && finalData.currencySymbol.toUpperCase() === finalData.currencyCode.toUpperCase()) {
      finalData.currencySymbol = null;
    }
    if (finalData.error && finalData.pageTypeGuess !== 'error') {
        finalData.pageTypeGuess = 'error';
    }
    if (finalData.error && finalData.aiDetectedType !== 'client_error' && finalData.aiDetectedType !== 'ai_error') {
        finalData.aiDetectedType = 'client_error'; 
    }
    if (!finalData.aiDetectedType && !finalData.error) {
        finalData.aiDetectedType = 'unknown';
    }


    // Adım 5: Veritabanına Kaydetme
    operationStage = 'database-save'; // Set operationStage before calling mapAndSaveScrapedData
    await mapAndSaveScrapedData(finalData, scrapeId, requestId);
    
    addLog(`[API] Successfully processed and saved data for URL ${url}. FinalAIType: ${finalData.aiDetectedType}`, { context: 'process-url-complete', data: { requestId, scrapeId } });
    return NextResponse.json(finalData);

  } catch (error: any) {
    logError(error, 'scrape-ai-post-global-error', { context: 'scrape-ai-post-global', data: { requestId, url: requestUrlForError, scrapeId: scrapeIdFromRequest, operationStage, message: error.message, stack: error.stack?.substring(0,500) }});
    const errorResponse: ScrapedPageData = {
      url: requestUrlForError,
      scrapeId: scrapeIdFromRequest,
      error: `Global error in POST handler: ${error.message}`,
      message: `Error at stage ${operationStage}: ${error.message.substring(0,150)}`,
      pageTypeGuess: 'error',
      aiDetectedType: 'client_error', 
      title: 'N/A',
      metaDescription: null, keywords: null, ogType: null, ogTitle: null, ogDescription: null, ogImage: null, canonicalUrl: null, htmlLang: null, metaRobots: null, jsonLdData: null, schemaOrgTypes: null, price: null, currencySymbol: null, currencyCode: null, stockStatus: null, images: null, category: null, productCategory: null, date: null, publishDate: null, features: null, blogContentSample: null, blogCategories: null, blogPageCategories: null, headings: null, allLinks: null, internalLinks: null, externalLinks: null, navigationLinks: null, footerLinks: null, breadcrumbs: null, mainTextContent: null, siteSelectorsUsed: null, fetchMethod: fetchMethod === 'playwright_pending' ? 'unknown_error' : fetchMethod, rawHtmlLength: null, aiExtractedData: { detectedPageType: 'error', error: `Global error: ${error.message}` }, aiProductBrand: null, aiProductSku: null, aiProductShortDescription: null, aiProductDescription: null, aiBlogAuthor: null, aiBlogTags: null, aiCategoryDescription: null,
    };
    // Veritabanında bu URL için hata durumunu güncelle (opsiyonel ama iyi bir pratik)
    if (scrapeIdFromRequest && requestUrlForError !== 'unknown_url') {
        try {
            operationStage = 'database-save-error-state';
            await mapAndSaveScrapedData(errorResponse, scrapeIdFromRequest, requestId); // Hata durumunu da kaydet
            addLog(`[API] Error state saved to DB for URL: ${requestUrlForError}`, { context: 'db-save-error', data: { requestId, scrapeId: scrapeIdFromRequest }});
        } catch (dbError: any) {
            logError(dbError, 'scrape-ai-db-save-error-state-failed', { context: 'db-save-error-global-handler', data: { requestId, url: requestUrlForError, scrapeId: scrapeIdFromRequest, message: dbError.message }});
        }
    }
    return NextResponse.json(errorResponse, { status: 500 });
  } finally {
      // Ensure Playwright resources are cleaned up even if they were closed earlier
      if (pwPage) { try { await pwPage.close(); } catch (e) { addLog(`Error closing Playwright page in finally: ${(e as Error).message}`, {level: 'warn', context: 'playwright-cleanup-finally', data: {requestId}}) } }
      if (browser) { 
          try { await browser.close(); 
              addLog('[API] Playwright browser closed in finally.', { context: 'playwright-cleanup-finally', data: { requestId } }); 
          } catch (e) { 
              addLog(`Error closing Playwright browser in finally: ${(e as Error).message}`, { level: 'warn', context: 'playwright-cleanup-finally', data: { requestId } });
          }
      }
  }
});