import type { Metadata } from "next";
// Self-hosted Inter and EB Garamond; sets --font-inter and --font-eb-garamond.
import "./fonts/fonts.css";
import "./globals.css";
import { Providers } from "@/app/components/providers";

export const metadata: Metadata = {
    metadataBase: new URL("https://app.mikeoss.com"),
    title: "Spectre - Legal AI for Bangladesh",
    description:
        "AI legal assistant for Bangladeshi lawyers and in-house teams: document review, drafting in Bangla and English, and contract playbooks.",
    icons: {
        icon: [
            { url: "/icon.svg", type: "image/svg+xml" },
            { url: "/favicon.ico" },
        ],
        apple: "/apple-touch-icon.png",
    },
    openGraph: {
        type: "website",
        url: "https://app.mikeoss.com",
        siteName: "Spectre",
        title: "Spectre - Legal AI for Bangladesh",
        description:
            "AI legal assistant for Bangladeshi lawyers and in-house teams: document review, drafting in Bangla and English, and contract playbooks.",
        images: [
            {
                url: "/link-image.jpg",
                width: 1200,
                height: 651,
                alt: "Spectre",
            },
        ],
    },
    twitter: {
        card: "summary_large_image",
        title: "Spectre - Legal AI for Bangladesh",
        description:
            "AI legal assistant for Bangladeshi lawyers and in-house teams: document review, drafting in Bangla and English, and contract playbooks.",
        images: ["/link-image.jpg"],
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body
                className="font-sans antialiased"
            >
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
