// lib/config.ts
import prisma from '@/lib/prisma'; // client'ınız
import { addLog, logError } from './logger'; // Varsayımsal logger importu

export interface SelectorConfigItem {
  selector: string;
  attr?: string;
  isTable?: boolean; // Özellik tabloları için özel işlem gerekebilir
  isJsonLd?: boolean; // JSON-LD içeriği için özel bayrak
  jsonPath?: string;  // JSON-LD içinden veri almak için JSONPath
}

export type SelectorKey =
  | 'title' // Ürün adı, blog başlığı, sayfa başlığı
  | 'metaDescription' // Meta açıklama
  | 'keywords'
  | 'ogImage' // Open Graph ana görsel URL'si
  | 'canonicalUrl'
  | 'price' // Ürün fiyatı
  | 'stockStatus' // Stok durumu metni
  | 'productImages' // Ürün için ek görsellerin seçicileri
  | 'features' // Ürün özellikleri
  | 'productCategory' // Ürünün ait olduğu kategori metni
  | 'publishDate' // Blog yazısının yayın tarihi
  | 'blogPageCategories' // Blog yazısının kendi içindeki kategoriler/etiketler
  | 'blogContentSample' // Blog içeriğinden kısa bir örnek/özet
  | 'categoryName' // Kategori sayfasının adı
  | 'navigationLinksContainers' // Ana navigasyon menüsünü içeren HTML konteyner(ler)i
  | 'footerLinksContainers' // Footer linklerini içeren ana HTML konteyner(ler)i
  | 'breadcrumbsContainers'; // Breadcrumb navigasyonunu içeren ana HTML konteyner(ler)i

export type SiteSpecificSelectors = Partial<Record<SelectorKey, SelectorConfigItem[]>>;

// GENEL, FALLBACK SEÇİCİLER (olabildiğince standartlara ve yaygın yapılara yakın)
export const GENERAL_SELECTORS: Required<Record<SelectorKey, SelectorConfigItem[]>> = {
    title: [ { selector: 'meta[property="og:title"]', attr: 'content' }, { selector: 'title' }, { selector: 'h1' } ],
    metaDescription: [ { selector: 'meta[property="og:description"]', attr: 'content' }, { selector: 'meta[name="description"]', attr: 'content' } ],
    keywords: [{selector: 'meta[name="keywords"]', attr: 'content'}],
    ogImage: [ { selector: 'meta[property="og:image"]', attr: 'content' }, { selector: 'meta[property="og:image:secure_url"]', attr: 'content' } ],
    canonicalUrl: [{selector: 'link[rel="canonical"]', attr: 'href'}],
    price: [ { selector: '[itemprop="price"]', attr: 'content' }, { selector: '[itemprop="price"]' }, { selector: '.price', }, {selector: '.product-price'} ],
    stockStatus: [ { selector: '[itemprop="availability"]', attr: 'content' }, { selector: '[itemprop="availability"]' }, { selector: '.stock-status'} ],
    productImages: [ { selector: 'img[itemprop="image"]', attr: 'src' }, {selector: '.product-gallery img', attr: 'src'}, {selector: 'figure.woocommerce-product-gallery__wrapper img', attr:'src'} ,{ selector: '.product-gallery__image img', attr: 'src' }, // Shopify Dawn teması gibi
    { selector: '.product-main-image img', attr: 'src' }, // Genel bir yapı
    { selector: 'img.wp-post-image', attr: 'src' }, // WordPress ana ürün resmi
    { selector: 'div.product-image-gallery img.fotorama__img', attr: 'src'}, // Magento gibi bazı yapılar
    { selector: 'ul.product-images li img', attr: 'src'}, // Liste yapısı
    { selector: 'img[itemprop="image"]', attr: 'src' },
   { selector: 'script[type="application/ld+json"]', isJsonLd: true, jsonPath: '$.image' },
    // Electroru / Lazy images
    { selector: 'img.owl-lazy', attr: 'data-src' },
    { selector: 'img.img-auto.owl-lazy', attr: 'data-src' }
  ],
    features: [ { selector: '[itemprop="additionalProperty"] [itemprop="value"]'}, { selector: 'table.shop_attributes tr', isTable: true }, {selector: '.product-features li'} ],
    productCategory: [ { selector: '[itemprop="category"]', attr: 'content'}, { selector: '[itemprop="category"]'}, {selector: '.posted_in a'} ], // WooCommerce
    publishDate: [ { selector: '[itemprop="datePublished"]', attr: 'content' }, { selector: 'meta[property="article:published_time"]', attr: 'content' }, {selector: 'time[datetime]', attr: 'datetime'} ],
    blogPageCategories: [ { selector: '[itemprop="articleSection"]', attr: 'content'}, { selector: '[rel="category tag"]'} ],
    blogContentSample: [ { selector: 'article .entry-content p:first-of-type'}, { selector: '[itemprop="articleBody"] p:first-of-type'} ],
    categoryName: [{selector: 'h1.category-title'}, {selector: 'h1.page-title'}, {selector: 'h1'}],
    navigationLinksContainers: [ { selector: 'header nav' }, { selector: 'header .menu' }, { selector: '[role="navigation"]'}, {selector: '#main-navigation'}, {selector: '.main-menu'} ],
    footerLinksContainers: [ { selector: 'footer' }, { selector: '[role="contentinfo"]'}, {selector: '.footer-menu ul'} ],
    breadcrumbsContainers: [ { selector: '[itemtype*="BreadcrumbList"]' }, { selector: 'nav[aria-label="breadcrumb"] ol'}, {selector: '.breadcrumbs, .breadcrumb'} ]
};

