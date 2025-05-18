/**
 * Utility for standardized logging and debug information
 * Used for API endpoint debugging
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogOptions {
  level?: LogLevel;
  context?: string;
  data?: any;
}

/**
 * Adds a standardized log entry with timestamp, context, and formatted data
 */
export function addLog(message: string, options: LogOptions = {}) {
  const { level = 'info', context = 'general', data = null } = options;
  
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [${context}]`;
  
  switch (level) {
    case 'error':
      console.error(`${prefix} ${message}`, data ? data : '');
      break;
    case 'warn':
      console.warn(`${prefix} ${message}`, data ? data : '');
      break;
    case 'debug':
      console.debug(`${prefix} ${message}`, data ? data : '');
      break;
    default:
      console.log(`${prefix} ${message}`, data ? data : '');
  }
}

/**
 * Logs error details in a standardized format
 */
export function logError(error: any, context: string = 'unknown') {
  addLog('Error occurred', {
    level: 'error',
    context,
    data: {
      message: error.message || 'Unknown error',
      name: error.name || typeof error,
      code: error.code,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      response: error.response ? {
        status: error.response.status,
        statusText: error.response.statusText,
        headers: error.response.headers,
      } : undefined
    }
  });
}

/**
 * Formats an object for better logging
 */
export function formatData(data: any): string {
  if (!data) return '';
  
  try {
    return JSON.stringify(data, null, 2);
  } catch (error) {
    return String(data);
  }
}
