export interface UrlValidationOptions {
  protocols?: string[];
  require_protocol?: boolean;
  [key: string]: any;
}

export function getUrlValidationOptions(): UrlValidationOptions {
  return {
    protocols: process.env.NODE_ENV === 'development' ? ['http', 'https'] : ['https'],
    require_protocol: true,
  };
}