export const URL_PATTERNS = {

       product: ['/urun', '/product', '/p/', '/item/', '_p/', '-p-', '/detay', '/detail', '/prod/', '/sp/', '/dp/',
              '/product-detail/', '/products/', '/ecommerce/product/', '/product-page/', '/shop/'],
    blog: ['/blog', '/haber', '/article', '/post/', '/yazi/', '/icerik', '/news', '/stories/', '/makale/',
           '/blog-detail/', '/entry/', '/gundem/', '/duyuru/', '/content/', '/blogs/', '/articles/', '/posts/', 
           '/news-item/'],
    category: ['/kategori', '/category', '/collection/', '/c/', '/grup/', '/marka/', '/brand/', '/shop/', '/list/', 
               '/liste/', '/categories/', '/cat/', '/departments/', '/product-category/', '/shop/category/'],
    // Yeni eklenen desenler
    collection: ['/collection', '/collections/', '/seri/', '/album/'],
    forum: ['/forum', '/forums/', '/community/', '/board/', '/topic/', '/thread/'],
    search: ['/search', '/arama/', '/query=', '/find/', '/results/'],
    error: ['/404', '/error', '/not-found/', '/sayfa-bulunamadi/'],
    // sitemap, robots, feed için özel yollar zaten kodunuzda ele alınıyor,
    // ancak isterseniz buraya da eklenebilirler veya ayrı kontrol edilebilirler.
    staticPageKeywords: ['hakkimizda', 'iletisim', 'gizlilik', 'kvkk', 'teslimat', 'iade', 'sss', 'faq', 'about', 
                         'contact', 'privacy', 'terms', 'shipping', 'returns', 'destek', 'support', 'yardim', 
                         'help', 'sayfa', 'page', 'sitemap', 'site-map', 'about-us', 'contact-us', 'pages', 
                         'kurumsal']
};

// MANUEL OLARAK EKLEYECEĞİMİZ SİTEYE ÖZEL SEÇİCİLER (Veritabanı yerine şimdilik)
const MANUAL_SITE_SELECTORS: Record<string, SiteSpecificSelectors> = {
    'www.toptanturkiye.com': {
        title: [{ selector: 'h1.title.page-title'}], // Örnek
        // productName: [{ selector: '.product-info .title' }], // Eski koddan - productName SelectorKey içinde yok, title kullanılabilir.
        price: [{ selector: '.product-info-pricearea .price-current' }, { selector: '.product-info-pricearea .price-new' }],
        stockStatus: [{selector: '#stock > span.label'}],
        productImages: [{selector: '.product-img-box .main-img', attr:'src'}, {selector: '.image-additional a.thumbnail', attr: 'href'}], // images yerine productImages
        features: [{selector: '#tab-specification tr', isTable: true}],
        navigationLinksContainers: [{selector: 'header div.header-bottom nav#navigation'}],
        footerLinksContainers: [
            {selector: 'footer .container .row .col-sm-3:nth-child(1) ul'}, // KURUMSAL
            {selector: 'footer .container .row .col-sm-3:nth-child(2) ul'}, // ALIŞVERİŞ
            {selector: 'footer .container .row .col-sm-3:nth-child(3) ul'}, // ÜYELİK
        ],
        breadcrumbsContainers: [{selector: 'ul.breadcrumb'}]
    },
    
    // Diğer siteler için de buraya eklenebilir
};


export async function getSiteSpecificSelectors(hostname: string): Promise<SiteSpecificSelectors | null> {
  console.log(`[CONFIG] Attempting to get specific selectors for: ${hostname}`);
  if (MANUAL_SITE_SELECTORS[hostname]) {
    console.log(`[CONFIG] Found manual selectors for ${hostname}`);
    return MANUAL_SITE_SELECTORS[hostname];
  }
  // Önce veritabanından çekmeyi dene
  const storedSelectors = await getStoredSiteSelectors(hostname);
  if (storedSelectors) {
    console.log(`[CONFIG] Found stored selectors for ${hostname} in database.`);
    return storedSelectors;
  }
  // TODO: İleride AI ile otomatik tespit edilenleri çek
  console.log(`[CONFIG] No specific manual or stored selectors found for ${hostname}. Using GENERAL_SELECTORS as fallback base.`);
  return null; // Eğer hiçbir özel seçici bulunamazsa null döner, çağıran taraf GENERAL_SELECTORS'ı kullanır.
}


// VERİTABANI ETKİLEŞİMLERİ
export async function getStoredSiteSelectors(hostname: string): Promise<SiteSpecificSelectors | null> {
  addLog(`[CONFIG] Fetching stored selectors for: ${hostname} from database.`, {hostname});
  try {
    const config = await prisma.siteConfiguration.findUnique({ where: { hostname } });
    if (config && config.selectorsJson) {
      addLog(`[CONFIG] Found stored selectors for ${hostname}.`, {hostname});
      return config.selectorsJson as SiteSpecificSelectors;
    }
    addLog(`[CONFIG] No stored selectors found for ${hostname}.`, {hostname});
    return null;
  } catch (error: any) {
    logError(error, '[CONFIG] Error fetching stored selectors', { hostname, message: error.message });
    return null;
  }
}

export async function storeSiteSelectors(hostname: string, selectors: SiteSpecificSelectors): Promise<void> {
  addLog(`[CONFIG] Storing/Updating ${Object.keys(selectors).length} selectors for: ${hostname} in database.`, {hostname, selectorKeys: Object.keys(selectors)});
  try {
    await prisma.siteConfiguration.upsert({
      where: { hostname },
      create: { hostname, selectorsJson: selectors as any },
      update: { selectorsJson: selectors as any },
    });
    addLog(`[CONFIG] Successfully stored/updated selectors for ${hostname}.`, {hostname});
  } catch (error: any) {
    logError(error, '[CONFIG] Error storing/updating selectors', { hostname, message: error.message });
  }
} 