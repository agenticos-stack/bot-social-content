import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { archiveLocalState } from '@agenticos-dev/bot-testkit/local-state';

export const stateDirectory = process.env.SOCIAL_CONTENT_PREVIEW_STATE_DIRECTORY ?? fileURLToPath(new URL('../.bot-local/social-content', import.meta.url));
export async function prepareLocalState() {
  if (!process.env.SOCIAL_CONTENT_PREVIEW_STATE_DIRECTORY)
    await mkdir(new URL('../.bot-local/', import.meta.url), {recursive:true,mode:0o700});
  return stateDirectory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== '--reset') throw new Error('Use --reset to archive local preview state after stopping the preview.');
  const backup = await archiveLocalState(stateDirectory);
  console.log(`Local state archived (not deleted): ${backup}\nNext runtime start will seed a fresh workspace.`);
}
