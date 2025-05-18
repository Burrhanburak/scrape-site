// app/api/generate-product-feed/[scrapeId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { create } from 'xmlbuilder2';
import { ScrapedPage, ScrapedPageType } from '@prisma/client';
import { addLog, logError } from '@/lib/logger'; // Varsayılan logger'ınız
import { ImageItem as ClientImageItem } from '@/lib/scraper-utils'; // Frontend'deki ImageItem tipi

// AI'dan gelen ham JSON verisinin beklenen yapısını tanımlayan interface'ler
// Bu interface'ler, ScrapedPageData.aiExtractedData içindeki yapıya uygun olmalı
interface AIProductInfo {
  productName?: string | null;
  brand?: string | null;
  sku?: string | null;
  price?: string | number | null;
  currency?: string | null;
  shortDescription?: string | null;
  detailedDescription?: string | null;
  categoriesFromPage?: string[] | null;
  stockStatus?: string | null;
  features?: string[] | null;
  images?: string[] | null; // AI'dan gelen imajlar string URL dizisi ise
}

interface AIParsedOutput { // Bu, page.aiExtractedData'nın içindeki "asıl" AI çıktısının tipi
  detectedPageType?: string | null;
  pageTitle?: string | null;
  metaDescription?: string | null;
  productInfo?: AIProductInfo | null;
  blogPostInfo?: { /* ...diğer alanlar... */ } | null;
  categoryPageInfo?: { /* ...diğer alanlar... */ } | null;
  // ...diğer olası AI veri yapıları
}

