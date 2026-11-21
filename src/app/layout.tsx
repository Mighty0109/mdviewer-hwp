import type { Metadata } from 'next';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import './globals.css';
import '@/styles/editor.css';
import 'katex/dist/katex.min.css';

export const metadata: Metadata = { title: 'MDViewer' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body><ErrorBoundary>{children}</ErrorBoundary></body>
    </html>
  );
}
