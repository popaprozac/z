import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import zGrammar from "../editors/vscode/syntaxes/z.tmLanguage.json" with {
  type: "json",
};

export default defineConfig({
  output: "static",
  markdown: {
    shikiConfig: {
      langs: [{ ...zGrammar, id: "z", aliases: ["zs", "zd"] }],
    },
  },
  integrations: [
    starlight({
      title: "Z",
      description:
        "A native systems language with TypeScript-inspired syntax, memory-safe ownership, and direct C-family interop.",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/popaprozac/z",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/popaprozac/z/edit/main/website/",
      },
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Overview", slug: "index" },
            { label: "Getting started", slug: "getting-started" },
            { label: "Project status", slug: "reference/status" },
          ],
        },
        {
          label: "Language tour",
          items: [{ autogenerate: { directory: "language-tour" } }],
        },
        {
          label: "Native interop",
          items: [{ autogenerate: { directory: "interop" } }],
        },
      ],
    }),
  ],
});
