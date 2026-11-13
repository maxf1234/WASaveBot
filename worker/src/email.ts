/**
 * The one email the service sends: "your WhatsApp was disconnected".
 * Sent through Resend's REST API. Optional: with no RESEND_API_KEY the
 * worker runs normally and simply does not email.
 */

import { errorMessage, log } from './log.js';

export interface Mailer {
  sendLoggedOut(to: string): Promise<void>;
}

export function createMailer(config: {
  apiKey?: string;
  from?: string;
  appName: string;
  webUrl: string;
  fetchImpl?: typeof fetch;
}): Mailer {
  const send = config.fetchImpl ?? fetch;
  return {
    async sendLoggedOut(to) {
      if (!config.apiKey || !config.from) return;
      try {
        const res = await send('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            from: config.from,
            to,
            subject: `${config.appName} was disconnected from your WhatsApp`,
            text: [
              `${config.appName} is no longer linked to your WhatsApp, so new contacts are not being saved.`,
              '',
              'This happens when the device is removed under WhatsApp > Linked devices, or when WhatsApp signs it out.',
              '',
              `To reconnect, open ${config.webUrl}/dashboard and press Connect.`,
            ].join('\n'),
          }),
        });
        if (!res.ok) log.warn('disconnect email was rejected', { status: res.status });
      } catch (error) {
        // Never let an email problem affect the session handling that called us.
        log.warn('disconnect email failed', { error: errorMessage(error) });
      }
    },
  };
}
