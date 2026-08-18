/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Linting and type checking are separate CI steps (`pnpm lint`,
  // `pnpm typecheck`); running them again inside `next build` doubles the
  // work and hides which step actually failed.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  // The inbox never touches the database directly — it calls the API with the
  // staff session cookie (ARCHITECTURE.md §8).
  env: {},
};

export default nextConfig;
