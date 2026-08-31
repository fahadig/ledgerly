/** @type {import('next').NextConfig} */
const nextConfig = {
  // Not 'standalone': the container applies its own schema and seeds itself on
  // first start, which needs drizzle-kit and tsx — both stripped by tracing.
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
