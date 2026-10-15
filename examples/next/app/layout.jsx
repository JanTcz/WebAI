import { WebaiScript } from '@jantcz/webai/next/script';
import './globals.css';

export const metadata = { title: 'Studio Lumen', description: 'A small photography studio.' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <WebaiScript />
      </body>
    </html>
  );
}
