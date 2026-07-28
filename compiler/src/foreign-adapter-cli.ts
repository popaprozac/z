import { writeForeignDeclarationArtifact } from "./foreign-adapter.ts";

const [sourcePath, header, outputPath, ...unexpected] = process.argv.slice(2);

if (!sourcePath || !header || !outputPath || unexpected.length > 0) {
  console.error(
    "usage: z-foreign-adapter <source.zs> <header> <output.zfdcl>",
  );
  process.exitCode = 2;
} else {
  try {
    writeForeignDeclarationArtifact(sourcePath, header, outputPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
