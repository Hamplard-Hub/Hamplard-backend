import { IsUrlOptions } from 'class-validator';

export function getUrlValidationOptions(): IsUrlOptions {
  return {
    protocols: process.env.NODE_ENV === 'development' ? ['http', 'https'] : ['https'],
    require_protocol: true,
  };
}
