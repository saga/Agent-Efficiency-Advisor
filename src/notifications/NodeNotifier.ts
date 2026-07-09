import nodeNotifier from 'node-notifier';
import type { Alert } from '../types.js';
import type { Notifier } from './Notifier.js';

export class NodeNotifier implements Notifier {
  notify(alert: Alert): void {
    nodeNotifier.notify({
      title: `Agent Efficiency: ${alert.severity}`,
      message: alert.message,
      sound: alert.severity === 'critical',
    });
  }
}
