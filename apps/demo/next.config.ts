import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@vercel/sandbox"],
  transpilePackages: [
    "@llm-fuse/core",
    "@llm-fuse/cli",
    "@llm-fuse/provider-jsonplaceholder",
  ],
};

export default nextConfig;
