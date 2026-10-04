import { serve } from "./serve.ts";

try {
  await serve(process.argv.slice(2));
} catch (error) {
  console.error(`error: ${(error as Error).message}`);
  process.exitCode = 1;
}
