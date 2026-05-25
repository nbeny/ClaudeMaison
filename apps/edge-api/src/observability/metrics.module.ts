import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';

// Global pour éviter de l'importer dans chaque feature module qui veut juste
// incrémenter un counter. Les métriques sont par nature transverses.
@Global()
@Module({
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
