import nextConfig from "@folio/eslint-config/next";

export default [
  ...nextConfig,
  { ignores: [".next/"] },
  {
    files: ["**/*.test.{ts,tsx}", "**/test/**/*.{ts,tsx}"],
    rules: {
      "react/display-name": "off",
    },
  },
];
