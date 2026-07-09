import type { Alert } from '../types.js';

export interface Notifier {
  notify(alert: Alert): void;
}

export class ConsoleNotifier implements Notifier {
  notify(alert: Alert): void {
    const icon = alert.severity === 'critical' ? '❌' : alert.severity === 'warning' ? '⚠️' : 'ℹ️';
    console.log(`\n${icon} [${alert.severity.toUpperCase()}] ${alert.message}`);
  }
}
