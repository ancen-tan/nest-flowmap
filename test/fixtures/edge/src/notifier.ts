export interface Notifier {
  notify(orderId: number): Promise<void>;
}

export class SmsNotifier implements Notifier {
  async notify(orderId: number): Promise<void> {}
}

export class EmailNotifier implements Notifier {
  async notify(orderId: number): Promise<void> {}
}
