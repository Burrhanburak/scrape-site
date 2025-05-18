import { NextRequest, NextResponse } from 'next/server';
import { addLog, logError } from '@/lib/logger';
import { withCors } from '@/lib/cors';
import { fetchAndParseSitemap,tryAlternativeSitemapUrls } from '@/lib/scraper-utils'; // Updated import path

export const POST = withCors(async function POST(req: NextRequest) {
  const requestId = Math.random().toString(36).substring(2, 10);
  const { sitemapUrl: initialSitemapUrl } = await req.json();

  if (!initialSitemapUrl) {
    return NextResponse.json({ error: 'sitemapUrl parameter is required' }, { status: 400 });
  }
  addLog(`Sitemap processing request received for: ${initialSitemapUrl}`, { context: 'sitemap-parser-endpoint', data: { requestId }});

  try {
    const uniqueUrls = await fetchAndParseSitemap(initialSitemapUrl);

    if (!uniqueUrls || uniqueUrls.length === 0) {
      addLog(`No URLs found or error in sitemap: ${initialSitemapUrl}`, { context: 'sitemap-parser-endpoint', data: { requestId }, level: 'warn' });
      return NextResponse.json({ error: 'Sitemap boş veya erişilemiyor.', urls: [], actualSitemapUrl: initialSitemapUrl }, { status: 200 });
    }

    addLog(`Found ${uniqueUrls.length} unique URLs from sitemap: ${initialSitemapUrl}`, { context: 'sitemap-parser-endpoint', data: { requestId, count: uniqueUrls.length }});
    return NextResponse.json({ urls: uniqueUrls, actualSitemapUrl: initialSitemapUrl });
  } catch (error: any) {
    logError(error, 'sitemap-parser-main-error', { context: 'sitemap-parser-endpoint', data: { requestId, initialSitemapUrl, message: error.message }});
    return NextResponse.json({ error: 'Failed to process sitemap.', details: error.message }, { status: 500 });
  }
});