// Veritabanından gelen `ScrapedPage` objesini, feed için standart bir ürün objesine dönüştürür
function transformDbPageToFeedProduct(page: ScrapedPage) {
  let aiOutput: AIParsedOutput | null = null;
  if (page.aiExtractedData && typeof page.aiExtractedData === 'object' && page.aiExtractedData !== null) {
    // Varsayım: page.aiExtractedData, doğrudan AI'dan gelen JSON objesini (AIParsedOutput tipinde) tutuyor.
    // Eğer page.aiExtractedData, frontend'deki ScrapedPageData objesinin tamamını tutuyorsa
    // ve AI çıktısı bunun içinde bir alt alandaysa (örn: page.aiExtractedData.aiExtractedData),
    // o zaman erişim şekli değişir. (Örn: (page.aiExtractedData as any).aiExtractedData as AIParsedOutput)
    // Şimdilik direkt AI çıktısı olduğunu varsayıyoruz.
    aiOutput = page.aiExtractedData as AIParsedOutput;
  }
  const productInfoFromAI = aiOutput?.productInfo;

  let cheerioImageUrls: string[] = [];
  if (page.imagesJson) {
    try {
      const rawImagesData = typeof page.imagesJson === 'string'
        ? JSON.parse(page.imagesJson)
        : page.imagesJson; // Prisma'dan zaten obje olarak gelebilir

      if (Array.isArray(rawImagesData)) {
        cheerioImageUrls = (rawImagesData as ClientImageItem[])
          .map(img => img.src)
          .filter(Boolean);
      }
    } catch (e) {
      console.warn(`[ProductFeed] Page ${page.id}: Error parsing imagesJson.`, e);
    }
  }
  
  const featuresFromCheerio = page.features || []; // Prisma şemanızda features: String[] olmalı

  // Değerleri öncelikle AI'dan, sonra direkt sütunlardan (AI fallback), sonra Cheerio'dan al
  const productName = productInfoFromAI?.productName || page.aiPageTitle || page.title || 'N/A';
  const description = productInfoFromAI?.detailedDescription || productInfoFromAI?.shortDescription || page.metaDescription || '';
  
  let priceStr = '0';
  if (productInfoFromAI?.price !== undefined && productInfoFromAI?.price !== null) {
    priceStr = String(productInfoFromAI.price);
  } else if (page.price !== null) {
    priceStr = String(page.price);
  }

  const currencyCode = productInfoFromAI?.currency || page.currencyCode || (page.currencySymbol === '₺' ? 'TRY' : page.currencySymbol || 'TRY');
  const sku = productInfoFromAI?.sku || page.aiProductSku || `SKU-${page.id.substring(0,8)}`;
  const categoryName = productInfoFromAI?.categoriesFromPage?.join(' > ') || page.productCategory || page.category || 'Genel';
  const brandName = productInfoFromAI?.brand || page.aiProductBrand || 'Markasız';

  let finalImages: string[] = [];
  if (productInfoFromAI?.images && productInfoFromAI.images.length > 0) {
    finalImages = productInfoFromAI.images.filter(Boolean) as string[];
  } else if (cheerioImageUrls.length > 0) {
    finalImages = cheerioImageUrls;
  }
  if (page.ogImage && !finalImages.includes(page.ogImage)) {
    finalImages.unshift(page.ogImage);
  }
  finalImages = [...new Set(finalImages)].slice(0, 10); // İlk 10 benzersiz görsel

  const stockStatusText = productInfoFromAI?.stockStatus || page.stockStatus;
  let stockAmount = 50; // Varsayılan
  if (stockStatusText) {
    const lowerStock = stockStatusText.toLowerCase();
    if (lowerStock.includes('tükendi') || lowerStock.includes('yok') || lowerStock.includes('out of stock')) stockAmount = 0;
    else if (lowerStock.includes('mevcut') || lowerStock.includes('var') || lowerStock.includes('in stock')) stockAmount = 100;
  }

  const featuresList = productInfoFromAI?.features || featuresFromCheerio;

  return {
    id: page.id, // JSON için faydalı olabilir
    product_code: sku,
    product_name: productName,
    description: description,
    price: priceStr.replace(',', '.'), // Fiyatı her zaman nokta ile
    currency_code: currencyCode,
    stock_amount: stockAmount,
    stock_status_text: stockStatusText || (stockAmount > 0 ? 'Mevcut' : 'Tükendi'),
    category_name: categoryName,
    brand_name: brandName,
    images: finalImages,
    product_url: page.url,
    features_raw: featuresList, // Ham string listesi, XML ve JSON bunu farklı işleyebilir
    // Diğer AI veya Cheerio verileri eklenebilir...
    // publish_date: productInfoFromAI?.publishDate || page.publishDate // Örnek
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: { scrapeId: string } }
) {
  const scrapeId = params.scrapeId;
  const { searchParams } = new URL(request.url);
  const format = searchParams.get('format')?.toLowerCase() || 'xml'; // Varsayılan format xml

  if (!scrapeId) {
    return NextResponse.json({ error: 'Scrape ID is required' }, { status: 400 });
  }

  addLog(`[ProductFeed] Generating feed for scrapeId: ${scrapeId}`, { data: { scrapeId, format } });

  try {
    const dbScrapedPages = await prisma.scrapedPage.findMany({
      where: {
        scrapeId: scrapeId,
        OR: [
          { aiDetectedType: ScrapedPageType.PRODUCT },
          { AND: [{ aiDetectedType: null }, { pageTypeGuess: ScrapedPageType.PRODUCT }] }
        ],
        // error: null, // Opsiyonel: Sadece hatasız sayfaları dahil et
      },
    });

    if (dbScrapedPages.length === 0) {
      const message = 'No products found for this scrape to generate a feed.';
      if (format === 'xml') {
        const root = create({ version: '1.0', encoding: 'UTF-8' }).ele('PRODUCTS');
        root.ele('MESSAGE').txt(message);
        const xmlString = root.end({ prettyPrint: true });
        return new NextResponse(xmlString, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
      }
      return NextResponse.json({ message, products: [] }, { status: 200 });
    }

    const productsForFeed = dbScrapedPages.map(page => transformDbPageToFeedProduct(page));

    if (format === 'json') {
      const productsJson = productsForFeed.map(p => ({
        ...p, // Temel ürün verileri
        features: p.features_raw.map(featureStr => { // Özellikleri {name, value} yapısına dönüştür
          const parts = featureStr.split(/:(.*)/s); // İlk ":" karakterine göre ayır
          return {
            name: parts[0]?.trim() || featureStr,
            value: parts[1]?.trim() || 'Evet'
          };
        }),
        // features_raw alanını JSON'dan çıkarabiliriz
      })).map(({ features_raw, ...rest}) => rest); // features_raw'ı kaldır


      return NextResponse.json(productsJson, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          // 'Content-Disposition': `attachment; filename="product_feed_${scrapeId}.json"`, // Tarayıcıda indirme başlatmak için
        }
      });
    }

    // XML Oluşturma (format === 'xml' veya varsayılan)
    const rootNode = create({ version: '1.0', encoding: 'UTF-8' }).ele('PRODUCTS');

    for (const productData of productsForFeed) {
      const productElement = rootNode.ele('PRODUCT');
      productElement.ele('PRODUCT_CODE').txt(productData.product_code);
      productElement.ele('PRODUCT_NAME').dat(productData.product_name);
      productElement.ele('DESCRIPTION').dat(productData.description);
      productElement.ele('PRICE').txt(productData.price);
      productElement.ele('CURRENCY_CODE').txt(productData.currency_code);
      productElement.ele('STOCK_AMOUNT').txt(String(productData.stock_amount));
      // productElement.ele('STOCK_STATUS_TEXT').dat(productData.stock_status_text); // XML'e de eklenebilir
      productElement.ele('CATEGORY_NAME').dat(productData.category_name);
      productElement.ele('BRAND_NAME').dat(productData.brand_name);

      productData.images.forEach((imgUrl, index) => {
        if (imgUrl) productElement.ele(`IMAGE_URL${index + 1}`).dat(imgUrl);
      });

      productElement.ele('PRODUCT_URL').dat(productData.product_url);

      if (productData.features_raw && productData.features_raw.length > 0) {
        const featuresElement = productElement.ele('FEATURES');
        productData.features_raw.forEach(featureStr => {
          const parts = featureStr.split(/:(.*)/s); // İlk ":" karakterine göre ayır
          const featName = parts[0]?.trim();
          const featValue = parts[1]?.trim() || 'Evet';
          if (featName) {
            featuresElement.ele('FEATURE').ele('NAME').dat(featName).up().ele('VALUE').dat(featValue);
          }
        });
      }
    }

    const xmlString = rootNode.end({ prettyPrint: true });
    return new NextResponse(xmlString, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        // 'Content-Disposition': `attachment; filename="product_feed_${scrapeId}.xml"`, // Tarayıcıda indirme başlatmak için
      },
    });

  } catch (error: any) {
    logError(error, '[ProductFeed] Error generating feed', { data: { scrapeId, format } });
    const errorMessage = 'Failed to generate product feed.';
    const errorDetails = error.message || 'Unknown error';
    if (format === 'xml') {
        const errorRoot = create({ version: '1.0', encoding: 'UTF-8' }).ele('ERROR');
        errorRoot.ele('MESSAGE').txt(errorMessage);
        errorRoot.ele('DETAILS').txt(errorDetails);
        const errorXmlString = errorRoot.end({ prettyPrint: true });
        return new NextResponse(errorXmlString, { status: 500, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
    }
    return NextResponse.json({ error: errorMessage, details: errorDetails }, { status: 500 });
  }
}