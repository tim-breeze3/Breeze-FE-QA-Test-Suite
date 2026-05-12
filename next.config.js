/** @type {import('next').NextConfig} */
const nextConfig = {
  // Railway runs a full Node.js server — no serverless function limits
  experimental: {
    serverComponentsExternalPackages: ['playwright-core', 'googleapis'],
  },
  // No response limit needed — Railway handles full streaming
  api: {
    responseLimit: false,
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

module.exports = nextConfig;
