import { defineConfig } from "vite";
export default defineConfig(({ command }) => ({
  base: "/placidway-knowledge-chatbot/",
  plugins:
    command === "serve"
      ? [
          {
            name: "dev-style-injection",
            transformIndexHtml: (html) =>
              html.replace(
                "style-src 'self'",
                "style-src 'self' 'unsafe-inline'",
              ),
          },
        ]
      : [],
}));
