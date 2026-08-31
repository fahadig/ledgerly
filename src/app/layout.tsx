import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ledgerly — AI-assisted accounting',
  description: 'Double-entry accounting with an assistant that reasons from IFRS and US GAAP.',
};

export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
