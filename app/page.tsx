'use client';
import React, { useState, useEffect, useMemo, memo } from 'react';
import { ScrapedPageData, ImageItem, BreadcrumbItem, LinkItem } from '@/lib/scraper-utils';

// Utility function for logging errors
const logError = (error: any, context: string, additionalInfo?: object) => {
  console.error(`[ERROR] Context: ${context}`, error, additionalInfo);
  // In a real app, you might send this to a logging service like Sentry
};

// --- Cell Components ---
const ImageCell = memo(({ images, pageTitle }: { images?: ImageItem[] | null, pageTitle?: string | null }) => {
  if (!images || images.length === 0) return <div className="text-gray-500 text-xs italic">Resim Yok</div>;

  return (
    <div className="flex flex-wrap gap-1 max-w-[150px] overflow-hidden">
      {images.slice(0, 3).map((imgItem, i) => (
        imgItem.src ? (
          <a key={`${imgItem.src}-${i}`} href={imgItem.src} target="_blank" rel="noopener noreferrer" title={imgItem.alt || `Resim ${i + 1}`}>
            <img
              src={imgItem.src}
              alt={imgItem.alt || pageTitle || `Resim ${i + 1}`}
              width={32}
              height={32}
              className="object-cover rounded border border-gray-200 hover:opacity-80"
              style={{ minWidth: '32px', minHeight: '32px' }}
              loading="lazy"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          </a>
        ) : null
      ))}
      {images.length > 3 && <span className="text-xs text-gray-500 self-center">+{images.length - 3}</span>}
    </div>
  );
});
ImageCell.displayName = "ImageCell";

