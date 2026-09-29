import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next.js inline bootstrap scripts; no third-party script origins.
      // chrome-extension:/moz-extension: lets browser wallets inject their provider script.
      "script-src 'self' 'unsafe-inline' chrome-extension: moz-extension:" + (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""),
      "style-src 'self' 'unsafe-inline'",
      // Wallet icons on the payment page come from wallet providers.
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      // Wallet checkout talks to public chain RPCs from the browser.
      "connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:* ws://localhost:*",
      // Email checkout (Dynamic embedded wallets) signs in inside Dynamic's own frames.
      "frame-src 'self' https://*.dynamicauth.com https://*.dynamic.xyz",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join("; ")
  }
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  poweredByHeader: false,
  // Hide the Next.js dev-mode badge so local demos look like the real product.
  devIndicators: false,
  transpilePackages: ["@setra/schemas"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  webpack(config) {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  }
};

export default nextConfig;
