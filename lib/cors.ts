import { NextRequest, NextResponse } from 'next/server';

export function withCors(handler: (req: NextRequest) => Promise<NextResponse>) {
  return async (req: NextRequest) => {
    // Handle CORS preflight requests
    if (req.method === 'OPTIONS') {
      return new NextResponse(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',  // Or specify specific domains
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Call the actual API handler
    const response = await handler(req);

    // Add CORS headers to the response
    response.headers.set('Access-Control-Allow-Origin', '*');
    return response;
  };
}