const formatDate = (dateStr?: string | null): string => {
  if (!dateStr) return '-';
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    return date.toLocaleDateString('tr-TR', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (e) {
    return dateStr;
  }
};

const FeaturesCell = memo(({ features }: { features?: string[] | null }) => {
  if (!features?.length) return <div className="text-gray-400 text-xs italic">Özellik Yok</div>;
  return (
    <ul className="list-disc pl-4 text-xs space-y-0.5 max-h-[60px] overflow-y-auto">
      {features.slice(0, 3).map((feature, i) => (
        <li key={i} title={feature} className="truncate">{feature}</li>
      ))}
      {features.length > 3 && <li className="text-gray-500 text-xs italic">+{features.length - 3} tane daha</li>}
    </ul>
  );
});
FeaturesCell.displayName = "FeaturesCell";

const BreadcrumbCell = memo(({ items }: { items?: BreadcrumbItem[] | null }) => {
  if (!items?.length) return <div className="text-gray-400 text-xs italic">Yok</div>;
  return (
    <ol className="flex flex-wrap text-xs text-gray-600" style={{listStyle:"none", paddingLeft:0}}>
      {items.map((item, index) => (
        <li key={index} className="flex items-center">
          {item.href ? (
            <a href={item.href} target="_blank" rel="noopener noreferrer" className="hover:underline" title={item.text}>
              {item.text}
            </a>
          ) : (
            <span title={item.text}>{item.text}</span>
          )}
          {index < items.length - 1 && <span className="mx-1">/</span>}
        </li>
      ))}
    </ol>
  );
});
BreadcrumbCell.displayName = "BreadcrumbCell";

const LinksCountCell = memo(({ navLinks, footerLinks }: { navLinks?: LinkItem[] | null, footerLinks?: LinkItem[] | null }) => {
  return (
    <div className="text-xs">
      <div>Nav: {navLinks?.length || 0}</div>
      <div>Footer: {footerLinks?.length || 0}</div>
    </div>
  );
});
LinksCountCell.displayName = "LinksCountCell";


export default function Home() {
  const [sitemapInputUrl, setSitemapInputUrl] = useState('');
  const [processedSitemapUrl, setProcessedSitemapUrl] = useState<string | null>(null);
  const [sitemapUrls, setSitemapUrls] = useState<string[]>([]);
  const [sitemapLoading, setSitemapLoading] = useState(false);
  const [sitemapError, setSitemapError] = useState('');

  const [analysisResults, setAnalysisResults] = useState<ScrapedPageData[]>([]);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState('');

  const [discoveringSelectorsLoading, setDiscoveringSelectorsLoading] = useState(false);
  const [discoveryMessage, setDiscoveryMessage] = useState('');
  const [discoveryError, setDiscoveryError] = useState('');

  const [currentScrapeId, setCurrentScrapeId] = useState<string | null>(null); // Added state for currentScrapeId

  const [siteWideNavLinks, setSiteWideNavLinks] = useState<LinkItem[] | null>(null);
  const [siteWideFooterLinks, setSiteWideFooterLinks] = useState<LinkItem[] | null>(null);

  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 50;

  function addLogClient(message: string) {
    console.log(`[CLIENT LOG] ${new Date().toLocaleTimeString()}: ${message}`);
  }

  const handleDiscoverSelectors = async () => {
    if (!sitemapInputUrl) {
      setDiscoveryError('Lütfen önce bir site URLsi girin (örn: https://example.com).');
      return;
    }
    setDiscoveringSelectorsLoading(true);
    setDiscoveryMessage('');
    setDiscoveryError('');
    addLogClient(`Otomatik seçici tespiti başlatılıyor: ${sitemapInputUrl}`);

    try {
      const res = await fetch('/api/discover-site-selectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteUrl: sitemapInputUrl })
      });

      const json = await res.json();
      if (res.ok) {
        setDiscoveryMessage(json.message || `Seçiciler ${json.hostname} için başarıyla tespit edildi/güncellendi.`);
        addLogClient(`Seçici tespiti başarılı: ${json.message}`);
        console.log("Keşfedilen Seçiciler:", json.discoveredSelectors || json.selectors);
      } else {
        setDiscoveryError(json.error || `Seçici tespiti sırasında hata (${res.status})`);
        logError(json, 'frontend-discoverSelectors-apiError', {url: sitemapInputUrl});
      }
    } catch (err: any) {
      setDiscoveryError('Seçici tespiti isteği sırasında kritik hata: ' + err.message);
      logError(err, 'frontend-discoverSelectors-fetchError', { url: sitemapInputUrl });
    } finally {
      setDiscoveringSelectorsLoading(false);
    }
  };

  const fetchSitemapAndAnalyze = async () => {
    if (!sitemapInputUrl) {
      setSitemapError('Lütfen bir sitemap URLsi veya site adresi girin.');
      return;
    }
    setSitemapLoading(true);
    setSitemapError('');
    setAnalysisResults([]);
    setSitemapUrls([]);
    setSiteWideNavLinks(null); // Reset site-wide links
    setSiteWideFooterLinks(null); // Reset site-wide links
    setProcessedSitemapUrl(null);
    setCurrentPage(1);
    setActiveFilter('all');
    setDiscoveryMessage('');
    setDiscoveryError('');
    setCurrentScrapeId(null); // Reset currentScrapeId

    let fetchedUrls: string[] = [];
    let actualSitemapForDisplay: string | null = null;

    try {
      const sitemapRes = await fetch(`/api/sitemap-parser`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sitemapUrl: sitemapInputUrl })
      });
      const sitemapJson = await sitemapRes.json();

      if (sitemapRes.ok && sitemapJson.urls && sitemapJson.urls.length > 0) {
        fetchedUrls = sitemapJson.urls;
        actualSitemapForDisplay = sitemapJson.actualSitemapUrl || sitemapInputUrl;
        setSitemapUrls(fetchedUrls);
        setProcessedSitemapUrl(actualSitemapForDisplay);
        addLogClient(`${fetchedUrls.length} URL sitemap'ten çekildi: ${actualSitemapForDisplay}`);
      } else {
        setSitemapError(sitemapJson.error || 'Sitemap boş veya URL bulunamadı.');
        setSitemapLoading(false);
        return;
      }
    } catch (err: any) {
      setSitemapError('Sitemap isteği sırasında kritik hata: ' + err.message);
      logError(err, 'frontend-fetchSitemap', { url: sitemapInputUrl });
      setSitemapLoading(false);
      return;
    } finally {
      setSitemapLoading(false);
    }

    if (fetchedUrls.length > 0) {
      analyzeIndividualUrls(fetchedUrls);
    }
  };

  const analyzeIndividualUrls = async (urlsToAnalyze: string[]) => {
    setAnalysisLoading(true);
    setAnalysisError('');
    // setAnalysisResults([]); // fetchSitemapAndAnalyze içinde zaten yapılıyor

    const BATCH_SIZE = 3; // AI API limitlerini düşünerek daha da düşürülebilir
    const DELAY_BETWEEN_BATCHES = 2000; // Batch'ler arası daha uzun bekleme
    const DELAY_PER_REQUEST = 6000; // Örnek: Gemini için 6 saniye

    for (let i = 0; i < urlsToAnalyze.length; i += BATCH_SIZE) {
      const batchUrls = urlsToAnalyze.slice(i, i + BATCH_SIZE);
      addLogClient(`Processing batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(urlsToAnalyze.length/BATCH_SIZE)} (URLs: ${batchUrls.length})`);

      const batchPromises = batchUrls.map(async (link, indexInBatch) => {
        try {
          addLogClient(`Analiz başlıyor: ${link}`);
          const res = await fetch('/api/scrape-ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: link,
                model: 'gemini', // veya 'openai' veya kullanıcı seçimi
            }),
          });
          if (!res.ok) {
            const errorData = await res.json().catch(() => ({error: `HTTP error ${res.status}`}));
            throw new Error(errorData.error || `API request failed with status ${res.status}`);
          }
          const data: ScrapedPageData = await res.json();
          console.log(`RAW API RESPONSE FOR [${link}]:`, JSON.stringify(data, null, 2));
          addLogClient(`Analiz tamamlandı: ${link} - Cheerio: ${data.pageTypeGuess}, AI: ${data.aiDetectedType}, Nav: ${data.navigationLinks?.length || 0}, Footer: ${data.footerLinks?.length || 0}`);
          
          if (indexInBatch < batchUrls.length -1 || (i + BATCH_SIZE < urlsToAnalyze.length)) {
             addLogClient(`Waiting ${DELAY_PER_REQUEST / 1000}s after processing ${link}...`);
             await new Promise(resolve => setTimeout(resolve, DELAY_PER_REQUEST));
          }
          return data;
        } catch (err: any) {
          addLogClient(`Analiz hatası: ${link} - ${err.message}`);
          logError(err, 'frontend-analyzeUrl-fetch', { url: link });
          // Hata durumunda döndürülen objeyi ScrapedPageData ile uyumlu hale getirin
          const errorData: ScrapedPageData = {
            url: link,
            error: 'Analysis failed',
            message: err.message,
            pageTypeGuess: 'error',
            aiDetectedType: 'client_error',
            title: 'N/A',
            metaDescription: 'N/A',
            price: 'N/A',
            currencySymbol: null,
            currencyCode: null,
            productCategory: null,
            category: 'N/A', // General category
            images: null, 
            features: null, 
            publishDate: null, 
            stockStatus: 'N/A',
            breadcrumbs: null, 
            navigationLinks: [], 
            footerLinks: [],
            blogPageCategories: null,
            aiExtractedData: null, // AI data would not be extracted in case of error
            // Fallback direct AI fields (if used elsewhere, provide defaults)
            aiProductBrand: null,
            aiProductSku: null,
            aiProductShortDescription: null,
            aiProductDescription: null,
            aiBlogAuthor: null,
            aiBlogTags: null,
            aiCategoryDescription: null,
          };
          return errorData;
        }
      });

      const currentBatchResults = await Promise.all(batchPromises);
      setAnalysisResults(prevResults => [...prevResults, ...currentBatchResults.filter(r => r !== null)]);

      if (i + BATCH_SIZE < urlsToAnalyze.length) {
        addLogClient(`Waiting ${DELAY_BETWEEN_BATCHES / 1000}s before next batch...`);
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
      }
    }
    setAnalysisLoading(false);
    addLogClient("Tüm URL analizleri tamamlandı.");
  };

  // This useEffect will populate siteWideNavLinks and siteWideFooterLinks
  // from the first successfully analyzed page that contains them.
  useEffect(() => {
    if (analysisResults.length > 0) {
      // Only update if not already set, to keep links from the *first* good page
      if (!siteWideNavLinks || siteWideNavLinks.length === 0) {
        const resultWithNav = analysisResults.find(r => r && !r.error && r.navigationLinks && r.navigationLinks.length > 0);
        if (resultWithNav && resultWithNav.navigationLinks) {
          setSiteWideNavLinks(resultWithNav.navigationLinks);
          addLogClient(`Site-wide navigation links set from: ${resultWithNav.url} (${resultWithNav.navigationLinks.length} links)`);
        }
      }
      if (!siteWideFooterLinks || siteWideFooterLinks.length === 0) {
        const resultWithFooter = analysisResults.find(r => r && !r.error && r.footerLinks && r.footerLinks.length > 0);
        if (resultWithFooter && resultWithFooter.footerLinks) {
          setSiteWideFooterLinks(resultWithFooter.footerLinks);
           addLogClient(`Site-wide footer links set from: ${resultWithFooter.url} (${resultWithFooter.footerLinks.length} links)`);
        }
      }
    }
  }, [analysisResults]); // Removed siteWideNavLinks & siteWideFooterLinks from dependency to avoid re-triggering unnecessarily

  const filteredAndSortedResults = useMemo(() => {
    let results = analysisResults;
    if (activeFilter !== 'all') {
      results = results.filter(item => (item.aiDetectedType || item.pageTypeGuess) === activeFilter);
    }
    return results.sort((a, b) => (a.url || "").localeCompare(b.url || ""));
  }, [analysisResults, activeFilter]);

  const paginatedResults = useMemo(() => {
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredAndSortedResults.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  }, [filteredAndSortedResults, currentPage, ITEMS_PER_PAGE]);

  const totalPages = Math.ceil(filteredAndSortedResults.length / ITEMS_PER_PAGE);

  const filterTypes: { label: string; value: string }[] = [
    { label: 'Tümü', value: 'all' },
    { label: 'Ürün', value: 'product' },
    { label: 'Blog Yazısı', value: 'blogPost' },
    { label: 'Blog Sayfası', value: 'blog' },
    { label: 'Kategori Sayfası', value: 'categoryPage' }, // Use 'categoryPage' to match AI
    { label: 'Genel Sayfa', value: 'page' },
    { label: 'Bilinmeyen', value: 'unknown' },
    { label: 'Hata', value: 'error' },
    { label: 'AI Hatası', value: 'ai_error' },
    { label: 'Client Hatası', value: 'client_error' },
  ];

  const exportToCSV = () => {
    if (filteredAndSortedResults.length === 0) {
      alert("Dışa aktarılacak veri yok.");
      return;
    }

    const headers = [
      "URL", "Tip (AI/Cheerio)", "Başlık", "Açıklama (Meta)", "Fiyat", "Kategori",
      "Görsel URLleri (İlk 3)", "Özellikler (İlk 3)", "Yayın Tarihi", "Stok Durumu",
      "Breadcrumbs", "Nav Link Sayısı", "Footer Link Sayısı",
      "AI: Algılanan Sayfa Tipi",
      "AI: Ürün Adı", "AI: Marka", "AI: SKU", "AI: Ürün Fiyatı", "AI: Ürün Para Birimi", "AI: Ürün Kısa Açıklama", "AI: Ürün Detaylı Açıklama", "AI: Ürün Kategorileri", "AI: Ürün Stok", "AI: Ürün Özellikleri",
      "AI: Blog Başlığı", "AI: Blog Yazarı", "AI: Blog Yayın Tarihi", "AI: Blog Özet", "AI: Blog Kategorileri", "AI: Blog Etiketleri",
      "AI: Kategori Adı", "AI: Kategori Açıklaması",
      "Hata Mesajı"
    ];

    const rows = filteredAndSortedResults.map(item => {
      const type = item.aiDetectedType || item.pageTypeGuess || 'N/A'; // Kept for raw type in CSV
      const title = item.aiExtractedData?.pageTitle || item.title || 'N/A';
      const description = item.aiExtractedData?.metaDescription || item.metaDescription || 'N/A';

      let priceDisplay = 'N/A';
      // Use effectiveType for price as well, if applicable, or ensure consistency
      const effectiveTypeForPrice = item.aiDetectedType || item.pageTypeGuess;
      if (effectiveTypeForPrice === 'product' || item.aiExtractedData?.productInfo) {
          const aiPrice = item.aiExtractedData?.productInfo?.price;
          const aiCurrency = item.aiExtractedData?.productInfo?.currency || item.currencyCode;
          const cheerioPrice = item.price;
          const cheerioCurrencySymbol = item.currencySymbol;
          if (aiPrice) priceDisplay = `${aiPrice} ${aiCurrency || ''}`.trim();
          else if (cheerioPrice) priceDisplay = `${cheerioPrice} ${cheerioCurrencySymbol || ''}`.trim();
      }

      let categoryDisplay = 'N/A';
      const effectiveType = item.aiDetectedType || item.pageTypeGuess;

      if (effectiveType === 'product') {
        categoryDisplay = item.aiExtractedData?.productInfo?.categoriesFromPage?.join(', ') || item.productCategory || item.category || 'N/A';
      } else if (effectiveType === 'blog' || effectiveType === 'blogPost') {
        categoryDisplay = item.aiExtractedData?.blogPostInfo?.categoriesFromPage?.join(', ') || item.blogPageCategories?.join(', ') || item.category || 'N/A';
      } else if (effectiveType === 'category' || effectiveType === 'categoryPage') {
        categoryDisplay = item.aiExtractedData?.categoryPageInfo?.categoryName || item.category || item.title || 'N/A';
      }

      const rawImagesInput = item.aiExtractedData?.productInfo?.images || item.aiExtractedData?.blogPostInfo?.images || item.images;
      console.log(`[ImageDebug] URL: ${item.url} - rawImagesInput:`, JSON.stringify(rawImagesInput, null, 2)); // EKLENDİ

      // DOĞRUDAN item.images KULLANMAYI DENE (EĞER API'DEN GELENLER ImageItem[] İSE)
      const imagesForTableCell: ImageItem[] | null = item.images || null;

      // VEYA EĞER item.aiExtractedData.productInfo.images string dizisi ise şunu dene:
      /*
      const imagesForTableCell: ImageItem[] | null = item.aiExtractedData?.productInfo?.images
          ? item.aiExtractedData.productInfo.images.map(srcStr => ({ src: srcStr, alt: title || 'Product Image', hasAlt: !!title }))
          : null;
      */

      console.log(`[ImageDebug] URL: ${item.url} - imagesForTableCell (direct from item.images):`, JSON.stringify(imagesForTableCell, null, 2));

      const featuresForCell = item.aiExtractedData?.productInfo?.features || item.features;
      const dateForCell = item.aiExtractedData?.blogPostInfo?.publishDate || item.publishDate;
      const stockForCell = item.aiExtractedData?.productInfo?.stockStatus || item.stockStatus;

      return [
        item.url, type, title, description, priceDisplay, categoryDisplay,
        imagesForTableCell?.map(img => img.src).slice(0, 3).join(' | ') || 'N/A',
        featuresForCell?.slice(0, 3).join(' | ') || 'N/A',
        formatDate(dateForCell), stockForCell || 'N/A',
        item.breadcrumbs?.map(b => b.text).join(' > ') || 'N/A',
        item.navigationLinks?.length || 0, item.footerLinks?.length || 0,
        item.aiExtractedData?.detectedPageType || 'N/A',
        item.aiExtractedData?.productInfo?.productName || 'N/A',
        item.aiExtractedData?.productInfo?.brand || item.aiProductBrand || 'N/A',
        item.aiExtractedData?.productInfo?.sku || item.aiProductSku || 'N/A',
        item.aiExtractedData?.productInfo?.price || 'N/A',
        item.aiExtractedData?.productInfo?.currency || 'N/A',
        item.aiExtractedData?.productInfo?.shortDescription || item.aiProductShortDescription || 'N/A',
        item.aiExtractedData?.productInfo?.detailedDescription || item.aiProductDescription || 'N/A',
        item.aiExtractedData?.productInfo?.categoriesFromPage?.join(', ') || 'N/A',
        item.aiExtractedData?.productInfo?.stockStatus || 'N/A',
        item.aiExtractedData?.productInfo?.features?.join(', ') || 'N/A',
        item.aiExtractedData?.blogPostInfo?.postTitle || 'N/A',
        item.aiExtractedData?.blogPostInfo?.author || item.aiBlogAuthor || 'N/A',
        formatDate(item.aiExtractedData?.blogPostInfo?.publishDate),
        item.aiExtractedData?.blogPostInfo?.summary || 'N/A',
        item.aiExtractedData?.blogPostInfo?.categoriesFromPage?.join(', ') || 'N/A',
        item.aiExtractedData?.blogPostInfo?.tags?.join(', ') || item.aiBlogTags?.join(', ') || 'N/A',
        item.aiExtractedData?.categoryPageInfo?.categoryName || 'N/A',
        item.aiExtractedData?.categoryPageInfo?.description || item.aiCategoryDescription || 'N/A',
        item.error || item.message || ''
      ].map(field => `"${String(field || '').replace(/"/g, '""')}"`).join(',');
    });

    const csvContent = "data:text/csv;charset=utf-8," + [headers.join(','), ...rows].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    const sitemapHostname = processedSitemapUrl ? new URL(processedSitemapUrl).hostname.replace(/\./g, '_') : "sitemap_analysis";
    link.setAttribute("download", `${sitemapHostname}_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    addLogClient("CSV dosyası dışa aktarıldı.");
  };

  return (
    <main style={{ padding: '2rem', fontFamily: 'Arial, sans-serif', color: '#333' }}>
      <div style={{maxWidth: '1600px', margin: '0 auto'}}>
        <h1 style={{fontSize: '28px', fontWeight: 'bold', marginBottom: '25px', textAlign: 'center', color: '#2c3e50'}}>
          Gelişmiş Site Analiz ve Veri Çıkarma Aracı
        </h1>

        <div style={{ marginBottom: '25px', display: 'flex', flexDirection: 'column', gap: '15px', padding: '20px', border: '1px solid #ddd', borderRadius: '8px', backgroundColor: '#f9f9f9' }}>
          <div style={{display: 'flex', gap: '10px', alignItems: 'center'}}>
            <input
              type="text"
              placeholder="https://example.com (Sitemap için) veya https://example.com/sitemap.xml"
              value={sitemapInputUrl}
              onChange={(e) => setSitemapInputUrl(e.target.value)}
              style={{ padding: '12px', border: '1px solid #ccc', borderRadius: '4px', flexGrow: 1, fontSize: '14px' }}
            />
            <button
              onClick={handleDiscoverSelectors}
              disabled={discoveringSelectorsLoading || sitemapLoading || analysisLoading || !sitemapInputUrl}
              title="Girilen site için CSS seçicilerini AI ile otomatik tespit etmeye çalışır."
              style={{ padding: '12px 18px', backgroundColor: (discoveringSelectorsLoading) ? '#ffc107' : '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: (discoveringSelectorsLoading || sitemapLoading || analysisLoading || !sitemapInputUrl) ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', fontSize: '14px' }}
            >
              {discoveringSelectorsLoading ? 'Seçiciler Keşfediliyor...' : 'Seçicileri Keşfet (AI Bot)'}
            </button>
          </div>
          <button
            onClick={fetchSitemapAndAnalyze}
            disabled={sitemapLoading || analysisLoading || !sitemapInputUrl}
            style={{ padding: '12px 18px', backgroundColor: (sitemapLoading || analysisLoading) ? '#aaa' : '#007bff', color: 'white', border: 'none', borderRadius: '4px', cursor: (sitemapLoading || analysisLoading || !sitemapInputUrl) ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', fontSize: '14px', width: '100%' }}
          >
            {sitemapLoading ? 'Sitemap Okunuyor...' : (analysisLoading ? `Analiz Ediliyor (${analysisResults.length}/${sitemapUrls.length})...` : 'Site Haritasını Getir ve Tüm URLleri Analiz Et')}
          </button>
        </div>

        {sitemapError && <p style={{ color: 'red', textAlign:'center', marginBottom:'10px' }}>Sitemap Hatası: {sitemapError}</p>}
        {discoveryError && <p style={{ color: 'red', textAlign:'center', marginBottom:'10px' }}>Seçici Keşfi Hatası: {discoveryError}</p>}
        {discoveryMessage && <p style={{ color: 'green', textAlign:'center', marginBottom:'10px' }}>{discoveryMessage}</p>}
        {analysisError && <p style={{ color: 'red', textAlign:'center', marginBottom:'10px' }}>Analiz Hatası: {analysisError}</p>}

        {currentScrapeId && (
          <div style={{ marginTop: '20px', padding: '15px', border: '1px solid #ccc', borderRadius: '4px', backgroundColor: '#e9f7ef' }}>
            <h3 style={{ marginTop: 0, marginBottom: '10px', fontSize: '16px' }}>Ürün Feed URL'leri:</h3>
            <p style={{ margin: '5px 0', fontSize: '14px' }}>
              <strong>XML Feed:</strong> <a href={`/api/generate-product-feed/${currentScrapeId}?format=xml`} target="_blank" rel="noopener noreferrer">{`/api/generate-product-feed/${currentScrapeId}?format=xml`}</a>
            </p>
            <p style={{ margin: '5px 0', fontSize: '14px' }}>
              <strong>JSON Feed:</strong> <a href={`/api/generate-product-feed/${currentScrapeId}?format=json`} target="_blank" rel="noopener noreferrer">{`/api/generate-product-feed/${currentScrapeId}?format=json`}</a>
            </p>
            <p style={{fontSize: '12px', color: '#555'}}>
              Bu URL'leri <a href="https://xmlfeedgenerator.com" target="_blank" rel="noopener noreferrer">xmlfeedgenerator.com</a> gibi platformlara yükleyebilirsiniz.
            </p>
          </div>
        )}

        {processedSitemapUrl && !sitemapLoading && (
          <div style={{ margin: '10px 0 20px 0', fontSize: '12px', color: '#555', textAlign: 'center', padding: '8px', backgroundColor: '#f0f0f0', borderRadius: '4px' }}>
            İşlenen Sitemap: <a href={processedSitemapUrl} target="_blank" rel="noopener noreferrer" style={{color: '#007bff', fontWeight:'bold'}}>{processedSitemapUrl}</a> ({sitemapUrls.length} URL bulundu)
          </div>
        )}
        
        {/* +++ SITE-WIDE LINKS SECTION RE-ADDED +++ */}
        {(siteWideNavLinks || siteWideFooterLinks) && !sitemapLoading && analysisResults.length > 0 && (
          <div style={{ marginTop: '2rem', padding: '1rem', border: '1px solid #e0e0e0', borderRadius: '8px', backgroundColor: '#f9f9f9', marginBottom: '2rem' }}>
            <h2 style={{fontSize: '18px', fontWeight: '600', marginBottom: '10px'}}>Site Geneli Linkler (İlk Geçerli Analizden)</h2>
            {siteWideNavLinks && siteWideNavLinks.length > 0 && (
              <div style={{marginBottom: '1rem'}}>
                <h3 style={{fontSize: '14px', fontWeight: 'bold'}}>Navigasyon Linkleri ({siteWideNavLinks.length})</h3>
                <ul style={{ maxHeight: '150px', overflowY: 'auto', listStyle: 'disc inside', paddingLeft: '20px', fontSize: '12px' }}>
                  {siteWideNavLinks.map((link, i) => (
                    <li key={`nav-${i}`} style={{marginBottom: '4px'}}>
                      <a href={link.href} target="_blank" rel="noopener noreferrer" style={{color: '#0056b3', textDecoration: 'none'}} title={link.href}>
                        {link.text} {link.isExternal && <span style={{color: '#777', fontStyle: 'italic'}}>(Dış Link)</span>}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {siteWideFooterLinks && siteWideFooterLinks.length > 0 && (
              <div>
                <h3 style={{fontSize: '14px', fontWeight: 'bold'}}>Footer Linkleri ({siteWideFooterLinks.length})</h3>
                <ul style={{ maxHeight: '150px', overflowY: 'auto', listStyle: 'disc inside', paddingLeft: '20px', fontSize: '12px' }}>
                  {siteWideFooterLinks.map((link, i) => (
                    <li key={`footer-${i}`} style={{marginBottom: '4px'}}>
                      <a href={link.href} target="_blank" rel="noopener noreferrer" style={{color: '#0056b3', textDecoration: 'none'}} title={link.href}>
                        {link.text} {link.isExternal && <span style={{color: '#777', fontStyle: 'italic'}}>(Dış Link)</span>}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(!siteWideNavLinks || siteWideNavLinks.length === 0) && (!siteWideFooterLinks || siteWideFooterLinks.length === 0) && (
              <p style={{fontSize: '12px', color: '#666'}}>Site geneli navigasyon veya footer linki bulunamadı veya henüz işlenmedi.</p>
            )}
          </div>
        )}
        {/* +++ END OF SITE-WIDE LINKS SECTION +++ */}


        {analysisResults.length > 0 && !sitemapLoading && (
          <>
            <div style={{ margin: '20px 0', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', paddingBottom: '10px', borderBottom: '1px solid #eee' }}>
              <span style={{fontSize: '13px', fontWeight: 'bold', marginRight: '10px'}}>Filtrele:</span>
              {filterTypes.map(filter => (
                <button
                  key={filter.value}
                  onClick={() => { setActiveFilter(filter.value); setCurrentPage(1); }}
                  style={{
                    padding: '6px 10px',
                    border: '1px solid #007bff',
                    borderRadius: '4px',
                    backgroundColor: activeFilter === filter.value ? '#007bff' : 'white',
                    color: activeFilter === filter.value ? 'white' : '#007bff',
                    cursor: 'pointer',
                    fontSize: '11px',
                    fontWeight: activeFilter === filter.value ? 'bold' : 'normal'
                  }}
                >
                  {filter.label}
                </button>
              ))}
              <button 
                onClick={exportToCSV} 
                disabled={filteredAndSortedResults.length === 0}
                style={{ padding: '6px 12px', backgroundColor: filteredAndSortedResults.length === 0 ? '#ccc' : '#28a745', color: 'white', border: 'none', borderRadius: '4px', cursor: filteredAndSortedResults.length === 0 ? 'not-allowed' : 'pointer', fontSize: '11px', marginLeft: 'auto' }} 
              >
                CSV İndir ({filteredAndSortedResults.length})
              </button>
            </div>

            <div style={{ marginTop: '1rem', overflowX: 'auto' }}>
              <h2 style={{fontSize: '18px', fontWeight: '600', marginBottom: '10px'}}>
                Analiz Sonuçları ({activeFilter === 'all' ? 'Tümü' : filterTypes.find(f=>f.value===activeFilter)?.label}) - {filteredAndSortedResults.length} adet
              </h2>
              <table style={{ width: '100%', minWidth: '1800px', borderCollapse: 'collapse', fontSize: '11px' }}>
                <thead style={{backgroundColor: '#f0f0f0', position: 'sticky', top: 0, zIndex: 1}}>
                  <tr>
                    {["URL", "Tip (AI/Ch)", "Başlık", "Açıklama", "Fiyat", "Kategori", "Görseller", "Özellikler", "Tarih", "Stok", "Breadcrumbs", "Nav/Ftr Links"].map(headerText => (
                      <th key={headerText} style={{ padding: '8px', border: '1px solid #ddd', textAlign: 'left', fontWeight: 'bold', whiteSpace: 'nowrap' }}>{headerText}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paginatedResults.map((item, i) => {
                    const effectiveType = item.aiDetectedType || item.pageTypeGuess; // Use AI detected type if available
                    const displayType = item.aiDetectedType ? `${item.aiDetectedType} (AI)` : (item.pageTypeGuess ? `${item.pageTypeGuess} (Ch)` : 'N/A');
                    const title = item.aiExtractedData?.pageTitle || item.title || 'N/A';
                    const description = item.aiExtractedData?.metaDescription || item.metaDescription || 'N/A';

                    let priceDisplay = 'N/A';
                    if (effectiveType === 'product' || item.aiExtractedData?.productInfo) {
                        const aiPrice = item.aiExtractedData?.productInfo?.price;
                        const aiCurrency = item.aiExtractedData?.productInfo?.currency || item.currencyCode;
                        const cheerioPrice = item.price;
                        const cheerioCurrencySymbol = item.currencySymbol;
                        if (aiPrice) priceDisplay = `${aiPrice} ${aiCurrency || ''}`.trim();
                        else if (cheerioPrice) priceDisplay = `${cheerioPrice} ${cheerioCurrencySymbol || ''}`.trim();
                    }

                    let categoryDisplay = 'N/A';
                    // const effectiveType = item.aiDetectedType || item.pageTypeGuess; // Already defined above

                    if (effectiveType === 'product') {
                      categoryDisplay = item.aiExtractedData?.productInfo?.categoriesFromPage?.join(', ') || item.productCategory || item.category || 'N/A';
                    } else if (effectiveType === 'blog' || effectiveType === 'blogPost') {
                      categoryDisplay = item.aiExtractedData?.blogPostInfo?.categoriesFromPage?.join(', ') || item.blogPageCategories?.join(', ') || item.category || 'N/A';
                    } else if (effectiveType === 'category' || effectiveType === 'categoryPage') {
                      categoryDisplay = item.aiExtractedData?.categoryPageInfo?.categoryName || item.category || item.title || 'N/A';
                    }
                    
                    const rawImagesInput = item.aiExtractedData?.productInfo?.images || item.aiExtractedData?.blogPostInfo?.images || item.images;
                    console.log(`[ImageDebug] URL: ${item.url} - rawImagesInput:`, JSON.stringify(rawImagesInput, null, 2)); // EKLENDİ

                    // DOĞRUDAN item.images KULLANMAYI DENE (EĞER API'DEN GELENLER ImageItem[] İSE)
                    const imagesForTableCell: ImageItem[] | null = item.images || null;

                    // VEYA EĞER item.aiExtractedData.productInfo.images string dizisi ise şunu dene:
                    /*
                    const imagesForTableCell: ImageItem[] | null = item.aiExtractedData?.productInfo?.images
                        ? item.aiExtractedData.productInfo.images.map(srcStr => ({ src: srcStr, alt: title || 'Product Image', hasAlt: !!title }))
                        : null;
                    */

                    console.log(`[ImageDebug] URL: ${item.url} - imagesForTableCell (direct from item.images):`, JSON.stringify(imagesForTableCell, null, 2));

                    const featuresForCell = item.aiExtractedData?.productInfo?.features || item.features;
                    const dateForCell = item.aiExtractedData?.blogPostInfo?.publishDate || item.publishDate;
                    const stockForCell = item.aiExtractedData?.productInfo?.stockStatus || item.stockStatus;

                    return (
                      <tr key={item.url + i} style={{ borderBottom: '1px solid #ddd', backgroundColor: i % 2 === 0 ? 'white' : '#f9f9f9' }}>
                        <td style={{padding: '6px', border: '1px solid #ddd', wordBreak: 'break-all', maxWidth: '250px', verticalAlign: 'top'}}>
                          <a href={item.url} target="_blank" rel="noopener noreferrer" style={{color: '#007bff', textDecoration: 'none'}} title={item.url}>{item.url}</a>
                          {item.error && <div style={{color: 'red', fontSize: '10px', marginTop: '4px', whiteSpace: 'normal'}}>Hata: {item.message || item.error}</div>}
                        </td>
                        <td style={{padding: '6px', border: '1px solid #ddd', verticalAlign: 'top', textAlign: 'center', whiteSpace: 'nowrap'}}>{displayType}</td>
                        <td style={{padding: '6px', border: '1px solid #ddd', minWidth: '200px', maxWidth: '300px', verticalAlign: 'top', whiteSpace: 'normal'}}>{title}</td>
                        <td style={{padding: '6px', border: '1px solid #ddd', maxWidth: '250px', verticalAlign: 'top'}} title={description}>
                            <div style={{maxHeight: '60px', overflow: 'hidden', textOverflow: 'ellipsis'}}>{description}</div>
                        </td>
                        <td style={{padding: '6px', border: '1px solid #ddd', verticalAlign: 'top', textAlign: 'right', whiteSpace: 'nowrap'}}>{priceDisplay}</td>
                        <td style={{padding: '6px', border: '1px solid #ddd', verticalAlign: 'top', whiteSpace: 'normal', minWidth: '150px'}}>{categoryDisplay}</td>
                        <td style={{padding: '6px', border: '1px solid #ddd', verticalAlign: 'top'}}><ImageCell images={imagesForTableCell} pageTitle={title}/></td>
                        <td style={{padding: '6px', border: '1px solid #ddd', verticalAlign: 'top', minWidth: '150px'}}><FeaturesCell features={featuresForCell} /></td>
                        <td style={{padding: '6px', border: '1px solid #ddd', verticalAlign: 'top', textAlign: 'center', whiteSpace: 'nowrap'}}>{formatDate(dateForCell)}</td>
                        <td style={{padding: '6px', border: '1px solid #ddd', verticalAlign: 'top', textAlign: 'center', whiteSpace: 'nowrap'}}>{stockForCell || 'N/A'}</td>
                        <td style={{padding: '6px', border: '1px solid #ddd', verticalAlign: 'top', minWidth: '200px'}}><BreadcrumbCell items={item.breadcrumbs} /></td>
                        <td style={{padding: '6px', border: '1px solid #ddd', verticalAlign: 'top', textAlign: 'center'}}><LinksCountCell navLinks={item.navigationLinks} footerLinks={item.footerLinks} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {totalPages > 1 && (
                <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '10px', paddingBottom: '20px' }}>
                  <button
                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                    disabled={currentPage === 1}
                    style={{ padding: '8px 12px', border: '1px solid #ccc', borderRadius: '4px', cursor: 'pointer', backgroundColor: currentPage === 1 ? '#e9ecef' : 'white', fontSize: '13px' }}
                  >
                    Önceki
                  </button>
                  <span style={{fontSize: '14px'}}>
                    Sayfa {currentPage} / {totalPages}
                  </span>
                  <button
                    onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                    disabled={currentPage === totalPages}
                    style={{ padding: '8px 12px', border: '1px solid #ccc', borderRadius: '4px', cursor: 'pointer', backgroundColor: currentPage === totalPages ? '#e9ecef' : 'white', fontSize: '13px' }}
                  >
                    Sonraki
                  </button>
                </div>
              )}
            </div>
          </>
        )}
        {(sitemapLoading || analysisLoading) && (
            <div style={{marginTop: '30px', textAlign: 'center', padding: '20px', backgroundColor: '#f0f8ff', borderRadius: '8px'}}>
                <p style={{fontSize: '16px', fontWeight: 'bold', color: '#0056b3'}}>
                    {sitemapLoading ? 'Sitemap URLleri okunuyor...' : `URLler analiz ediliyor (${analysisResults.length} / ${sitemapUrls.length})... Lütfen bekleyin.`}
                </p>
                {(analysisLoading && sitemapUrls.length > 0 && sitemapUrls.length >= analysisResults.length) && ( // Added check for sitemapUrls.length >= analysisResults.length
                    <div style={{width: '80%', margin: '10px auto', backgroundColor: '#e9ecef', borderRadius: '4px', overflow: 'hidden'}}>
                        <div style={{
                            width: `${sitemapUrls.length > 0 ? (analysisResults.length / sitemapUrls.length) * 100 : 0}%`, // Added check for sitemapUrls.length > 0
                            height: '20px',
                            backgroundColor: '#28a745',
                            transition: 'width 0.3s ease-in-out',
                            textAlign: 'center',
                            color: 'white',
                            lineHeight: '20px',
                            fontSize: '12px'
                        }}>
                            {sitemapUrls.length > 0 ? Math.round((analysisResults.length / sitemapUrls.length) * 100) : 0}%
                        </div>
                    </div>
                )}
            </div>
        )}
        { !sitemapLoading && !analysisLoading && sitemapUrls.length > 0 && analysisResults.length === 0 && !sitemapError && !analysisError && !discoveryError && !discoveryMessage && (
            <div style={{marginTop: '30px', textAlign: 'center', padding: '20px', backgroundColor: '#fff3cd', borderRadius: '8px', color: '#856404'}}>
                <p>Sitemap URL'leri yüklendi ancak henüz analiz sonucu yok veya analizler tamamlanamadı.</p>
            </div>
        )}
         { !sitemapLoading && !analysisLoading && sitemapUrls.length === 0 && !sitemapError && !analysisError && !discoveryError && !discoveryMessage && ( // Added sitemapError and analysisError checks
            <div style={{marginTop: '30px', textAlign: 'center', padding: '20px', backgroundColor: '#d4edda', borderRadius: '8px', color: '#155724'}}>
                <p>Henüz hiçbir URL işlenmedi. Lütfen yukarıdaki alanı kullanarak bir sitemap URL'si girin ve "Site Haritasını Getir ve Analiz Et" butonuna tıklayın.</p>
            </div>
        )}
      </div>
    </main>
  );
}
