import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Sema staff inbox",
  description: "Shared inbox and calendar for clinic front-desk staff.",
  // The inbox handles patient data; keep it out of search indexes entirely.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Staff work from phones; never block them from zooming a message thread.
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <html lang="en" suppressHydrationWarning>
      {/* System font stack: no next/font/google call, so builds and the app
          itself work offline and on a slow Nairobi connection. */}
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
