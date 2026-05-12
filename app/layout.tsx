import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Breeze Bot Tester',
  description: 'Automated frontend testing for Breeze Payments API integration',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
