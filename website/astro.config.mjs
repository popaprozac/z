import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import zGrammar from "../editors/vscode/syntaxes/z.tmLanguage.json" with {
  type: "json",
};

export default defineConfig({
  site: "https://docs.z-language.com",
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
            { label: "Why Z?", slug: "learn/why-z" },
            { label: "Getting started", slug: "getting-started" },
            {
              label: "Z for TypeScript developers",
              slug: "learn/z-for-typescript",
            },
          ],
        },
        {
          label: "Language guide",
          items: [{ autogenerate: { directory: "language-tour" } }],
        },
        {
          label: "Native interop",
          items: [{ autogenerate: { directory: "interop" } }],
        },
        {
          label: "Reference",
          items: [{ label: "Reference map", slug: "reference" }],
        },
        {
          label: "Project",
          items: [{ label: "Implementation status", slug: "reference/status" }],
        },
      ],
    }),
  ],
});
