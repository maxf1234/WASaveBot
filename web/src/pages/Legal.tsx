import type { ReactNode } from 'react';
import { APP_NAME } from '../brand';
import { Card } from '../components/ui';

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      <div className="space-y-3 text-sm leading-relaxed text-slate-700">{children}</div>
    </Card>
  );
}

/** The three statements both pages must make. */
function Disclosures() {
  return (
    <>
      <p>
        <strong>Not affiliated with WhatsApp.</strong> {APP_NAME} is an independent service. It is not affiliated with,
        endorsed by or sponsored by WhatsApp or Meta.
      </p>
      <p>
        <strong>Unofficial connection.</strong> {APP_NAME} connects to your account as a linked device using an
        unofficial connection, not an official WhatsApp API. WhatsApp may restrict, suspend or ban accounts that use
        unofficial connections.
      </p>
      <p>
        <strong>What is stored.</strong> {APP_NAME} stores the names and phone numbers of people who message you, so it
        can save them as contacts and show you the list.
      </p>
    </>
  );
}

export function Terms() {
  return (
    <Page title="Terms">
      <Disclosures />
      <p>
        <strong>The service.</strong> While your subscription is active and your WhatsApp is linked, {APP_NAME} saves
        new people who message you privately as contacts. It does not send messages, read receipts or online status
        from your account.
      </p>
      <p>
        <strong>Your responsibility.</strong> You use the service at your own risk, including the risk that WhatsApp
        restricts your account. You are responsible for having a lawful reason to keep the contact details of the
        people who message you.
      </p>
      <p>
        <strong>Billing.</strong> The subscription renews monthly until you cancel. You can cancel any time from the
        Billing page; saving stops when the subscription ends.
      </p>
      <p>
        <strong>No warranty.</strong> The service is provided as is, without any guarantee that every contact will be
        saved or that the connection will stay available.
      </p>
    </Page>
  );
}

export function Privacy() {
  return (
    <Page title="Privacy">
      <Disclosures />
      <p>
        <strong>Also stored.</strong> Your email address, your subscription status, your settings and the login keys
        for the linked WhatsApp device. Payments are handled by Stripe; card details never reach {APP_NAME}.
      </p>
      <p>
        <strong>Not stored.</strong> The content of your messages is not saved. Messages are only looked at to see who
        sent them.
      </p>
      <p>
        <strong>Deleting your data.</strong> Disconnecting removes the WhatsApp login keys. Deleting your account from
        Settings removes everything held about you, including the list of saved contacts. Contacts already saved in
        WhatsApp or on your phone stay there until you delete them yourself.
      </p>
    </Page>
  );
}
