import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfig, AppConfigService } from './app-config.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    AppConfigService,
    {
      provide: AppConfig,
      useExisting: AppConfigService,
    },
  ],
  exports: [AppConfigService, AppConfig],
})
export class AppConfigModule {}
