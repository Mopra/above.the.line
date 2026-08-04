import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Above the line',
  description:
    'Holds BTC while the close is above its long moving average, sits in cash below it.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
